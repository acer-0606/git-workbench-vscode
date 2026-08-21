import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asCommonRepositoryId, asOperationId, asRepositoryId, type MutationPlan, type VersionVector } from '@git-workbench/domain';
import { DurableJournal, MutationCoordinator, RepositoryWriteQueue } from '@git-workbench/transactions';

const baseline: VersionVector = {
  generation: 1,
  commonGeneration: 1,
  headOid: 'a'.repeat(40),
  headName: 'main',
  indexFingerprint: 'idx',
  pausedOperation: 'none',
  refs: [],
  files: [],
};

const planFor = (): MutationPlan => ({
  operationId: asOperationId('fault-op-1'),
  repositoryId: asRepositoryId('a'.repeat(64)),
  commonRepositoryId: asCommonRepositoryId('a'.repeat(64)),
  intent: { type: 'commit.create', message: 'm' },
  baseline,
  summary: 's',
  effects: ['HEAD'],
  risk: 'normal',
  configFingerprint: 'c'.repeat(64),
  planDigest: 'd'.repeat(64),
});

const confirmation = { operationId: 'fault-op-1', planDigest: 'd'.repeat(64) };

interface FaultSpec {
  readonly capture?: () => Promise<{ baseline: VersionVector; configFingerprint: string }>;
  readonly invoke?: () => Promise<{ outcome: 'success' } | { outcome: 'paused'; paused: { operationKind: 'cherryPick'; step: number } }>;
  readonly verify?: () => Promise<boolean>;
  readonly reconcile?: () => Promise<{ outcome: 'committed' | 'rollback' | 'needsAttention' }>;
  readonly rollback?: () => Promise<void>;
}

const buildCoordinator = (journal: DurableJournal, faults: FaultSpec) => {
  const calls = { rollback: 0 };
  const coordinator = new MutationCoordinator(new RepositoryWriteQueue(), journal, {
    withRepositoryLease: async <T,>(_plan: MutationPlan, action: () => Promise<T>) => action(),
    capture: faults.capture ?? (async () => ({ baseline, configFingerprint: 'c'.repeat(64) })),
    checkpoint: async () => undefined,
    invoke: faults.invoke ?? (async () => ({ outcome: 'success' as const })),
    verify: faults.verify ?? (async () => true),
    reconcileFailure: faults.reconcile ?? (async () => ({ outcome: 'needsAttention' as const })),
    rollbackAfterFailure: async () => {
      calls.rollback += 1;
      await faults.rollback?.();
    },
    bumpGenerations: () => undefined,
  });
  return { coordinator, calls };
};

describe('daily mutation fault injection', () => {
  let journalRoot: string;

  beforeEach(async () => {
    journalRoot = await mkdtemp(join(tmpdir(), 'git-workbench-fault-'));
  });

  afterEach(async () => {
    await rm(journalRoot, { recursive: true, force: true });
  });

  const finalState = async (repositoryId: string, operationId: string): Promise<string> => {
    const records = await new DurableJournal(journalRoot).readAll(repositoryId, operationId);
    return records[records.length - 1]?.state ?? 'none';
  };

  it('classifies a stale plan as Rejected without invoking the provider', async () => {
    let invoked = false;
    const { coordinator } = buildCoordinator(new DurableJournal(journalRoot), {
      capture: async () => ({ baseline: { ...baseline, headOid: 'b'.repeat(40) }, configFingerprint: 'c'.repeat(64) }),
      invoke: async () => { invoked = true; return { outcome: 'success' }; },
    });
    await expect(coordinator.execute(planFor(), confirmation)).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
    expect(invoked).toBe(false);
    expect(await finalState('a'.repeat(64), 'fault-op-1')).toBe('Rejected');
  });

  it('classifies a thrown provider with reconciliation failure as NeedsAttention', async () => {
    const { coordinator } = buildCoordinator(new DurableJournal(journalRoot), {
      invoke: async () => { throw new Error('git killed'); },
      reconcile: async () => { throw new Error('cannot reconcile'); },
    });
    await expect(coordinator.execute(planFor(), confirmation)).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });
    expect(await finalState('a'.repeat(64), 'fault-op-1')).toBe('NeedsAttention');
  });

  it('rolls the index back when reconciliation prescribes rollback', async () => {
    const { coordinator, calls } = buildCoordinator(new DurableJournal(journalRoot), {
      verify: async () => false,
      reconcile: async () => ({ outcome: 'rollback' }),
      rollback: async () => undefined,
    });
    await expect(coordinator.execute(planFor(), confirmation)).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });
    expect(calls.rollback).toBe(1);
    expect(await finalState('a'.repeat(64), 'fault-op-1')).toBe('RolledBack');
  });

  it('marks NeedsAttention when the rollback itself fails', async () => {
    const { coordinator } = buildCoordinator(new DurableJournal(journalRoot), {
      verify: async () => false,
      reconcile: async () => ({ outcome: 'rollback' }),
      rollback: async () => { throw new Error('cas mismatch'); },
    });
    await expect(coordinator.execute(planFor(), confirmation)).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });
    expect(await finalState('a'.repeat(64), 'fault-op-1')).toBe('NeedsAttention');
  });

  it('treats a reconciled-after-unknown provider failure as Committed', async () => {
    const { coordinator } = buildCoordinator(new DurableJournal(journalRoot), {
      invoke: async () => { throw new Error('connection dropped after pack'); },
      reconcile: async () => ({ outcome: 'committed' }),
    });
    await coordinator.execute(planFor(), confirmation);
    expect(await finalState('a'.repeat(64), 'fault-op-1')).toBe('Committed');
  });

  it('records Paused for a conflicting sequencer and never retries the list', async () => {
    let attempts = 0;
    const { coordinator } = buildCoordinator(new DurableJournal(journalRoot), {
      invoke: async () => {
        attempts += 1;
        return { outcome: 'paused', paused: { operationKind: 'cherryPick' as const, step: 1 } };
      },
    });
    await coordinator.execute(planFor(), confirmation);
    expect(await finalState('a'.repeat(64), 'fault-op-1')).toBe('Paused');
    expect(attempts).toBe(1);
  });
});
