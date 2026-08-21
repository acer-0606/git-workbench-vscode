import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, commitActions, createCliMutationProvider } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

const head = async (cwd: string): Promise<string> =>
  (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

const commitSubject = async (cwd: string, oid: string): Promise<string> =>
  (await execFileAsync('git', ['log', '-1', '--format=%s', oid], { cwd })).stdout.trim();

describe('guarded cherry-pick and revert', () => {
  let fixture: RepositoryFixture;
  let provider: ReturnType<typeof createCliMutationProvider>;
  let firstOid: string;
  let secondOid: string;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    await fixture.write('a.txt', 'one\n');
    await fixture.commitAll('first');
    await fixture.write('b.txt', 'two\n');
    await fixture.commitAll('second');
    firstOid = (await execFileAsync('git', ['rev-parse', 'HEAD~1'], { cwd: fixture.path })).stdout.trim();
    secondOid = await head(fixture.path);
    provider = createCliMutationProvider(new GitProcessRunner('git'), fixture.path);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('rejects partial OIDs, empty lists and dirty worktrees', async () => {
    await expect(commitActions.cherryPick(provider, [])).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(commitActions.cherryPick(provider, [firstOid.slice(0, 7)])).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await fixture.write('dirty.txt', 'dirty\n');
    await expect(commitActions.cherryPick(provider, [firstOid])).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: fixture.path });
    await execFileAsync('git', ['clean', '-fd'], { cwd: fixture.path });
  });

  it('reverts a commit creating a reverse commit with a new OID', async () => {
    const before = await head(fixture.path);
    const result = await commitActions.revert(provider, [secondOid]);
    expect(result.outcome).toBe('success');
    const after = await head(fixture.path);
    expect(after).not.toBe(before);
    expect(await commitSubject(fixture.path, after)).toContain('second');
  });

  it('keeps the confirmed order and pauses the journal on a mid-run conflict', async () => {
    // Build a divergence so the second pick conflicts.
    await execFileAsync('git', ['switch', '-c', 'topic'], { cwd: fixture.path });
    await fixture.write('b.txt', 'topic version\n');
    await fixture.commitAll('topic change');
    const topicTip = await head(fixture.path);
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('b.txt', 'main version\n');
    await fixture.commitAll('main change');
    const firstPick = (await execFileAsync('git', ['rev-parse', 'HEAD~2'], { cwd: fixture.path })).stdout.trim();

    const result = await commitActions.cherryPick(provider, [firstPick, topicTip]);
    expect(result.outcome).toBe('paused');
    if (result.outcome === 'paused') {
      expect(result.paused.operationKind).toBe('cherryPick');
    }
    // The sequencer state confirms the pause is real and resumable.
    const sequencer = await execFileAsync('git', ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { cwd: fixture.path }).then(() => true, () => false);
    expect(sequencer).toBe(true);
    await execFileAsync('git', ['cherry-pick', '--abort'], { cwd: fixture.path });
  });
});
