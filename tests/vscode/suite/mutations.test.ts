import * as assert from 'node:assert';
import * as vscode from 'vscode';

const mutationCommands = [
  'gitWorkbench.stageFiles',
  'gitWorkbench.unstageFiles',
  'gitWorkbench.deletePaths',
  'gitWorkbench.commit',
  'gitWorkbench.amend',
  'gitWorkbench.createBranch',
  'gitWorkbench.switchBranch',
  'gitWorkbench.stash',
  'gitWorkbench.fetch',
  'gitWorkbench.pull',
  'gitWorkbench.push',
];

suite('mutation command surface', () => {
  test('contributes exactly the guarded mutation commands with NLS titles', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    const commands = extension.packageJSON.contributes.commands as Array<{ command: string; title: string }>;
    const ids = commands.map((command) => command.command);
    for (const id of mutationCommands) {
      assert.ok(ids.includes(id), `${id} must be contributed`);
    }
    // No unguarded escape hatches ship in Phase 2.
    for (const forbidden of ['reset', 'rebase', 'forcePush', 'applyPatch']) {
      assert.ok(!ids.some((id) => id.toLowerCase().includes(forbidden.toLowerCase())), `${forbidden} must not be registered`);
    }
  });

  test('registers the mutation commands in the host', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    await extension.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const id of mutationCommands) {
      assert.ok(registered.includes(id), `${id} must be registered`);
    }
  });
});
