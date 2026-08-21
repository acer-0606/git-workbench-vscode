import { expect, it } from 'vitest';

import { buildSelectedPatch, type RawUnifiedDiff } from './patchBuilder.js';

const raw: RawUnifiedDiff = {
  files: [{
    path: 'a.ts',
    header: ['diff --git a/a.ts b/a.ts', 'index 1111111..2222222 100644', '--- a/a.ts', '+++ b/a.ts'],
    fullPatchBytes: new Uint8Array(),
    lineSelectionAllowed: true,
    oldLineCount: 20,
    newLineCount: 22,
    hunks: [{
      id: 'h1', header: '@@ -8,8 +8,10 @@', oldStart: 8, oldLines: 8, newStart: 8, newLines: 10,
      lines: [
        { id: 'c8', marker: ' ', text: 'line8' }, { id: 'c9', marker: ' ', text: 'line9' }, { id: 'c10', marker: ' ', text: 'line10' },
        { id: 'add-a', marker: '+', text: 'selected A' },
        { id: 'c11', marker: ' ', text: 'line11' }, { id: 'c12', marker: ' ', text: 'line12' },
        { id: 'add-b', marker: '+', text: 'selected B' },
        { id: 'c13', marker: ' ', text: 'line13' }, { id: 'c14', marker: ' ', text: 'line14' }, { id: 'c15', marker: ' ', text: 'line15' },
      ],
    }],
  }],
};

it('expands selected lines into safe hunks with three context lines', () => {
  const patch = buildSelectedPatch(raw, [{ kind: 'lines', path: 'a.ts', rawHunkId: 'h1', lineIds: ['add-a', 'add-b'] }]);
  expect(patch.toString('utf8')).toContain('@@ -8,8 +8,10 @@');
  expect(patch.toString('utf8')).not.toContain('@@ -0,0 +0,0 @@');
  expect(patch.contextLines).toBeGreaterThanOrEqual(3);
  const text = patch.toString('utf8');
  expect(text).toContain('+selected A');
  expect(text).toContain('+selected B');
});

it('turns unselected deletions into context lines and keeps the patch applicable', () => {
  const withDeletion: RawUnifiedDiff = {
    files: [{
      path: 'b.ts',
      header: ['diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts'],
      fullPatchBytes: new Uint8Array(),
      lineSelectionAllowed: true,
      oldLineCount: 20,
      newLineCount: 19,
      hunks: [{
        id: 'h1', header: '@@ -5,9 +5,8 @@', oldStart: 5, oldLines: 9, newStart: 5, newLines: 8,
        lines: [
          { id: 'x1', marker: ' ', text: 'ctx1' }, { id: 'x2', marker: ' ', text: 'ctx2' }, { id: 'x3', marker: ' ', text: 'ctx3' },
          { id: 'del-1', marker: '-', text: 'dropped line' },
          { id: 'x4', marker: ' ', text: 'ctx4' },
          { id: 'keep-del', marker: '-', text: 'kept deletion' },
          { id: 'x5', marker: ' ', text: 'ctx5' }, { id: 'x6', marker: ' ', text: 'ctx6' }, { id: 'x7', marker: ' ', text: 'ctx7' },
        ],
      }],
    }],
  };
  const patch = buildSelectedPatch(withDeletion, [{ kind: 'lines', path: 'b.ts', rawHunkId: 'h1', lineIds: ['keep-del'] }]);
  const text = patch.toString('utf8');
  expect(text).toContain('-kept deletion');
  expect(text).not.toContain('-dropped line');
  expect(text).toContain(' dropped line');
  expect(patch.contextLines).toBeGreaterThanOrEqual(3);
});

it('rejects unknown lines, hunks, files and non-selectable file kinds', () => {
  expect(() => buildSelectedPatch(raw, [{ kind: 'lines', path: 'a.ts', rawHunkId: 'h1', lineIds: ['nope'] }])).toThrow(/未知行/);
  expect(() => buildSelectedPatch(raw, [{ kind: 'hunk', path: 'a.ts', rawHunkId: 'h9' }])).toThrow(/未知 Hunk/);
  expect(() => buildSelectedPatch(raw, [{ kind: 'file', path: 'missing.ts' }])).toThrow(/未知文件/);
  const binaryOnly: RawUnifiedDiff = { files: [{ ...raw.files[0]!, path: 'img.png', lineSelectionAllowed: false }] };
  expect(() => buildSelectedPatch(binaryOnly, [{ kind: 'lines', path: 'img.png', rawHunkId: 'h1', lineIds: ['add-a'] }])).toThrow(/UNSAFE|完整 Hunk|只能选择/);
});

it('uses digest-checked full patch bytes for whole-file selections', () => {
  const withBytes: RawUnifiedDiff = {
    files: [{
      ...raw.files[0]!,
      fullPatchBytes: Buffer.from('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n line\n+added\n'),
      hunks: [],
    }],
  };
  const patch = buildSelectedPatch(withBytes, [{ kind: 'file', path: 'a.ts' }]);
  expect(patch.toString('utf8')).toContain('+added');
});
