import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DurableJournal, type JournalRecord } from './journal.js';
import { PausedCoordinator } from './pausedCoordinator.js';

const record = (sequence: number, state: JournalRecord['state']): JournalRecord => ({
  schema: 1,
  operationId: 'paused-op-1',
  state,
  sequence,
  repositoryId: 'a'.repeat(64),
  planDigest: 'd'.repeat(64),
  updatedAt: new Date().toISOString(),
});

describe('PausedCoordinator resume', () => {
  let journalRoot: string;

  beforeEach(async () => {
    journalRoot = await mkdtemp(join(tmpdir(), 'git-workbench-paused-'));
  });

  afterEach(async () => {
    await rm(journalRoot, { recursive: true, force: true });
  });

  const seedPausedJournal = async (): Promise<DurableJournal> => {
    const journal = new DurableJournal(journalRoot);
    const planned = record(0, 'Planned');
    await journal.append(planned);
    await journal.append(record(1, 'Preflight'), planned);
    const checkpointed = record(2, 'Checkpointed');
    await journal.append(checkpointed, record(1, 'Preflight'));
    await journal.append(record(3, 'Running'), checkpointed);
    const paused = record(4, 'Paused');
    await journal.append(paused, record(3, 'Running'));
    return journal;
  };

  it('advances to Committed once the sequencer marker is gone and HEAD matches', async () => {
    const journal = await seedPausedJournal();
    const coordinator = new PausedCoordinator(journal);
    const outcome = await coordinator.resumeFromDisk({
      repositoryId: 'a'.repeat(64),
      operationId: 'paused-op-1',
      sequencerMarkerGone: true,
      headMatchesExpectation: true,
      expectedHead: 'b'.repeat(40),
      detect: async () => undefined,
    });
    expect(outcome).toBe('committed');
    const records = await journal.readAll('a'.repeat(64), 'paused-op-1');
    expect(records[records.length - 1]?.state).toBe('Committed');
  });

  it('stays Paused while the sequencer still reports an active operation', async () => {
    const journal = await seedPausedJournal();
    const coordinator = new PausedCoordinator(journal);
    const outcome = await coordinator.resumeFromDisk({
      repositoryId: 'a'.repeat(64),
      operationId: 'paused-op-1',
      sequencerMarkerGone: false,
      headMatchesExpectation: true,
      expectedHead: undefined,
      detect: async () => 'rebase',
    });
    expect(outcome).toBe('paused');
    const records = await journal.readAll('a'.repeat(64), 'paused-op-1');
    expect(records[records.length - 1]?.state).toBe('Paused');
  });

  it('marks NeedsAttention when the marker is gone but HEAD diverged', async () => {
    const journal = await seedPausedJournal();
    const coordinator = new PausedCoordinator(journal);
    const outcome = await coordinator.resumeFromDisk({
      repositoryId: 'a'.repeat(64),
      operationId: 'paused-op-1',
      sequencerMarkerGone: true,
      headMatchesExpectation: false,
      expectedHead: 'b'.repeat(40),
      detect: async () => undefined,
    });
    expect(outcome).toBe('needsAttention');
    const records = await journal.readAll('a'.repeat(64), 'paused-op-1');
    expect(records[records.length - 1]?.state).toBe('NeedsAttention');
  });

  it('refuses to resume a journal that is not Paused', async () => {
    const journal = new DurableJournal(journalRoot);
    await journal.append(record(0, 'Planned'));
    const coordinator = new PausedCoordinator(journal);
    await expect(coordinator.resumeFromDisk({
      repositoryId: 'a'.repeat(64),
      operationId: 'paused-op-1',
      sequencerMarkerGone: true,
      headMatchesExpectation: true,
      expectedHead: undefined,
      detect: async () => undefined,
    })).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });
});
