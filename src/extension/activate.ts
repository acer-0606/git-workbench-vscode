import * as vscode from 'vscode';
import { GitProcessRunner, locateRepository } from '@git-workbench/git-cli';

import { discoverRepositories, WorkspaceFolderDiscoveryScheduler } from './repositoryDiscovery.js';
import { RepositoryRegistry } from './repositoryRegistry.js';
import { createVscodeConfigSnapshot } from './vscodeConfig.js';

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
}
