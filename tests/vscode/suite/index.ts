import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Mocha from 'mocha';

function collectTestFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files.sort();
}

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 30_000,
    ...(process.env.GIT_WORKBENCH_TEST_GREP ? { grep: process.env.GIT_WORKBENCH_TEST_GREP } : {}),
  });
  const root = resolve(__dirname);
  for (const file of collectTestFiles(root)) mocha.addFile(file);
  await new Promise<void>((resolveRun, reject) => mocha.run((failures) => failures ? reject(new Error(`${failures} VS Code tests failed`)) : resolveRun()));
}
