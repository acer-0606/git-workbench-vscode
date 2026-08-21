import { describe, expect, it } from 'vitest';

import { validatePatchSelection, type PatchSelection } from './patch.js';

const token = {
  id: 'raw-1',
  repositoryId: 'repo',
  generation: 8,
  leftIdentity: 'a'.repeat(40),
  rightIdentity: 'worktree:h1',
  rawDigest: 'd1',
  viewDigest: 'v1',
} as const;

const selection = (overrides: Partial<PatchSelection>): PatchSelection => ({
  tokenId: 'raw-1',
  generation: 8,
  viewDigest: 'v1',
  items: [{ kind: 'file', path: 'a.ts' }],
  ...overrides,
});

describe('validatePatchSelection', () => {
  it('rejects a selection from another generation or view mode', () => {
    expect(validatePatchSelection(token, selection({ generation: 7 }))).toEqual(['generation']);
    expect(validatePatchSelection(token, selection({ tokenId: 'raw-2' }))).toEqual(['token']);
    expect(validatePatchSelection(token, selection({ viewDigest: 'old-view' }))).toEqual(['view']);
  });

  it('rejects empty and oversized selections', () => {
    expect(validatePatchSelection(token, selection({ items: [] }))).toContain('empty');
    expect(validatePatchSelection(token, selection({ items: Array.from({ length: 10_001 }, () => ({ kind: 'file' as const, path: 'a.ts' })) }))).toContain('selection-size');
  });

  it('accepts the matching selection', () => {
    expect(validatePatchSelection(token, selection({}))).toEqual([]);
  });
});
