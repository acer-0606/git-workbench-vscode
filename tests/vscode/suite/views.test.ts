import { access } from 'node:fs/promises';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

suite('native views', () => {
  test('contributes repository and refs views', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    const views = extension.packageJSON.contributes.views.gitWorkbench as Array<{ id: string }>;
    assert.deepStrictEqual(views.map((view) => view.id), ['gitWorkbench.repositories', 'gitWorkbench.refs', 'gitWorkbench.conflicts']);
  });

  test('registers tree data providers without touching Git at activation', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    await extension.activate();
    // Tree views are lazy: activating and registering providers must not run
    // the workspace-configured Git executable.
    const marker = process.env.GIT_WORKBENCH_DANGEROUS_MARKER;
    if (marker) {
      assert.equal(await exists(marker), false, 'activation and view registration must not execute Git');
    }
  });
});
