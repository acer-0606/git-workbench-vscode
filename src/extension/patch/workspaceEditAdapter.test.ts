import { describe, expect, it } from 'vitest';

import { GitWorkbenchError } from '@git-workbench/domain';

import { planWorkspaceEdit } from './workspaceEditAdapter.js';

const document = { uri: 'file:///repo/a.ts', version: 7, dirty: false };

describe('planWorkspaceEdit', () => {
  it('refuses dirty documents instead of saving them', () => {
    expect(() => planWorkspaceEdit({ document: { ...document, dirty: true }, currentText: 'a\n', patchedText: 'b\n' })).toThrow(GitWorkbenchError);
  });

  it('produces one minimal replace block per diverging region', () => {
    const current = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const patched = ['line1', 'changed2', 'line3', 'changed4', 'line5'].join('\n');
    const edit = planWorkspaceEdit({ document, currentText: current, patchedText: patched });
    expect(edit.entries).toHaveLength(2);
    expect(edit.entries[0]).toMatchObject({ range: { start: 1, end: 2 }, newText: 'changed2' });
    expect(edit.entries[1]).toMatchObject({ range: { start: 3, end: 4 }, newText: 'changed4' });
  });

  it('applies edits bottom-up so earlier ranges stay valid', async () => {
    const applied: string[] = [];
    const current = ['a', 'b', 'c'].join('\n');
    const patched = ['x', 'b', 'z'].join('\n');
    const edit = planWorkspaceEdit({ document, currentText: current, patchedText: patched });
    await edit.perform(async (entry) => {
      applied.push(`${entry.range.start}:${entry.newText}`);
    });
    expect(applied).toEqual(['2:z', '0:x']);
  });

  it('returns an empty edit when nothing changed', () => {
    const edit = planWorkspaceEdit({ document, currentText: 'same\n', patchedText: 'same\n' });
    expect(edit.entries).toEqual([]);
  });
});
