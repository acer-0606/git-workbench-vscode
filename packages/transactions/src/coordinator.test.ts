import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asCommonRepositoryId, asOperationId, asRepositoryId, type MutationPlan, type VersionVector } from '@git-workbench/domain';

import { MutationCoordinator } from './coordinator.js';
import { DurableJournal } from './journal.js';
import { RepositoryWriteQueue } from './writeQueue.js';

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

const plan: MutationPlan = {
  operationId: asOperationId('operation-1'),
  repositoryId: asRepositoryId('a'.repeat(64)),
  commonRepositoryId: asCommonRepositoryId('a'.repeat(64)),
  intent: { type: 'commit.create', message: 'message' },
  baseline,
  summary: 'Commit staged changes',
  effects: ['new commit on refs/heads/main'],
  risk: 'normal',
  configFingerprint: 'c'.repeat(64),
  planDigest: 'd'.repeat(64),
};

const confirmation = { operationId: 'operation-1', planDigest: 'd'.repeat(64) };

describe('MutationCoordinator', () => {
  let journalRoot: string;

  beforeEach(async () => {
    journalRoot = await mkdtemp(join(tmpdir(), 'git-workbench-coordinator-'));
    return async () => {
      await rm(journalRoot, { recursive: true, force: true });
    };
  });

  const fixtureCoordinator = (overrides: {
    currentVector?: VersionVector;
    configFingerprint?: string;
    invoke?: () => Promise<{ outcome: 'success' }>;
  }) => {
    const calls = { checkpoint: 0, invoke: 0, verify: 0, bump: 0 };
    const ports = {
      withRepositoryLease: <T,>(_plan: MutationPlan, action: () => Promise<T>) => action(),
      capture: async () => ({ baseline: overrides.currentVector ?? baseline, configFingerprint: overrides.configFingerprint ?? plan.configFingerprint }),
      checkpoint: async () => { calls.checkpoint += 1; },
      invoke: overrides.invoke ?? (async () => { calls.invoke += 1; return { outcome: 'success' as const }; }),
      verify: async () => { calls.verify += 1; return true; },
      reconcileFailure: async () => ({ outcome: 'needsAttention' as const }),
      rollbackAfterFailure: async () => undefined,
      bumpGenerations: () => { calls.bump += 1; },
    };
    const coordinator = new MutationCoordinator(new RepositoryWriteQueue(), new DurableJournal(journalRoot), ports);
    return { coordinator, calls };
  };

  it('does not execute when preflight differs from the preview baseline', async () => {
    const invoke = vi.fn(async () => ({ outcome: 'success' as const }));
    const { coordinator } = fixtureCoordinator({ currentVector: { ...baseline, headOid: 'b'.repeat(40) }, invoke });
    await expect(coordinator.execute(plan, confirmation)).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a wrong confirmation token before anything runs', async () => {
    const { coordinator, calls } = fixtureCoordinator({});
    await expect(coordinator.execute(plan, { operationId: 'operation-1', planDigest: 'x'.repeat(64) })).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    expect(calls.invoke).toBe(0);
  });

  it('runs the full journal happy path and bumps generations once', async () => {
    const { coordinator, calls } = fixtureCoordinator({});
    await coordinator.execute(plan, confirmation);
    expect(calls.invoke).toBe(1);
    expect(calls.checkpoint).toBe(1);
    expect(calls.verify).toBe(1);
    expect(calls.bump).toBe(1);
    const journal = new DurableJournal(journalRoot);
    const states = (await journal.readAll(String(plan.repositoryId), String(plan.operationId))).map((entry) => entry.state);
    expect(states).toEqual(['Planned', 'Preflight', 'Checkpointed', 'Running', 'Verifying', 'Committed']);
  });

  it('reconciles a thrown provider into NeedsAttention and never retries blindly', async () => {
    const invoke = vi.fn(async () => { throw new Error('git crashed'); });
    const { coordinator } = fixtureCoordinator({ invoke });
    await expect(coordinator.execute(plan, confirmation)).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });
    expect(invoke).toHaveBeenCalledTimes(1);
    const journal = new DurableJournal(journalRoot);
    const states = (await journal.readAll(String(plan.repositoryId), String(plan.operationId))).map((entry) => entry.state);
    expect(states[states.length - 1]).toBe('NeedsAttention');
  });
});
