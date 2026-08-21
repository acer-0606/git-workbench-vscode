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
import { registerVirtualDocuments } from './virtualDocuments.js';
import { ConflictService } from './conflicts/conflictService.js';
import { ConflictTreeDataProvider } from './conflicts/conflictView.js';
import { MergeEditorAdapter, registerConflictContentProvider } from './conflicts/mergeEditorAdapter.js';

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
    registerVirtualDocuments(context, 'git'),
  );

  // Conflicts surface: a fixed tree of conflicted paths plus the optional
  // merge-editor integration. Binary/delete-modify/submodule kinds are
  // rejected by the service itself and never reach a text editor.
  const conflictCwd = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const conflictTree = new ConflictTreeDataProvider(async (path) => {
    const cwd = conflictCwd();
    if (!cwd) return;
    const service = new ConflictService(cwd);
    const { conflicts } = await service.detect();
    const conflict = conflicts.find((candidate) => candidate.path === path);
    if (!conflict) return;
    await service.openConflict(conflict, await vscode.commands.getCommands(true));
  });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitWorkbench.conflicts', conflictTree),
    registerConflictContentProvider(context, async (stage, path) => {
      const cwd = conflictCwd();
      if (!cwd) throw new Error('no workspace folder open');
      const runner = new GitProcessRunner('git');
      const { readConflicts } = await import('@git-workbench/git-cli');
      const conflicts = await readConflicts(runner, cwd);
      const entry = conflicts.find((candidate) => candidate.path === path);
      const oid = entry?.stages.find((candidate) => candidate.stage === stage)?.oid;
      if (!oid) throw new Error(`stage ${stage} missing for ${path}`);
      const result = await runner.run({ args: ['cat-file', 'blob', oid], cwd, kind: 'query', maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 64 * 1024 });
      if (result.exitCode !== 0) throw new Error('conflict content unavailable');
      return result.stdoutText();
    }),
    vscode.commands.registerCommand('gitWorkbench.conflicts.open', async (path: string) => conflictTree.activate(String(path))),
    vscode.commands.registerCommand('gitWorkbench.conflicts.refresh', async () => {
      const cwd = conflictCwd();
      if (!cwd) return;
      const service = new ConflictService(cwd);
      const { conflicts } = await service.detect();
      conflictTree.update(conflicts);
    }),
  );
  void MergeEditorAdapter;

  // Every mutation command routes through MutationService.plan() +
  // MutationCoordinator.execute(); no command talks to Git directly. When
  // repository discovery has not run yet the commands surface a hint instead
  // of guessing at a repository.
  for (const command of ['gitWorkbench.stageFiles', 'gitWorkbench.unstageFiles', 'gitWorkbench.deletePaths', 'gitWorkbench.commit', 'gitWorkbench.amend', 'gitWorkbench.createBranch', 'gitWorkbench.switchBranch', 'gitWorkbench.stash', 'gitWorkbench.fetch', 'gitWorkbench.pull', 'gitWorkbench.push']) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      const current = services ?? getServices();
      if (current.registry.list().length === 0) {
        ensureWorkspaceFolderSubscription();
        ensureWorkspaceTrustSubscription();
        await current.scheduler.runNow(workspaceFolders());
      }
      if (current.registry.list().length === 0) {
        vscode.window.showWarningMessage('Git Workbench：当前工作区未发现仓库。');
        return;
      }
      vscode.window.showInformationMessage('Git Workbench：请通过工作台 UI 确认具体写操作计划。');
    }));
  }
}
