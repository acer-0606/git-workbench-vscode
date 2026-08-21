import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, createCliMutationProvider, parseLsRemote, remote } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

describe('reconciled Git remote operations', () => {
  let fixture: RepositoryFixture;
  let bareRemote: string;
  let provider: ReturnType<typeof createCliMutationProvider>;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    await fixture.write('a.txt', 'base\n');
    await fixture.commitAll('base');
    bareRemote = await mkdtemp(join(tmpdir(), 'git-workbench-bare-'));
    await execFileAsync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bareRemote]);
    await execFileAsync('git', ['remote', 'add', 'origin', bareRemote], { cwd: fixture.path });
    provider = createCliMutationProvider(new GitProcessRunner('git'), fixture.path);
  });

  afterAll(async () => {
    await rm(bareRemote, { recursive: true, force: true }).catch(() => undefined);
    await fixture.dispose();
  });

  it('pushes the confirmed local OID and rejects malformed refs', async () => {
    await expect(remote.push(provider, { remote: 'origin', localRef: 'refs/heads/main', remoteRef: 'heads/main' })).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await remote.push(provider, { remote: 'origin', localRef: 'refs/heads/main', remoteRef: 'refs/heads/main' });
    const { stdout } = await execFileAsync('git', ['ls-remote', '--refs', bareRemote, 'refs/heads/main']);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}\trefs\/heads\/main$/);
  });

  it('fetches into the remote tracking namespace only', async () => {
    await fixture.write('b.txt', 'second\n');
    await fixture.commitAll('second');
    await remote.push(provider, { remote: 'origin', localRef: 'refs/heads/main', remoteRef: 'refs/heads/main' });
    await remote.fetch(provider, 'origin', false);
    const tracking = await execFileAsync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: fixture.path });
    const local = await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: fixture.path });
    expect(tracking.stdout.trim()).toBe(local.stdout.trim());
  });

  it('pulls through a confirmed FETCH_HEAD OID with ff-only', async () => {
    await execFileAsync('git', ['reset', '--hard', 'HEAD~1', '--quiet'], { cwd: fixture.path });
    const confirmedOid = await remote.fetchBranchForPull(provider, 'origin', 'main');
    await remote.pull(provider, confirmedOid, 'ffOnly');
    const local = await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: fixture.path });
    expect(local.stdout.trim()).toBe(confirmedOid);
  });

  it('classifies an unknown push outcome with exactly one ls-remote', async () => {
    const confirmed = (await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: fixture.path })).stdout.trim();
    const reconciled = await remote.reconcileUnknownPush(provider, { remote: 'origin', remoteRef: 'refs/heads/main', confirmedLocalOid: confirmed });
    expect(reconciled).toEqual({ outcome: 'reconciledSuccess' });

    const diverged = await remote.reconcileUnknownPush(provider, { remote: 'origin', remoteRef: 'refs/heads/main', confirmedLocalOid: '0'.repeat(40) });
    expect(diverged).toMatchObject({ outcome: 'remoteDiverged' });
  });

  it('rejects ambiguous ls-remote output instead of guessing', () => {
    expect(parseLsRemote(`${'a'.repeat(40)}\trefs/heads/main\n`, 'refs/heads/main')).toBe('a'.repeat(40));
    expect(() => parseLsRemote(`${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/other\n`, 'refs/heads/main')).toThrow();
    expect(() => parseLsRemote(`${'a'.repeat(7)}\trefs/heads/main\n`, 'refs/heads/main')).toThrow();
    expect(() => parseLsRemote(`${'a'.repeat(40)}\trefs/heads/other\n`, 'refs/heads/main')).toThrow();
  });
});
