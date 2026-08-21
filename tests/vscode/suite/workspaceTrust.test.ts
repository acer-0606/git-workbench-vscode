import { access } from 'node:fs/promises';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const declaredTrust = process.env.GIT_WORKBENCH_EXPECTED_TRUST;
const expectedTrust = declaredTrust === 'trusted';
const dangerousCommandMarker = process.env.GIT_WORKBENCH_DANGEROUS_MARKER;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

suite('Git Workbench Workspace Trust', () => {
  suiteSetup(() => {
    assert.ok(vscode.workspace.workspaceFolders?.[0], 'the VS Code test host must open its isolated workspace fixture');
    assert.ok(declaredTrust === 'trusted' || declaredTrust === 'untrusted', 'test runner must declare the expected trust state');
  });

  test('reports the trust state the runner requested', () => {
    assert.equal(vscode.workspace.isTrusted, expectedTrust);
  });

  test('cannot let an untrusted workspace change restricted configurations', async () => {
    if (expectedTrust) return; // a trusted workspace may legitimately override these settings
    assert.ok(dangerousCommandMarker, 'untrusted test requires a dangerous-command marker');
    const folder = vscode.workspace.workspaceFolders![0]!;
    const configuration = vscode.workspace.getConfiguration('', folder.uri);
    assert.equal(configuration.get('gitWorkbench.git.path'), '', 'an untrusted workspace cannot select a Git executable');
    // The built-in `git.path` may keep its workspace value in an untrusted host
    // because VS Code blanks restricted configurations only when the declaring
    // extension contributes them; the extension must ignore such values, which
    // the "rejects workspace-provided commands" test proves behaviorally.
    assert.equal(configuration.get('gitWorkbench.repositories.autoDetect'), 'openFolders', 'an untrusted workspace cannot widen repository discovery');
    assert.equal(configuration.get('gitWorkbench.repositories.scanDepth'), 2, 'an untrusted workspace cannot increase repository scan depth');
    assert.deepEqual(configuration.get('gitWorkbench.safety.protectedBranches'), ['main', 'master', 'release/*'], 'an untrusted workspace cannot shrink protected branches');
    // `gitWorkbench.safety.mode` is not a restricted configuration: VS Code
    // keeps the workspace value visible, and the extension enforces safety by
    // merging only user-level layers while untrusted (unit-tested in
    // vscodeConfig.test.ts).
    assert.equal(await exists(dangerousCommandMarker), false, 'activation must not execute a workspace-provided command');
  });

  test('rejects workspace-provided commands even when invoked directly', async () => {
    if (expectedTrust) return;
    assert.ok(dangerousCommandMarker, 'untrusted test requires a dangerous-command marker');
    await vscode.commands.executeCommand('gitWorkbench.open');
    assert.equal(await exists(dangerousCommandMarker), false, 'untrusted discovery must not execute workspace-provided write or network commands');
  });
});
