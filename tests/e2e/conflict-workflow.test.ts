import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';

const execFileAsync = promisify(execFile);

interface PausedSnapshot {
  readonly kind: string;
  readonly conflictedPaths: readonly string[];
  readonly conflictKinds: readonly string[];
  readonly headOid: string;
}

/**
 * Samples the complete paused state purely from Git's on-disk facts. A plugin
 * restart must observe exactly this — the E2E contract is that no part of
 * the paused state lives in extension memory.
 */
async function samplePausedState(cwd: string): Promise<PausedSnapshot> {
  const { GitProcessRunner, readConflicts, reconstructPausedOperation } = await import('@git-workbench/git-cli');
  const runner = new GitProcessRunner('git');
  const paused = await reconstructPausedOperation(runner, cwd);
  const conflicts = await readConflicts(runner, cwd);
  const headOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  return {
    kind: paused?.kind ?? 'none',
    conflictedPaths: conflicts.map((conflict) => conflict.path),
    conflictKinds: conflicts.map((conflict) => conflict.kind),
    headOid,
  };
}

async function diverge(fixture: RepositoryFixture, content: string): Promise<void> {
  await execFileAsync('git', ['switch', '-c', 'topic'], { cwd: fixture.path });
  await fixture.write('shared.txt', `${content}\n`);
  await fixture.commitAll(`topic ${content}`);
  await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
  await fixture.write('shared.txt', `main ${content}\n`);
  await fixture.commitAll(`main ${content}`);
}

describe('paused operation restart E2E', () => {
  it.each([
    ['merge', async (fixture: RepositoryFixture) => {
      const provider = await import('@git-workbench/git-cli').then((m) => m.createCliMutationProvider(new m.GitProcessRunner('git'), fixture.path));
      await provider.mutate(['merge', '--no-edit', 'topic']).catch(() => undefined);
    }],
    ['rebase', async (fixture: RepositoryFixture) => {
      const provider = await import('@git-workbench/git-cli').then((m) => m.createCliMutationProvider(new m.GitProcessRunner('git'), fixture.path));
      await provider.mutate(['rebase', 'topic']).catch(() => undefined);
    }],
    ['cherryPick', async (fixture: RepositoryFixture) => {
      const provider = await import('@git-workbench/git-cli').then((m) => m.createCliMutationProvider(new m.GitProcessRunner('git'), fixture.path));
      const oid = (await execFileAsync('git', ['rev-parse', 'topic'], { cwd: fixture.path })).stdout.trim();
      await provider.mutate(['cherry-pick', '--', oid]).catch(() => undefined);
    }],
    ['revert', async (fixture: RepositoryFixture) => {
      const provider = await import('@git-workbench/git-cli').then((m) => m.createCliMutationProvider(new m.GitProcessRunner('git'), fixture.path));
      const oid = (await execFileAsync('git', ['rev-parse', 'topic'], { cwd: fixture.path })).stdout.trim();
      await provider.mutate(['revert', '--no-edit', '--', oid]).catch(() => undefined);
    }],
    ['pullMerge', async (fixture: RepositoryFixture) => {
      // Simulate the confirmed-OID pull integration colliding with a local change.
      const provider = await import('@git-workbench/git-cli').then((m) => m.createCliMutationProvider(new m.GitProcessRunner('git'), fixture.path));
      const oid = (await execFileAsync('git', ['rev-parse', 'topic'], { cwd: fixture.path })).stdout.trim();
      await provider.mutate(['merge', '--no-edit', oid]).catch(() => undefined);
    }],
  ])('%s state survives a full restart sampling cycle', async (kind, start) => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('shared.txt', 'base\n');
      await fixture.commitAll('base');
      await diverge(fixture, kind);
      const headBefore = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
      await start(fixture);

      // First sampling (the "before restart" view).
      const before = await samplePausedState(fixture.path);
      expect(before.kind).toBe(kind === 'pullMerge' ? 'merge' : kind);
      expect(before.conflictedPaths).toContain('shared.txt');
      expect(before.conflictKinds).toContain('text');

      // "Restart": a fresh node process samples the same repository. The
      // state is reconstructed from disk, so the two samples must match.
      const samplerPath = new URL('./restart-sampler.mjs', import.meta.url).pathname;
      const { execFile: childExec } = await import('node:child_process');
      const { promisify: childPromisify } = await import('node:util');
      const runSampler = childPromisify(childExec);
      const samplerOutput = await runSampler(process.execPath, [samplerPath, fixture.path]);
      const restart = JSON.parse(samplerOutput.stdout.trim().split('\n').at(-1)!) as PausedSnapshot;
      expect(restart).toEqual(before);

      // Abort from the restarted state and verify recovery to the pre-op HEAD.
      const { createCliMutationProvider, GitProcessRunner, sequencer } = await import('@git-workbench/git-cli');
      const provider = createCliMutationProvider(new GitProcessRunner('git'), fixture.path);
      await sequencer.run(provider, restart.kind, 'abort');
      const after = await samplePausedState(fixture.path);
      expect(after.kind).toBe('none');
      expect(after.conflictedPaths).toEqual([]);
      expect(after.headOid).toBe(headBefore);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it('stash apply conflicts stay inspectable across restart sampling and keep the stash', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('shared.txt', 'base\n');
      await fixture.commitAll('base');
      await fixture.write('shared.txt', 'stashed\n');
      await execFileAsync('git', ['stash', 'push', '-m', 'wip'], { cwd: fixture.path });
      await fixture.write('shared.txt', 'branch moved\n');
      await fixture.commitAll('branch moves');
      const provider = await import('@git-workbench/git-cli').then((m) => m.createCliMutationProvider(new m.GitProcessRunner('git'), fixture.path));
      await provider.mutate(['stash', 'apply', 'stash@{0}']).catch(() => undefined);

      const before = await samplePausedState(fixture.path);
      // Stash conflicts carry no sequencer marker: the conflict stages and
      // the preserved stash ARE the restart-stable state.
      expect(before.conflictedPaths).toContain('shared.txt');
      const stashList = (await execFileAsync('git', ['stash', 'list', '--format=%H'], { cwd: fixture.path })).stdout.trim();
      expect(stashList).not.toBe('');

      const after = await samplePausedState(fixture.path);
      expect(after).toEqual(before);
      void writeFile;
      void join;
    } finally {
      await fixture.dispose();
    }
  });
});
