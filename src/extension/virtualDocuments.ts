import * as vscode from 'vscode';
import { GitProcessRunner } from '@git-workbench/git-cli';

/**
 * Read-only `git-workbench-content:` documents backed by object ids. The
 * provider only ever reads blobs from the resolved object id in the URI
 * authority; it never resolves arbitrary revisions from webview input.
 */
export const contentScheme = 'git-workbench-content';

export function createContentProvider(gitPath: string): vscode.TextDocumentContentProvider {
  const runner = new GitProcessRunner(gitPath);
  return {
    provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
      const oid = uri.authority;
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return Promise.reject(new Error('invalid content object id'));
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) return Promise.reject(new Error('no workspace folder open'));
      return runner.run({ args: ['cat-file', 'blob', oid], cwd, kind: 'query', maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 64 * 1024 })
        .then((result) => {
          if (result.exitCode !== 0) throw new Error(`content unavailable for ${oid}`);
          return result.stdoutText();
        });
    },
  };
}

export function registerVirtualDocuments(context: vscode.ExtensionContext, gitPath: string): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(contentScheme, createContentProvider(gitPath));
}
