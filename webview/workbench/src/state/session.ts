import type { IgnoreWhitespace } from '@git-workbench/domain';

export interface CompareSessionState {
  readonly ignoreWhitespace: IgnoreWhitespace;
  readonly selectedHunkIds: ReadonlySet<string>;
  readonly stale: boolean;
}

export type CompareSessionAction =
  | { readonly type: 'whitespace.changed'; readonly value: IgnoreWhitespace }
  | { readonly type: 'generation.changed' }
  | { readonly type: 'selection.changed'; readonly ids: ReadonlySet<string> };

/**
 * Session-scoped compare state. A whitespace switch only changes the current
 * session and always clears the hunk/line selection; a generation change
 * invalidates any existing selection instead of silently keeping it.
 */
export function reduceCompareSession(state: CompareSessionState, action: CompareSessionAction): CompareSessionState {
  if (action.type === 'whitespace.changed') return { ...state, ignoreWhitespace: action.value, selectedHunkIds: new Set(), stale: false };
  if (action.type === 'generation.changed') return { ...state, selectedHunkIds: new Set(), stale: true };
  return { ...state, selectedHunkIds: action.ids };
}
