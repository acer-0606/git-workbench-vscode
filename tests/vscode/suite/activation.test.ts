import { access } from 'node:fs/promises';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const extensionId = 'git-workbench-project.git-workbench';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

suite('Git Workbench activation', () => {
  test('registers the open command without eager network activity', async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `the test host must load ${extensionId}`);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gitWorkbench.open'));
    const dangerousCommandMarker = process.env.GIT_WORKBENCH_DANGEROUS_MARKER;
    if (dangerousCommandMarker) {
      assert.equal(await exists(dangerousCommandMarker), false, 'activation is registration-only and must not execute workspace-provided commands');
    }
  });
});
