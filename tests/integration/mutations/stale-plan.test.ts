import { describe, expect, it } from 'vitest';
import { createRepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, captureVersionVector } from '@git-workbench/git-cli';
import { asCommonRepositoryId, asOperationId, asRepositoryId, type MutationPlan } from '@git-workbench/domain';
import { compareVersionVectors } from '@git-workbench/domain';

import { DurableJournal, MutationCoordinator, RepositoryWriteQueue } from '@git-workbench/transactions';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('stale plan rejection', () => {
  it('rejects the plan after an external commit between preview and execution', async () => {
    const fixture = await createRepositoryFixture();
    const journalRoot = await mkdtemp(join(tmpdir(), 'stale-plan-journal-'));
    try {
      await fixture.write('a.txt', 'base\n');
      await fixture.commitAll('base');
      const runner = new GitProcessRunner('git');
      const baseline = await captureVersionVector(runner, fixture.path, { generation: 1, commonGeneration: 1, refs: ['refs/heads/main'] });

      // External writer lands a commit after the preview.
      await fixture.write('b.txt', 'external\n');
      await fixture.commitAll('external');

      let invoked = 0;
      const ports = {
        withRepositoryLease: <T,>(_plan: MutationPlan, action: () => Promise<T>) => action(),
        capture: async () => ({ baseline: await captureVersionVector(runner, fixture.path, { generation: 1, commonGeneration: 1, refs: ['refs/heads/main'] }), configFingerprint: 'f'.repeat(64) }),
        checkpoint: async () => undefined,
        invoke: async () => { invoked += 1; return { outcome: 'success' as const }; },
        verify: async () => true,
        reconcileFailure: async () => ({ outcome: 'needsAttention' as const }),
        rollbackAfterFailure: async () => undefined,
        bumpGenerations: () => undefined,
      };
      const plan: MutationPlan = {
        operationId: asOperationId('op-stale-1'),
        repositoryId: asRepositoryId('a'.repeat(64)),
        commonRepositoryId: asCommonRepositoryId('a'.repeat(64)),
        intent: { type: 'commit.create', message: 'planned' },
        baseline: { ...baseline, generation: 1 },
        summary: 'commit',
        effects: [],
        risk: 'normal',
        configFingerprint: 'f'.repeat(64),
        planDigest: 'e'.repeat(64),
      };
      const coordinator = new MutationCoordinator(new RepositoryWriteQueue(), new DurableJournal(journalRoot), ports);
      await expect(coordinator.execute(plan, { operationId: 'op-stale-1', planDigest: 'e'.repeat(64) }))
        .rejects.toMatchObject({ payload: { code: 'STALE_PLAN', message: expect.stringContaining('ref:refs/heads/main') } });
      expect(invoked).toBe(0);
      expect(compareVersionVectors(baseline, baseline)).toEqual([]);
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
      await fixture.dispose();
    }
  });
});
