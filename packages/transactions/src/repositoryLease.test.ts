import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CrossProcessRepositoryLease } from './repositoryLease.js';

describe('CrossProcessRepositoryLease', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-workbench-lease-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('grants one lease per common git dir and rejects the second holder', async () => {
    const lease = new CrossProcessRepositoryLease(root);
    const held = await lease.acquire('op-1');
    await expect(lease.acquire('op-2')).rejects.toThrow('REPOSITORY_LOCKED');
    await held.release();
    const next = await lease.acquire('op-3');
    await next.release();
  });

  it('refuses to release a lease owned by another token', async () => {
    const lease = new CrossProcessRepositoryLease(root);
    const held = await lease.acquire('op-1');
    const hijacked = { ...held, release: async () => undefined };
    void hijacked;
    // Simulate another process replacing the owner file with a different token.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(held.directory, 'owner.json'), `${JSON.stringify({ ...held.owner, token: 'other' })}\n`);
    await expect(held.release()).rejects.toThrow('another process');
  });

  it('detects stale heartbeats without guessing', async () => {
    let clock = 1_000_000;
    const lease = new CrossProcessRepositoryLease(root, { heartbeatTimeoutMs: 30_000, now: () => clock });
    const held = await lease.acquire('op-1');
    expect(await lease.isStale()).toBe(false);
    clock += 31_000;
    expect(await lease.isStale()).toBe(true);
    await held.release();
  });
});
