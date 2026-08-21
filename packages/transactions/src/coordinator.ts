import { GitWorkbenchError, compareVersionVectors, type MutationConfirmation, type MutationPlan } from '@git-workbench/domain';

import type { DurableJournal, JournalDetail, JournalState } from './journal.js';
import type { RepositoryWriteQueue } from './writeQueue.js';

export interface MutationPorts {
  withRepositoryLease<T>(plan: MutationPlan, action: () => Promise<T>): Promise<T>;
  capture(plan: MutationPlan): Promise<{ readonly baseline: MutationPlan['baseline']; readonly configFingerprint: string }>;
  checkpoint(plan: MutationPlan): Promise<void>;
  invoke(plan: MutationPlan): Promise<
    | { readonly outcome: 'success'; readonly afterImage?: unknown }
    | { readonly outcome: 'paused'; readonly paused: { readonly operationKind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply'; readonly step: number } }
    | { readonly outcome: 'unknown' }
  >;
  verify(plan: MutationPlan): Promise<boolean>;
  reconcileFailure(plan: MutationPlan, error: unknown): Promise<
    | { readonly outcome: 'committed' | 'rollback' | 'needsAttention' }
    | { readonly outcome: 'paused'; readonly paused: { readonly operationKind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply'; readonly step: number } }
  >;
  rollbackAfterFailure(plan: MutationPlan, error: unknown): Promise<void>;
  bumpGenerations(repositoryId: string, commonRepositoryId: string): void;
}

/**
 * The template method every write goes through: queue -> lease -> journal ->
 * preflight revalidation -> checkpoint -> provider -> postcondition verify,
 * with reconciliation for unknown results and rollback on failed checks.
 * No UI path may reach Git any other way.
 */
export class MutationCoordinator {
  constructor(private readonly queue: RepositoryWriteQueue, private readonly journal: DurableJournal, private readonly ports: MutationPorts) {}

  execute(plan: MutationPlan, confirmation: MutationConfirmation): Promise<void> {
    if (confirmation.operationId !== plan.operationId || confirmation.planDigest !== plan.planDigest) {
      return Promise.reject(new GitWorkbenchError({ code: 'INVALID_INPUT', operationId: String(plan.operationId), message: '确认令牌无效', repositoryChanged: false, retry: 'refresh' }));
    }
    return this.queue.run(String(plan.commonRepositoryId), () => this.ports.withRepositoryLease(plan, async () => {
      let sequence = 0;
      let previous: Awaited<ReturnType<DurableJournal['readAll']>>[number] | undefined;
      const record = async (state: JournalState, detail?: JournalDetail): Promise<void> => {
        const entry = {
          schema: 1 as const,
          operationId: String(plan.operationId),
          state,
          sequence: sequence++,
          repositoryId: String(plan.repositoryId),
          planDigest: plan.planDigest,
          updatedAt: new Date().toISOString(),
          ...(detail ? { detail } : {}),
        };
        await this.journal.append(entry, previous);
        previous = entry;
      };

      const settleFailure = async (error: unknown, reasonCode: 'provider-threw' | 'unknown-result' | 'postcondition'): Promise<'committed' | 'paused' | 'failed'> => {
        await record('Verifying', { kind: 'reason', reasonCode });
        let reconciliation: Awaited<ReturnType<MutationPorts['reconcileFailure']>>;
        try {
          reconciliation = await this.ports.reconcileFailure(plan, error);
        } catch {
          await record('NeedsAttention', { kind: 'reason', reasonCode: 'reconciliation-failed' });
          this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
          return 'failed';
        }
        if (reconciliation.outcome === 'committed') {
          this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
          await record('Committed');
          return 'committed';
        }
        if (reconciliation.outcome === 'paused') {
          this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
          await record('Paused', { kind: 'paused', ...reconciliation.paused });
          return 'paused';
        }
        if (reconciliation.outcome === 'rollback') {
          await record('RollingBack');
          try {
            await this.ports.rollbackAfterFailure(plan, error);
            await record('RolledBack');
          } catch {
            await record('NeedsAttention', { kind: 'reason', reasonCode: 'rollback-failed' });
          }
        } else {
          await record('NeedsAttention');
        }
        this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
        return 'failed';
      };

      await record('Planned');
      await record('Preflight');
      let actual: Awaited<ReturnType<MutationPorts['capture']>>;
      try {
        actual = await this.ports.capture(plan);
      } catch (error) {
        await record('Rejected', { kind: 'reason', reasonCode: 'preflight-failed' });
        throw error instanceof GitWorkbenchError ? error : new GitWorkbenchError({
          code: 'PARSER_UNSUPPORTED',
          operationId: String(plan.operationId),
          message: '无法可靠读取执行前仓库状态',
          repositoryChanged: false,
          retry: 'refresh',
        });
      }
      const mismatches = compareVersionVectors(plan.baseline, actual.baseline);
      if (actual.configFingerprint !== plan.configFingerprint) mismatches.push('configuration');
      if (mismatches.length > 0) {
        await record('Rejected', { kind: 'reason', reasonCode: 'stale-plan' });
        throw new GitWorkbenchError({ code: 'STALE_PLAN', operationId: String(plan.operationId), message: `计划已过期：${mismatches.join(', ')}`, repositoryChanged: true, retry: 'refresh' });
      }
      try {
        await this.ports.checkpoint(plan);
      } catch (error) {
        await record('NeedsAttention', { kind: 'reason', reasonCode: 'checkpoint-failed' });
        this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
        throw error instanceof GitWorkbenchError ? error : new GitWorkbenchError({
          code: 'POSTCONDITION_FAILED',
          operationId: String(plan.operationId),
          message: '恢复检查点未能完整建立，需要检查恢复数据',
          repositoryChanged: true,
          retry: 'reconcile',
        });
      }
      await record('Checkpointed');
      await record('Running');
      let result: Awaited<ReturnType<MutationPorts['invoke']>>;
      try {
        result = await this.ports.invoke(plan);
      } catch (error) {
        const typed = error instanceof GitWorkbenchError ? error : new GitWorkbenchError({
          code: 'POSTCONDITION_FAILED',
          operationId: String(plan.operationId),
          message: 'Git 写操作异常结束，需要对账',
          repositoryChanged: true,
          retry: 'reconcile',
        });
        if (await settleFailure(typed, 'provider-threw') !== 'failed') return;
        throw typed;
      }
      if (result.outcome === 'unknown') {
        const error = new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', operationId: String(plan.operationId), message: '操作结果未知，需要对账', repositoryChanged: true, retry: 'reconcile' });
        if (await settleFailure(error, 'unknown-result') !== 'failed') return;
        throw error;
      }
      if (result.outcome === 'paused') {
        this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
        await record('Paused', { kind: 'paused', ...result.paused });
        return;
      }
      await record('Verifying');
      if (!(await this.ports.verify(plan))) {
        const error = new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', operationId: String(plan.operationId), message: '后置状态与计划不一致', repositoryChanged: true, retry: 'reconcile' });
        if (await settleFailure(error, 'postcondition') !== 'failed') return;
        throw error;
      }
      this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
      await record('Committed');
    }));
  }
}
