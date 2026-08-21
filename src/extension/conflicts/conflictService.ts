import * as vscode from 'vscode';

import { GitWorkbenchError, type ConflictEntry } from '@git-workbench/domain';
import { GitProcessRunner, createCliMutationProvider, readConflicts, reconstructPausedOperation, stageDeletedResolution, stageResolvedText } from '@git-workbench/git-cli';

import { MergeEditorAdapter } from './mergeEditorAdapter.js';

/**
 * Coordinates conflict detection, opening and resolution for one repository.
 * The safety rule for text resolution: a dirty editor must be saved by its
 * user — the plugin never saves for them and never stages a stale disk
 * version; the confirmed bytes are frozen at click time.
 */
export class ConflictService {
  private readonly runner = new GitProcessRunner('git');
  private readonly provider: ReturnType<typeof createCliMutationProvider>;
  private readonly mergeEditor: MergeEditorAdapter;

  constructor(private readonly cwd: string, private readonly openDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument> = (uri) => vscode.workspace.openTextDocument(uri), private readonly showDocument: (document: vscode.TextDocument) => Thenable<vscode.TextEditor> = (document) => vscode.window.showTextDocument(document)) {
    this.provider = createCliMutationProvider(this.runner, cwd);
    this.mergeEditor = new MergeEditorAdapter(openDocument, showDocument);
  }

  async detect(): Promise<{ paused: Awaited<ReturnType<typeof reconstructPausedOperation>>; conflicts: readonly ConflictEntry[] }> {
    return { paused: await reconstructPausedOperation(this.runner, this.cwd), conflicts: await readConflicts(this.runner, this.cwd) };
  }

  async openConflict(conflict: ConflictEntry, commandNames: readonly string[]): Promise<'mergeEditor' | 'workingTree'> {
    if (conflict.kind !== 'text') {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Binary/Delete-Modify/Submodule 冲突必须使用专用决策，不能进入文本编辑', repositoryChanged: false, retry: 'none' });
    }
    return this.mergeEditor.open(conflict, commandNames);
  }

  /**
   * Marks a text conflict resolved with the currently saved file content.
   * A dirty document aborts with AUTH-style guidance: the user must save
   * first, otherwise the staged bytes would silently differ from the editor.
   */
  async resolveText(path: string): Promise<string> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.cwd), path);
    const document = await this.openDocument(uri);
    if (document.isDirty) {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '文档有未保存修改，请先保存再标记解决', repositoryChanged: false, retry: 'none' });
    }
    const { readFile } = await import('node:fs/promises');
    const frozenBytes = await readFile(uri.fsPath);
    const stages = await readConflicts(this.runner, this.cwd);
    const entry = stages.find((candidate) => candidate.path === path);
    if (!entry) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '该路径已无冲突', repositoryChanged: false, retry: 'none' });
    const mode = entry.stages.find((stage) => stage.stage === 2)?.mode ?? '100644';
    return stageResolvedText(this.provider, { path, frozenBytes, mode });
  }

  async resolveDeleted(path: string): Promise<void> {
    await stageDeletedResolution(this.provider, path);
  }
}
