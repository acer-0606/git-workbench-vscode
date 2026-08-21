export type PausedOperationKind = 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply';
export type PausedAction = 'continue' | 'skip' | 'abort' | 'markResolved' | 'abortToCheckpoint';

const actions: Readonly<Record<PausedOperationKind, readonly PausedAction[]>> = {
  merge: ['continue', 'abort'],
  rebase: ['continue', 'skip', 'abort'],
  cherryPick: ['continue', 'skip', 'abort'],
  revert: ['continue', 'skip', 'abort'],
  pullMerge: ['continue', 'abort'],
  pullRebase: ['continue', 'skip', 'abort'],
  stashApply: ['markResolved', 'abortToCheckpoint'],
};

export interface PausedCapabilities { readonly revertSkip: boolean }

/** Only the actions Git's sequencer actually supports for the active operation are offered. */
export const allowedPausedActions = (kind: PausedOperationKind, capabilities: PausedCapabilities): readonly PausedAction[] =>
  kind === 'revert' && !capabilities.revertSkip ? actions[kind].filter((action) => action !== 'skip') : actions[kind];

export interface PausedOperation {
  readonly kind: PausedOperationKind;
  /** HEAD before the operation started, for recovery verification. */
  readonly originalHead: string | undefined;
  readonly remainingOids?: readonly string[];
  readonly step?: number;
}

export type PausedOperationKindWithNone = PausedOperationKind | 'none';
