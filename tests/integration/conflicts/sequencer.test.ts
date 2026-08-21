import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, createCliMutationProvider, readConflicts, reconstructPausedOperation, sequencer } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

describe('paused operation reconstruction and resolution', () => {
  let fixture: RepositoryFixture;
  let runner: GitProcessRunner;
  let provider: ReturnType<typeof createCliMutationProvider>;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    runner = new GitProcessRunner('git');
    provider = createCliMutationProvider(runner, fixture.path);
    // Diverge main and topic so a merge conflicts.
    await fixture.write('shared.txt', 'base\n');
    await fixture.commitAll('base');
    await execFileAsync('git', ['switch', '-c', 'topic'], { cwd: fixture.path });
    await fixture.write('shared.txt', 'topic version\n');
    await fixture.commitAll('topic change');
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('shared.txt', 'main version\n');
    await fixture.commitAll('main change');
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('reports no paused operation on a clean repository', async () => {
    expect(await reconstructPausedOperation(runner, fixture.path)).toBeUndefined();
    expect(await readConflicts(runner, fixture.path)).toEqual([]);
  });

  it('classifies a merge conflict from real index stages and keeps the operation paused', async () => {
    // The merge conflicts; the exact non-zero exit code is not the contract.
    await provider.mutate(['merge', '--no-edit', 'topic']).catch(() => undefined);

    const paused = await reconstructPausedOperation(runner, fixture.path);
    expect(paused?.kind).toBe('merge');

    const conflicts = await readConflicts(runner, fixture.path);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: 'shared.txt', kind: 'text' });
    expect(conflicts[0]?.stages.map((stage) => stage.stage).sort()).toEqual([1, 2, 3]);

    // Continuing while still conflicted must stay paused, not fail blindly.
    await expect(sequencer.run(provider, 'merge', 'continue')).rejects.toMatchObject({ payload: { code: 'CONFLICT_PAUSED' } });
  });

  it('marks the file resolved, continues the merge and clears the paused state', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${fixture.path}/shared.txt`, 'resolved content\n');
    await sequencer.markResolved(provider, 'shared.txt');
    await sequencer.run(provider, 'merge', 'continue');
    expect(await reconstructPausedOperation(runner, fixture.path)).toBeUndefined();
    expect(await readConflicts(runner, fixture.path)).toEqual([]);
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: fixture.path });
    expect(stdout).toContain("Merge branch 'topic'");
  });

  it('abort returns the worktree to the pre-merge HEAD', async () => {
    // Diverge two branches from the same base so the merge truly conflicts.
    await execFileAsync('git', ['switch', '-c', 'conflict-branch', '--quiet'], { cwd: fixture.path });
    await fixture.write('shared.txt', 'branch a\n');
    await fixture.commitAll('branch a change');
    await execFileAsync('git', ['switch', 'main', '--quiet'], { cwd: fixture.path });
    await execFileAsync('git', ['switch', '-c', 'other-branch', '--quiet'], { cwd: fixture.path });
    await fixture.write('shared.txt', 'branch b\n');
    await fixture.commitAll('branch b change');
    const headBefore = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
    await provider.mutate(['merge', '--no-edit', 'conflict-branch']).catch(() => undefined);
    expect((await reconstructPausedOperation(runner, fixture.path))?.kind).toBe('merge');
    await sequencer.run(provider, 'merge', 'abort');
    const headAfter = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
    expect(headAfter).toBe(headBefore);
    expect(await readConflicts(runner, fixture.path)).toEqual([]);
  });

  it('refuses stash-apply sequencer commands and unsupported skip actions', async () => {
    await expect(sequencer.run(provider, 'stashApply', 'continue')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(sequencer.run(provider, 'merge', 'skip')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(sequencer.markResolved(provider, '../escape')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });
});
