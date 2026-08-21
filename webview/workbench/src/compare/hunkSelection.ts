import type { PatchSelectionItem } from '@git-workbench/domain';

export interface HunkSelectionState {
  readonly selectedHunks: ReadonlySet<string>;
  readonly selectedLines: ReadonlyMap<string, ReadonlySet<string>>;
}

export type HunkSelectionAction =
  | { readonly type: 'hunk.toggled'; readonly hunkId: string }
  | { readonly type: 'line.toggled'; readonly hunkId: string; readonly lineId: string }
  | { readonly type: 'cleared' };

/**
 * Webview-side hunk/line selection state. Selecting individual lines always
 * deselects the whole-hunk marker for that hunk; clearing resets everything
 * (used when the whitespace mode or generation changes).
 */
export function reduceHunkSelection(state: HunkSelectionState, action: HunkSelectionAction): HunkSelectionState {
  if (action.type === 'cleared') return { selectedHunks: new Set(), selectedLines: new Map() };
  if (action.type === 'hunk.toggled') {
    const hunks = new Set(state.selectedHunks);
    if (hunks.has(action.hunkId)) {
      hunks.delete(action.hunkId);
    } else {
      hunks.add(action.hunkId);
      const lines = new Map(state.selectedLines);
      lines.delete(action.hunkId);
      return { selectedHunks: hunks, selectedLines: lines };
    }
    return { ...state, selectedHunks: hunks };
  }
  const lines = new Map(state.selectedLines);
  const current = new Set(lines.get(action.hunkId) ?? []);
  if (current.has(action.lineId)) current.delete(action.lineId);
  else current.add(action.lineId);
  if (current.size === 0) lines.delete(action.hunkId);
  else lines.set(action.hunkId, current);
  const hunks = new Set(state.selectedHunks);
  hunks.delete(action.hunkId);
  return { selectedHunks: hunks, selectedLines: lines };
}

/** Converts the UI state into the sealed selection items for one file. */
export function toSelectionItems(path: string, state: HunkSelectionState): readonly PatchSelectionItem[] {
  const items: PatchSelectionItem[] = [];
  for (const hunkId of state.selectedHunks) items.push({ kind: 'hunk', path, rawHunkId: hunkId });
  for (const [hunkId, lineIds] of state.selectedLines) {
    if (lineIds.size > 0) items.push({ kind: 'lines', path, rawHunkId: hunkId, lineIds: [...lineIds] });
  }
  return items;
}
