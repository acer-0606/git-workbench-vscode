import { expect, it } from 'vitest';

import { allowedPausedActions } from './pausedOperation.js';

it('offers only actions supported by the active operation', () => {
  const capabilities = { revertSkip: true };
  expect(allowedPausedActions('rebase', capabilities)).toEqual(['continue', 'skip', 'abort']);
  expect(allowedPausedActions('merge', capabilities)).toEqual(['continue', 'abort']);
  expect(allowedPausedActions('stashApply', capabilities)).toEqual(['markResolved', 'abortToCheckpoint']);
  expect(allowedPausedActions('revert', { revertSkip: false })).toEqual(['continue', 'abort']);
});
