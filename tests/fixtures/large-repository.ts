import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { GitProcessRunner, readLogPage } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

const gitEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
} as const;

/**
 * Deterministically builds a commit chain of `count` commits using plumbing
 * (commit-tree) so large fixtures stay fast, then writes a commit-graph.
 */
export async function buildLargeRepository(count: number): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `git-workbench-perf-${count}-`));
  const run = (args: string[]): Promise<{ stdout: string }> => execFileAsync('git', args, { cwd: path, env: { ...process.env, ...gitEnv } });
  await run(['init', '--quiet', '--initial-branch=main']);
  await run(['config', '--local', 'user.name', 'Git Workbench Perf']);
  await run(['config', '--local', 'user.email', 'perf@git-workbench.invalid']);
  await writeFile(join(path, 'bulk.txt'), 'seed\n');
  await run(['add', 'bulk.txt']);
  let parent: string | undefined;
  for (let index = 0; index < count; index += 1) {
    const tree = (await run(['write-tree'])).stdout.trim();
    const args = ['commit-tree', tree, '-m', `perf commit ${index}`];
    if (parent) args.push('-p', parent);
    parent = (await run(args)).stdout.trim();
  }
  await run(['update-ref', 'refs/heads/main', parent!]);
  await run(['commit-graph', 'write', '--reachable']);
  return path;
}

export async function openPreparedRepository(path: string | undefined, smokeCount = 2_000): Promise<{ logPage: (input: { limit: number }) => Promise<{ rows: unknown[] }>; dispose: () => Promise<void> }> {
  const repositoryPath = path ?? await buildLargeRepository(smokeCount);
  const runner = new GitProcessRunner('git');
  return {
    logPage: async ({ limit }) => {
      const page = await readLogPage(runner, repositoryPath, 1, 'topo', limit);
      return { rows: page.rows };
    },
    dispose: async () => {
      await rm(repositoryPath, { recursive: true, force: true });
    },
  };
}
