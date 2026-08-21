// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { CompareToolbar } from './toolbar.js';
import { reduceCompareSession } from '../state/session.js';

it('changes only the session and clears selected hunks', () => {
  const change = vi.fn();
  const persist = vi.fn();
  const view = render(<CompareToolbar value="none" settingsDefault="none" selectedCount={2} onSessionWhitespaceChange={change} onPersistDefault={persist} />);
  fireEvent.click(view.getByRole('button', { name: '忽略全部空白' }));
  expect(change).toHaveBeenCalledWith({ ignoreWhitespace: 'all', clearSelection: true });
  expect(persist).not.toHaveBeenCalled();
  view.unmount();
});

it('persists a new default only through the explicit menu action', () => {
  const persist = vi.fn();
  const view = render(<CompareToolbar value="eol" settingsDefault="none" selectedCount={0} onSessionWhitespaceChange={vi.fn()} onPersistDefault={persist} />);
  fireEvent.click(view.getByRole('button', { name: '设为默认（none）' }));
  expect(persist).toHaveBeenCalledWith('eol');
  view.unmount();
});

it('reducer drops selections on whitespace and generation changes', () => {
  const withSelection = { ignoreWhitespace: 'none' as const, selectedHunkIds: new Set(['h0', 'h1']), stale: false };
  expect(reduceCompareSession(withSelection, { type: 'whitespace.changed', value: 'all' })).toEqual({ ignoreWhitespace: 'all', selectedHunkIds: new Set(), stale: false });
  expect(reduceCompareSession(withSelection, { type: 'generation.changed' })).toEqual({ ignoreWhitespace: 'none', selectedHunkIds: new Set(), stale: true });
  expect(reduceCompareSession(withSelection, { type: 'selection.changed', ids: new Set(['h2']) }).selectedHunkIds).toEqual(new Set(['h2']));
});
