import type * as React from 'react';
import type { PausedAction } from '@git-workbench/domain';

export interface PausedOperationBanner {
  readonly kind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply';
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly conflicts: readonly string[];
  readonly actions: readonly PausedAction[];
}

const actionLabels: Readonly<Record<string, string>> = {
  continue: '继续',
  skip: '跳过此提交',
  abort: '中止',
  markResolved: '标记已解决',
  abortToCheckpoint: '恢复到检查点',
};

const kindLabels: Readonly<Record<string, string>> = {
  merge: 'Merge',
  rebase: 'Rebase',
  cherryPick: 'Cherry-pick',
  revert: 'Revert',
  pullMerge: 'Pull (Merge)',
  pullRebase: 'Pull (Rebase)',
  stashApply: 'Stash Apply',
};

interface Props {
  readonly operation: PausedOperationBanner;
  readonly onAction: (action: PausedAction) => void;
}

/**
 * Fixed paused-operation banner. Shown identically at the top of the sidebar
 * and the workbench; closing the panel never clears the state. Continue is
 * disabled while conflicts remain; every button sends `paused.action` and
 * waits for the host's new generation — no local optimistic state flips.
 */
export function PausedBanner({ operation, onAction }: Props): React.JSX.Element {
  const conflictCount = operation.conflicts.length;
  const canContinue = operation.actions.includes('continue') && conflictCount === 0;
  return (
    <div role="alert" data-paused-banner aria-label="Git 操作已暂停">
      <strong>{`${kindLabels[operation.kind] ?? operation.kind}：第 ${operation.currentStep}/${operation.totalSteps} 步`}</strong>
      <span>{`${conflictCount} 个冲突`}</span>
      {conflictCount > 0 ? <ul>{operation.conflicts.map((path) => <li key={path}>{path}</li>)}</ul> : null}
      <div role="toolbar" aria-label="暂停操作">
        {operation.actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={action === 'continue' && !canContinue}
            onClick={() => onAction(action)}
          >
            {actionLabels[action] ?? action}
          </button>
        ))}
      </div>
    </div>
  );
}
