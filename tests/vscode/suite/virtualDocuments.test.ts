import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const contentScheme = 'git-workbench-content';
const execFileAsync = promisify(execFile);

suite('virtual documents', () => {
  test('serves read-only blob content through the git-workbench-content scheme', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    await extension.activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the test host must open a workspace folder');
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD:README.md'], { cwd: folder.uri.fsPath });
    const oid = stdout.trim();
    assert.match(oid, /^[0-9a-f]{40,64}$/);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${contentScheme}://${oid}/blob`));
    assert.ok(document.getText().length >= 0);
  });
});
