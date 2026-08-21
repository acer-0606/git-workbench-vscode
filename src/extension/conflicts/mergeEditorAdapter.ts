import * as vscode from 'vscode';

import type { ConflictEntry } from '@git-workbench/domain';

export const conflictContentScheme = 'git-workbench-conflict';

/**
 * Opens a text conflict in VS Code's native three-way merge editor when the
 * `git.openMergeEditor` command exists, and degrades to opening the working
 * tree file otherwise. The merge editor is an optional accelerator, never a
 * core dependency: its failure is captured and reported, not fatal.
 */
export class MergeEditorAdapter {
  constructor(private readonly openTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument> = (uri) => vscode.workspace.openTextDocument(uri), private readonly showTextDocument: (document: vscode.TextDocument) => Thenable<vscode.TextEditor> = (document) => vscode.window.showTextDocument(document)) {}

  async open(conflict: ConflictEntry, commandNames: readonly string[]): Promise<'mergeEditor' | 'workingTree'> {
    if (commandNames.includes('git.openMergeEditor')) {
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(conflict.path));
        return 'mergeEditor';
      } catch {
        // Fall through to the plain working-tree editor.
      }
    }
    const document = await this.openTextDocument(vscode.Uri.file(conflict.path));
    await this.showTextDocument(document);
    return 'workingTree';
  }
}

/**
 * Provides read-only base/current/incoming contents for the degraded
 * three-way view: `git-workbench-conflict://<stage>/<path>`.
 */
export function createConflictContentProvider(readBlob: (stage: 1 | 2 | 3, path: string) => Thenable<string>): vscode.TextDocumentContentProvider {
  return {
    provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
      const stage = Number(uri.authority);
      if (stage !== 1 && stage !== 2 && stage !== 3) return Promise.reject(new Error('invalid conflict stage'));
      const path = uri.path.replace(/^\//, '');
      if (!path) return Promise.reject(new Error('missing conflict path'));
      return readBlob(stage, path);
    },
  };
}

export function registerConflictContentProvider(context: vscode.ExtensionContext, readBlob: (stage: 1 | 2 | 3, path: string) => Thenable<string>): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(conflictContentScheme, createConflictContentProvider(readBlob));
}
