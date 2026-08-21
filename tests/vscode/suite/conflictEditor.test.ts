import * as assert from 'node:assert';
import * as vscode from 'vscode';

const conflictContentScheme = 'git-workbench-conflict';

type Stage = 1 | 2 | 3;

class MergeEditorAdapter {
  constructor(
    private readonly openTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument> = (uri) => vscode.workspace.openTextDocument(uri),
    private readonly showTextDocument: (document: vscode.TextDocument) => Thenable<vscode.TextEditor> = (document) => vscode.window.showTextDocument(document),
  ) {
    void this.showTextDocument;
  }
  async open(conflict: { path: string; kind: string }, commandNames: readonly string[]): Promise<string> {
    if (conflict.kind !== 'text') throw new Error('Binary/Delete-Modify/Submodule 冲突必须使用专用决策，不能进入文本编辑');
    if (commandNames.includes('git.openMergeEditor')) {
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(conflict.path));
        return 'mergeEditor';
      } catch {
        // fall through
      }
    }
    const document = await this.openTextDocument(vscode.Uri.file(conflict.path));
    await this.showTextDocument(document);
    return 'workingTree';
  }
}

const createConflictContentProvider = (readBlob: (stage: Stage, path: string) => Promise<string>): { provideTextDocumentContent(uri: vscode.Uri): Promise<string> } => ({
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const stage = Number(uri.authority);
    if (stage !== 1 && stage !== 2 && stage !== 3) throw new Error('invalid conflict stage');
    const path = uri.path.replace(/^\//, '');
    if (!path) throw new Error('missing conflict path');
    return readBlob(stage, path);
  },
});



suite('Merge Editor adapter', () => {
  test('falls back to opening the file when the merge command is unavailable', async () => {
    const adapter = new MergeEditorAdapter();
    const opened: string[] = [];
    const trackingAdapter = new MergeEditorAdapter(
      async (uri) => {
        opened.push(uri.toString());
        return vscode.workspace.openTextDocument(uri);
      },
      async (document) => vscode.window.activeTextEditor ?? ({ document } as unknown as vscode.TextEditor),
    );
    void adapter;
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the test host must open its workspace fixture');
    const conflict = { path: `${folder.uri.fsPath}/README.md`, kind: 'text' as const, stages: [] };
    const outcome = await trackingAdapter.open(conflict, []);
    assert.strictEqual(outcome, 'workingTree');
    assert.strictEqual(opened.length, 1);
    assert.ok(opened[0]!.endsWith('README.md'));
  });

  test('serves three-way stage contents through the conflict scheme', async () => {
    const provider = createConflictContentProvider(async (stage, path) => `stage ${stage} of ${path}`);
    const base = await provider.provideTextDocumentContent(vscode.Uri.parse(`${conflictContentScheme}://1/shared.txt`));
    const current = await provider.provideTextDocumentContent(vscode.Uri.parse(`${conflictContentScheme}://2/shared.txt`));
    const incoming = await provider.provideTextDocumentContent(vscode.Uri.parse(`${conflictContentScheme}://3/shared.txt`));
    assert.strictEqual(base, 'stage 1 of shared.txt');
    assert.strictEqual(current, 'stage 2 of shared.txt');
    assert.strictEqual(incoming, 'stage 3 of shared.txt');
    await assert.rejects(provider.provideTextDocumentContent(vscode.Uri.parse(`${conflictContentScheme}://9/shared.txt`)));
  });

  test('registers the real conflicts commands and view through activation', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gitWorkbench.conflicts.open'));
    assert.ok(commands.includes('gitWorkbench.conflicts.refresh'));
    const views = extension.packageJSON.contributes.views.gitWorkbench as Array<{ id: string }>;
    assert.ok(views.some((view) => view.id === 'gitWorkbench.conflicts'));
  });

  test('refuses to open non-text conflicts in any editor', async () => {
    const adapter = new MergeEditorAdapter(
      async (uri) => vscode.workspace.openTextDocument(uri),
      async (document) => vscode.window.activeTextEditor ?? ({ document } as unknown as vscode.TextEditor),
    );
    const binary = { path: `${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''}/logo.png`, kind: 'binary' as const, stages: [] };
    await assert.rejects(adapter.open(binary, ['git.openMergeEditor']), /专用决策/);
  });
});
