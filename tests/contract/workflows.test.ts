import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Foundation delivery workflow', () => {
  it('runs the complete verification pipeline on the three supported platforms', async () => {
    const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('ubuntu-latest');
    expect(workflow).toContain('macos-latest');
    expect(workflow).toContain('windows-latest');
    expect(workflow).toMatch(/node-version:\s*24/);
    expect(workflow).toMatch(/npm run sync:settings/);
    expect(workflow).toMatch(/git diff --exit-code/);
    expect(workflow).toMatch(/npm run check/);
    expect(workflow).toMatch(/npm run test:integration/);
    expect(workflow).toMatch(/npm run build/);
    expect(workflow).toMatch(/npm run test:vscode/);
    expect(workflow).toMatch(/npm run package/);
    expect(workflow).toMatch(/xvfb-run/);
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}\s+# v4\.2\.2/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}\s+# v4\.4\.0/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}\s+# v4\.6\.2/);
    expect(workflow).not.toMatch(/uses:\s*[^\n@]+@(main|master|v\d+(?:\.\d+){0,2})\b/i);
  });

  it('keeps test material and local state out of the packaged VSIX', async () => {
    const [ignore, manifest, vscodeRunner] = await Promise.all([
      readFile(join(root, '.vscodeignore'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8').then(JSON.parse) as Promise<{
        license: string;
        private: boolean;
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
      }>,
      readFile(join(root, 'tests/vscode/run.ts'), 'utf8'),
    ]);

    for (const excluded of ['.git/**', 'tests/**', '.env*', 'coverage/**', '*.vsix']) {
      expect(ignore).toContain(excluded);
    }
    expect(manifest.license).toBe('UNLICENSED');
    expect(manifest.private).toBe(true);
    expect(manifest.devDependencies['@vscode/test-electron']).toBeDefined();
    expect(manifest.scripts['test:vscode']).toContain('tests/vscode/out/run.js');
    expect(vscodeRunner).toContain("from '@vscode/test-electron'");
  });
});
