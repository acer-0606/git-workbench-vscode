import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canTransition, DurableJournal, type JournalRecord } from './journal.js';

const record = (overrides: Partial<JournalRecord>): JournalRecord => ({
  schema: 1,
  operationId: 'op-1',
  state: 'Planned',
  sequence: 0,
  repositoryId: 'repo-1',
  planDigest: 'd'.repeat(64),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('journal state machine', () => {
  it('allows the legal happy path and failure paths', () => {
    expect(canTransition('Planned', 'Preflight')).toBe(true);
    expect(canTransition('Preflight', 'Checkpointed')).toBe(true);
    expect(canTransition('Checkpointed', 'Running')).toBe(true);
    expect(canTransition('Running', 'Verifying')).toBe(true);
    expect(canTransition('Verifying', 'Committed')).toBe(true);
    expect(canTransition('Verifying', 'Verifying')).toBe(true);
    expect(canTransition('Verifying', 'RollingBack')).toBe(true);
    expect(canTransition('RollingBack', 'RolledBack')).toBe(true);
    expect(canTransition('Running', 'Paused')).toBe(true);
  });

  it('rejects backwards moves and moves out of terminal states', () => {
    expect(canTransition('Running', 'Checkpointed')).toBe(false);
    expect(canTransition('Committed', 'Running')).toBe(false);
    expect(canTransition('Rejected', 'Planned')).toBe(false);
    expect(canTransition('Cancelled', 'Running')).toBe(false);
    expect(canTransition('RolledBack', 'RollingBack')).toBe(false);
    expect(canTransition('NeedsAttention', 'Running')).toBe(false);
  });
});

describe('DurableJournal', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-workbench-journal-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists checksummed records and replays them intact', async () => {
    const journal = new DurableJournal(root);
    await journal.append(record({ state: 'Planned', sequence: 0 }));
    await journal.append(record({ state: 'Preflight', sequence: 1 }), record({ state: 'Planned', sequence: 0 }));
    const replayed = await journal.readAll('repo-1', 'op-1');
    expect(replayed.map((entry) => entry.state)).toEqual(['Planned', 'Preflight']);
    expect(replayed[1]?.sequence).toBe(1);
  });

  it('accepts an identical idempotent replay but rejects a divergent one', async () => {
    const journal = new DurableJournal(root);
    const first = record({ state: 'Planned', sequence: 0 });
    await journal.append(first);
    await journal.append(first);
    await expect(journal.append(record({ state: 'Planned', sequence: 0, planDigest: 'e'.repeat(64) }))).rejects.toThrow();
  });

  it('rejects sequence skips and illegal transitions at write time', async () => {
    const journal = new DurableJournal(root);
    await journal.append(record({ state: 'Planned', sequence: 0 }));
    await expect(journal.append(record({ state: 'Preflight', sequence: 2 }), record({ state: 'Planned', sequence: 0 }))).rejects.toThrow('sequence');
    await expect(journal.append(record({ state: 'Committed', sequence: 1 }), record({ state: 'Planned', sequence: 0 }))).rejects.toThrow('transition');
  });

  it('detects checksum corruption on replay instead of parsing half a record', async () => {
    const journal = new DurableJournal(root);
    await journal.append(record({ state: 'Planned', sequence: 0 }));
    const { createHash } = await import('node:crypto');
    const { readFile, writeFile, readdir } = await import('node:fs/promises');
    const directory = join(root, createHash('sha256').update('repo-1').digest('hex'), createHash('sha256').update('op-1').digest('hex'));
    const name = (await readdir(directory)).find((candidate) => candidate.endsWith('.json'))!;
    const payload = JSON.parse(await readFile(join(directory, name), 'utf8')) as { checksum: string; body: string };
    payload.body = payload.body.replace('Planned', 'Committed');
    await writeFile(join(directory, name), `${JSON.stringify(payload)}\n`);
    await expect(journal.readAll('repo-1', 'op-1')).rejects.toThrow('checksum');
  });
});
