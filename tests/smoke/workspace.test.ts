import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const packageJsonPath = join(process.cwd(), 'package.json');
const execFileAsync = promisify(execFile);
const vsceCliPath = join(
  process.cwd(),
  'node_modules',
  '@vscode',
  'vsce',
  'vsce',
);
const vsceCommand = {
  executable: process.execPath,
  arguments: [vsceCliPath, 'ls', '--no-dependencies'],
};

describe('workspace manifest', () => {
  it('declares the VS Code workspace extension entrypoint', async () => {
    const manifest = JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as {
      engines: { vscode: string };
      extensionKind: string[];
      activationEvents: unknown[];
      main: string;
      devDependencies: Record<string, string>;
    };

    expect(manifest.engines.vscode).toBe('^1.96.0');
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(manifest.activationEvents).toEqual([]);
    expect(manifest.main).toBe('./dist/extension.cjs');
    expect(manifest.devDependencies['@types/vscode']).toBe('1.96.0');
    expect(manifest.devDependencies['@types/node']).toBe('20.19.43');
  });

  it('synchronizes the initialized settings schema', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['scripts/sync-settings.mjs'],
      { cwd: process.cwd() },
    );

    expect(stdout).toBe('synchronized 38 Git Workbench settings\n');
    expect(stderr).toBe('');

    const manifest = JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(manifest.contributes.configuration.properties)).toHaveLength(38);
  });

  it('excludes the Vitest configuration from the VSIX', async () => {
    expect(vsceCommand.executable).toBe(process.execPath);
    expect(vsceCommand.arguments).toEqual([
      vsceCliPath,
      'ls',
      '--no-dependencies',
    ]);

    const { stdout } = await execFileAsync(
      vsceCommand.executable,
      vsceCommand.arguments,
      { cwd: process.cwd() },
    );

    expect(stdout).not.toContain('vitest.config.ts');
  }, 30_000);
});
