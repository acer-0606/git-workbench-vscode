import { describe, expect, it } from 'vitest';

import { reduceHunkSelection, toSelectionItems, type HunkSelectionState } from './hunkSelection.js';

const initial: HunkSelectionState = { selectedHunks: new Set(), selectedLines: new Map() };

describe('hunk selection state', () => {
  it('toggles whole hunks and clears line selections when a hunk is selected', () => {
    let state = reduceHunkSelection(initial, { type: 'line.toggled', hunkId: 'h1', lineId: 'l1' });
    state = reduceHunkSelection(state, { type: 'hunk.toggled', hunkId: 'h1' });
    expect(state.selectedHunks.has('h1')).toBe(true);
    expect(state.selectedLines.has('h1')).toBe(false);
  });

  it('deselects the hunk marker when a single line is picked', () => {
    let state = reduceHunkSelection(initial, { type: 'hunk.toggled', hunkId: 'h1' });
    state = reduceHunkSelection(state, { type: 'line.toggled', hunkId: 'h1', lineId: 'l1' });
    expect(state.selectedHunks.has('h1')).toBe(false);
    expect(state.selectedLines.get('h1')).toEqual(new Set(['l1']));
  });

  it('clears everything on generation or whitespace changes', () => {
    let state = reduceHunkSelection(initial, { type: 'hunk.toggled', hunkId: 'h1' });
    state = reduceHunkSelection(state, { type: 'cleared' });
    expect(toSelectionItems('a.ts', state)).toEqual([]);
  });

  it('converts the state to sealed selection items in a stable order', () => {
    let state = reduceHunkSelection(initial, { type: 'hunk.toggled', hunkId: 'h2' });
    state = reduceHunkSelection(state, { type: 'hunk.toggled', hunkId: 'h1' });
    state = reduceHunkSelection(state, { type: 'line.toggled', hunkId: 'h3', lineId: 'l9' });
    const items = toSelectionItems('a.ts', state);
    expect(items).toEqual(expect.arrayContaining([
      { kind: 'hunk', path: 'a.ts', rawHunkId: 'h1' },
      { kind: 'hunk', path: 'a.ts', rawHunkId: 'h2' },
      { kind: 'lines', path: 'a.ts', rawHunkId: 'h3', lineIds: ['l9'] },
    ]));
  });
});
