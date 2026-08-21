import * as vscode from 'vscode';
import { GitProcessRunner, locateRepository, parseStatusV2, readLogPage, readRefs, readWorktrees } from '@git-workbench/git-cli';

import { discoverRepositories, WorkspaceFolderDiscoveryScheduler } from './repositoryDiscovery.js';
import { RepositoryRegistry } from './repositoryRegistry.js';
import { createVscodeConfigSnapshot } from './vscodeConfig.js';
import { GenerationCache } from './query/generationCache.js';
import { QueryScheduler } from './query/queryScheduler.js';
import { ReadModelService } from './query/readModelService.js';
import { RepositoriesTreeDataProvider } from './views/repositoriesView.js';
import { RefsTreeDataProvider } from './views/refsView.js';

interface LazyServices {
  readonly registry: RepositoryRegistry;
  readonly output: vscode.OutputChannel;
  readonly scheduler: WorkspaceFolderDiscoveryScheduler<vscode.WorkspaceFolder>;
}

/** Activation is registration-only: nothing touches disk or starts Git until the command runs. */
export async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  let services: LazyServices | undefined;
  let workspaceFolderSubscription: vscode.Disposable | undefined;
  let workspaceTrustSubscription: vscode.Disposable | undefined;
  const workspaceFolders = (): readonly vscode.WorkspaceFolder[] => vscode.workspace.workspaceFolders ?? [];
  const refresh = async (
    current: LazyServices,
    folders: readonly vscode.WorkspaceFolder[],
    signal: AbortSignal,
  ): Promise<void> => {
    // A folder URI is deliberately retained here: resource-scoped settings
    // (including safety layers) must never be read through an unscoped view.
    const results = await Promise.all(folders.map(async (folder) => {
      const configuration = createVscodeConfigSnapshot(vscode.workspace.isTrusted, vscode.workspace, folder.uri);
      const runner = new GitProcessRunner(configuration.gitPath);
      return discoverRepositories([folder.uri.fsPath], (path) => locateRepository(runner, path, {
      trusted: vscode.workspace.isTrusted,
      signal,
      }), {
        mode: configuration.autoDetect,
        scanDepth: configuration.scanDepth,
        signal,
      });
    }));
    // An old scan may finish after an event has scheduled a newer generation.
    // Never let it overwrite the registry with stale repository descriptors.
    if (signal.aborted) return;
    const repositories = new Map<string, (typeof results)[number]['repositories'][number]>();
    for (const result of results) for (const repository of result.repositories) repositories.set(repository.id, repository);
    current.registry.replace([...repositories.values()]);
    if (results.some((result) => result.partial)) current.output.appendLine('Repository discovery is partial; narrow the workspace scope or add repositories manually.');
  };
  const getServices = (): LazyServices => {
    if (services !== undefined) return services;
    const registry = new RepositoryRegistry();
    const output = vscode.window.createOutputChannel('Git Workbench');
    services = {
      registry,
      output,
      scheduler: new WorkspaceFolderDiscoveryScheduler(async (folders, signal) => refresh(services!, folders, signal)),
    };
    context.subscriptions.push(output, services.scheduler);
    return services;
  };

  const ensureWorkspaceFolderSubscription = (): void => {
    if (workspaceFolderSubscription !== undefined) return;
    workspaceFolderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      services?.scheduler.update(workspaceFolders());
    });
    context.subscriptions.push(workspaceFolderSubscription);
  };

  const ensureWorkspaceTrustSubscription = (): void => {
    if (workspaceTrustSubscription !== undefined) return;
    workspaceTrustSubscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      // Capability probing changes when trust is granted; rebuild descriptors
      // rather than retaining compatibility-mode results from the old trust.
      services?.scheduler.update(workspaceFolders());
    });
    context.subscriptions.push(workspaceTrustSubscription);
  };

  context.subscriptions.push(vscode.commands.registerCommand('gitWorkbench.open', async () => {
    const current = getServices();
    ensureWorkspaceFolderSubscription();
    ensureWorkspaceTrustSubscription();
    await current.scheduler.runNow(workspaceFolders());
    current.output.appendLine(`Git Workbench ready (${current.registry.list().length} repositories)`);
    current.output.show(true);
  }));

  // Views stay inert until VS Code makes them visible; the read service only
  // reaches Git when a view or the workbench actually asks for data.
  const readModel = (): ReadModelService => {
    if (readModelService !== undefined) return readModelService;
    const registry = services?.registry ?? getServices().registry;
    readModelService = new ReadModelService(
      registry,
      new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 }),
      new GenerationCache(64 * 1024 * 1024),
      {
        status: async (repositoryId, generation, signal) => {
          const descriptor = registry.list().find((entry) => entry.id === repositoryId);
          if (!descriptor) throw new Error('repository not registered');
          const runner = new GitProcessRunner('git');
          const result = await runner.run({ args: ['status', '--porcelain=v2', '-z', '--branch'], cwd: descriptor.worktreeUri, kind: 'query', maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 64 * 1024, signal });
          if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderrText()}`);
          return parseStatusV2(result.stdout, generation);
        },
        refs: async (repositoryId, generation, signal) => {
          const descriptor = registry.list().find((entry) => entry.id === repositoryId);
          if (!descriptor) throw new Error('repository not registered');
          const runner = new GitProcessRunner('git');
          const [refs, worktrees] = await Promise.all([
            readRefs(runner, descriptor.worktreeUri),
            readWorktrees(runner, descriptor.worktreeUri),
          ]);
          void signal;
          void generation;
          return {
            branches: refs.filter((ref) => ref.kind === 'branch').map((ref) => ({ name: ref.displayName, isHead: ref.isHead === true })),
            tags: refs.filter((ref) => ref.kind === 'tag').map((ref) => ({ name: ref.displayName })),
            stashes: [],
            worktrees: worktrees.map((worktree) => ({ path: worktree.path })),
          };
        },
        logPage: async (repositoryId, generation, input, signal) => {
          const descriptor = registry.list().find((entry) => entry.id === repositoryId);
          if (!descriptor) throw new Error('repository not registered');
          const request = input as { readonly order: 'topo' | 'date' | 'authorDate'; readonly limit: number; readonly cursor?: string };
          const runner = new GitProcessRunner('git');
          void signal;
          return readLogPage(runner, descriptor.worktreeUri, generation, request.order, request.limit, request.cursor);
        },
      },
    );
    return readModelService;
  };
  let readModelService: ReadModelService | undefined;

  const repositoriesView = new RepositoriesTreeDataProvider(() => readModel().repositories());
  const refsView = new RefsTreeDataProvider(async () => {
    const service = readModel();
    const first = service.repositories()[0];
    if (!first) return { branches: [], tags: [], stashes: [], worktrees: [] };
    const snapshot = await service.refs(first.id, 1, `refs-${Date.now()}`) as { branches: { name: string; isHead: boolean }[]; tags: { name: string }[]; stashes: { subject: string }[]; worktrees: { path: string }[] };
    return { branches: snapshot.branches, tags: snapshot.tags, stashes: snapshot.stashes, worktrees: snapshot.worktrees };
  });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitWorkbench.repositories', repositoriesView),
    vscode.window.registerTreeDataProvider('gitWorkbench.refs', refsView),
  );
}
