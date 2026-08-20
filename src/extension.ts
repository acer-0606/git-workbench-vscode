import type { ExtensionContext } from 'vscode';

import { activateExtension } from './extension/activate.js';

export async function activate(context: ExtensionContext): Promise<void> {
  await activateExtension(context);
}

export function deactivate(): void {}
