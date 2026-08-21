// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { fireEvent, render as renderView } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ConflictEntry } from '@git-workbench/domain';

import { SpecialConflictDecision } from './special.js';
import { PausedBanner } from './banner.js';

const binaryConflict: ConflictEntry = {
  path: 'assets/logo.png',
  kind: 'binary',
  stages: [
    { stage: 2, oid: 'a'.repeat(40), mode: '100644' },
    { stage: 3, oid: 'b'.repeat(40), mode: '100644' },
  ],
};

const deleteModifyConflict: ConflictEntry = {
  path: 'removed.txt',
  kind: 'deleteModify',
  stages: [{ stage: 1, oid: 'c'.repeat(40), mode: '100644' }, { stage: 2, oid: 'd'.repeat(40), mode: '100644' }],
};

it('binary decisions show both stage OIDs and the three allowed actions', () => {
  const decide = vi.fn();
  const view = renderView(<SpecialConflictDecision conflict={binaryConflict} onDecision={decide} />);
  expect(screen.getByText('assets/logo.png')).toBeTruthy();
  expect(screen.getByText(`${'a'.repeat(12)}…`)).toBeTruthy();
  expect(screen.getByText(`${'b'.repeat(12)}…`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '两份都保留' }));
  expect(decide).toHaveBeenCalledWith({ kind: 'binary', choice: 'keepBoth', newPath: 'assets/logo.png.theirs' });
  view.unmount();
});

it('delete/modify offers keep-modified and confirm-delete only', () => {
  const decide = vi.fn();
  const view = renderView(<SpecialConflictDecision conflict={deleteModifyConflict} onDecision={decide} />);
  expect(screen.getByRole('button', { name: '保留修改内容' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(decide).toHaveBeenCalledWith({ kind: 'deleteModify', choice: 'confirmDelete' });
  expect(screen.queryByRole('button', { name: '使用当前' })).toBeNull();
  view.unmount();
});

it('shows operation progress, conflict count and only allowed actions', () => {
  const view = render(
    <PausedBanner
      operation={{ kind: 'rebase', currentStep: 2, totalSteps: 5, conflicts: ['a.ts'], actions: ['continue', 'skip', 'abort'] }}
      onAction={vi.fn()}
    />,
  );
  expect(screen.getByText('Rebase：第 2/5 步')).toBeTruthy();
  expect(screen.getByText('1 个冲突')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '强制完成' })).toBeNull();
  // Continue stays disabled while conflicts remain.
  expect((screen.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
});

it('enables continue once conflicts are resolved and forwards the action', () => {
  const action = vi.fn();
  const view = renderView(
    <PausedBanner
      operation={{ kind: 'merge', currentStep: 1, totalSteps: 1, conflicts: [], actions: ['continue', 'abort'] }}
      onAction={action}
    />,
  );
  const continueButton = screen.getByRole('button', { name: '继续' }) as HTMLButtonElement;
  expect(continueButton.disabled).toBe(false);
  fireEvent.click(continueButton);
  expect(action).toHaveBeenCalledWith('continue');
  view.unmount();
});
