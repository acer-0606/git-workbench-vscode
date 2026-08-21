import { useReducer } from 'react';
import type * as React from 'react';
import type { DiffFile } from '@git-workbench/domain';

import { CompareToolbar, type WhitespaceChange } from './toolbar.js';
import { reduceCompareSession, type CompareSessionState } from '../state/session.js';

interface Props {
  readonly files: readonly DiffFile[];
  readonly settingsDefault: CompareSessionState['ignoreWhitespace'];
  readonly onSessionWhitespaceChange: (change: WhitespaceChange) => void;
  readonly onPersistDefault: (value: CompareSessionState['ignoreWhitespace']) => void;
}

const initialState: CompareSessionState = { ignoreWhitespace: 'none', selectedHunkIds: new Set(), stale: false };

/**
 * Read-only compare preview: file list with per-file statistics and the
 * session whitespace control. Selections live in the session reducer and are
 * cleared whenever the whitespace mode or the repository generation changes.
 */
export function CompareView({ files, settingsDefault, onSessionWhitespaceChange, onPersistDefault }: Props): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceCompareSession, initialState);
  return (
    <section aria-label="比较视图">
      <CompareToolbar
        value={state.ignoreWhitespace}
        settingsDefault={settingsDefault}
        selectedCount={state.selectedHunkIds.size}
        onSessionWhitespaceChange={(change) => {
          dispatch({ type: 'whitespace.changed', value: change.ignoreWhitespace });
          onSessionWhitespaceChange(change);
        }}
        onPersistDefault={onPersistDefault}
      />
      <ul>
        {files.map((file) => (
          <li key={`${file.path}`}>
            <span>{`${file.path}`}</span>
            <span>{`+${file.additions ?? '-'} -${file.deletions ?? '-'}`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
