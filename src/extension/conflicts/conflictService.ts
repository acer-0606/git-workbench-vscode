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
export interface ConflictServiceOptions {
  /** Git executable resolved through the trusted settings snapshot; the extension host PATH may not contain a bare `git`. */
  readonly gitPath?: string;
  readonly openDocument?: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;
  readonly showDocument?: (document: vscode.TextDocument) => Thenable<vscode.TextEditor>;
}

export class ConflictService {
  private readonly runner: GitProcessRunner;
  private readonly provider: ReturnType<typeof createCliMutationProvider>;
  private readonly mergeEditor: MergeEditorAdapter;
  private readonly openDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;

  constructor(private readonly cwd: string, options: ConflictServiceOptions = {}) {
    this.runner = new GitProcessRunner(options.gitPath ?? 'git');
    this.provider = createCliMutationProvider(this.runner, cwd);
    this.openDocument = options.openDocument ?? ((uri) => vscode.workspace.openTextDocument(uri));
    this.mergeEditor = new MergeEditorAdapter(
      this.openDocument,
      options.showDocument ?? ((document) => vscode.window.showTextDocument(document)),
    );
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
