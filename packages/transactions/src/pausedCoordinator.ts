import { GitWorkbenchError } from '@git-workbench/domain';

import type { DurableJournal, JournalRecord } from './journal.js';

/**
 * Resumes the journal of a paused operation after Continue/Skip/Abort: the
 * Paused record is appended by the coordinator; this helper verifies the
 * on-disk outcome (sequencer marker gone, postcondition head) and advances
 * the journal to Committed — or leaves it NeedsAttention on mismatch. It
 * never re-runs the underlying Git command.
 */
export class PausedCoordinator {
  constructor(private readonly journal: DurableJournal) {}

  async resumeFromDisk(input: {
    readonly repositoryId: string;
    readonly operationId: string;
    readonly sequencerMarkerGone: boolean;
    readonly headMatchesExpectation: boolean;
    readonly expectedHead: string | undefined;
    readonly detect: () => Promise<string | undefined>;
  }): Promise<'committed' | 'paused' | 'needsAttention'> {
    const records = await this.journal.readAll(input.repositoryId, input.operationId);
    if (records.length === 0) {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '未找到该操作的 Journal', repositoryChanged: false, retry: 'none' });
    }
    const last = records[records.length - 1]!;
    if (last.state !== 'Paused') {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `Journal 不处于 Paused 状态：${last.state}`, repositoryChanged: false, retry: 'none' });
    }
    const kind = await input.detect();
    if (!input.sequencerMarkerGone || kind !== undefined) {
      // Still mid-sequence: stay Paused with an updated step view.
      return 'paused';
    }
    if (input.expectedHead !== undefined && !input.headMatchesExpectation) {
      await this.appendNext(records, 'NeedsAttention');
      return 'needsAttention';
    }
    await this.appendNext(records, 'Committed');
    return 'committed';
  }

  private async appendNext(records: readonly JournalRecord[], state: 'Committed' | 'NeedsAttention'): Promise<void> {
    const last = records[records.length - 1]!;
    await this.journal.append(
      {
        schema: 1,
        operationId: last.operationId,
        state,
        sequence: last.sequence + 1,
        repositoryId: last.repositoryId,
        planDigest: last.planDigest,
        updatedAt: new Date().toISOString(),
      },
      last,
    );
  }
}
