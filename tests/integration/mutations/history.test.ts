import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, createCliMutationProvider, history } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

const head = async (cwd: string): Promise<string> =>
  (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

describe('guarded history operations', () => {
  let fixture: RepositoryFixture;
  let bareRemote: string;
  let provider: ReturnType<typeof createCliMutationProvider>;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    await fixture.write('a.txt', 'base\n');
    await fixture.commitAll('base');
    await fixture.write('a.txt', 'second\n');
    await fixture.commitAll('second');
    bareRemote = await mkdtemp(join(tmpdir(), 'git-workbench-hist-remote-'));
    await execFileAsync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bareRemote]);
    await execFileAsync('git', ['remote', 'add', 'origin', bareRemote], { cwd: fixture.path });
    provider = createCliMutationProvider(new GitProcessRunner('git'), fixture.path);
    await history.forceWithLease(provider, { remote: 'origin', localRef: 'refs/heads/main', remoteRef: 'refs/heads/main', confirmedRemoteOid: '0'.repeat(40) }).catch(() => undefined);
    // Seed the remote with the current main via a normal push.
    const push = await provider.mutate(['push', '--', 'origin', 'refs/heads/main:refs/heads/main'], undefined, 'userInitiatedNetwork');
    expect(push.exitCode).toBe(0);
  });

  afterAll(async () => {
    await rm(bareRemote, { recursive: true, force: true }).catch(() => undefined);
    await fixture.dispose();
  });

  it('rejects a force-with-lease when the remote moved past the confirmed OID', async () => {
    // Move the local branch forward, then move the remote independently.
    await fixture.write('a.txt', 'local rewrite\n');
    await fixture.commitAll('local rewrite');
    const remoteBefore = (await execFileAsync('git', ['ls-remote', bareRemote, 'refs/heads/main'])).stdout.split('\t')[0]!.trim();

    // Remote advances behind our back (another contributor pushes).
    const other = await mkdtemp(join(tmpdir(), 'git-workbench-hist-other-'));
    await execFileAsync('git', ['clone', '--quiet', bareRemote, other]);
    await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: other });
    await execFileAsync('git', ['config', 'user.email', 'other@git-workbench.invalid'], { cwd: other });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(other, 'a.txt'), 'other contributor\n');
    await execFileAsync('git', ['commit', '--all', '--quiet', '-m', 'other contributor'], { cwd: other });
    await execFileAsync('git', ['push', '--quiet', 'origin', 'main'], { cwd: other });
    await rm(other, { recursive: true, force: true });

    await expect(history.forceWithLease(provider, {
      remote: 'origin',
      localRef: 'refs/heads/main',
      remoteRef: 'refs/heads/main',
      confirmedRemoteOid: remoteBefore,
    })).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED', message: expect.stringContaining('拒绝') } });
  });

  it('succeeds when the remote still matches the confirmed OID and records nothing silently', async () => {
    // Re-sync with the remote state first.
    await execFileAsync('git', ['reset', '--hard', 'origin/main', '--quiet'], { cwd: fixture.path });
    await fixture.write('a.txt', 'clean rewrite\n');
    await fixture.commitAll('clean rewrite');
    const confirmed = (await execFileAsync('git', ['ls-remote', bareRemote, 'refs/heads/main'])).stdout.split('\t')[0]!.trim();
    await history.forceWithLease(provider, {
      remote: 'origin',
      localRef: 'refs/heads/main',
      remoteRef: 'refs/heads/main',
      confirmedRemoteOid: confirmed,
    });
    const remoteNow = (await execFileAsync('git', ['ls-remote', bareRemote, 'refs/heads/main'])).stdout.split('\t')[0]!.trim();
    expect(remoteNow).toBe(await head(fixture.path));
  });

  it('rewords HEAD without changing parents and resets with a recovery ref', async () => {
    const before = await head(fixture.path);
    const parent = (await execFileAsync('git', ['rev-parse', 'HEAD~1'], { cwd: fixture.path })).stdout.trim();
    await history.reword(provider, 'reworded subject');
    const after = await head(fixture.path);
    expect(after).not.toBe(before);
    const parentAfter = (await execFileAsync('git', ['rev-parse', 'HEAD~1'], { cwd: fixture.path })).stdout.trim();
    expect(parentAfter).toBe(parent);
    expect((await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: fixture.path })).stdout).toContain('reworded subject');

    // hard reset records a recovery ref pointing at the previous head.
    const target = parent;
    const headBeforeReset = await head(fixture.path);
    await history.reset(provider, { oid: target, mode: 'hard', operationId: 'op-reset-1' });
    expect(await head(fixture.path)).toBe(target);
    const recovery = (await execFileAsync('git', ['rev-parse', '--verify', 'refs/git-workbench/recovery/op-reset-1/head'], { cwd: fixture.path })).stdout.trim();
    expect(recovery).toBe(headBeforeReset);
  });

  it('enumerates exactly the commits a rewrite would republish', async () => {
    await fixture.write('a.txt', 'after reset\n');
    await fixture.commitAll('after reset');
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD~1'], { cwd: fixture.path })).stdout.trim();
    const tip = await head(fixture.path);
    const commits = await history.commitsBetween(provider, base, tip);
    expect(commits.map((commit) => commit.oid)).toEqual([tip]);
  });
});
