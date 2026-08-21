import { describe, expect, it } from 'vitest';

import { parseNumstat, parseRawDiff, parseUnifiedPatch, whitespaceArgs } from './diff.js';

describe('parseRawDiff', () => {
  it('parses plain status records and rename pairs with original-first paths', () => {
    const bytes = Buffer.concat([
      Buffer.from(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0src/a.ts\0`),
      Buffer.from(`:100644 100644 ${'a'.repeat(40)} ${'0'.repeat(40)} R100\0old-name.ts\0new-name.ts\0`),
      Buffer.from(`:000000 100644 ${'0'.repeat(40)} ${'c'.repeat(40)} A\0added.ts\0`),
      Buffer.from(`:100644 000000 ${'d'.repeat(40)} ${'0'.repeat(40)} D\0gone.ts\0`),
    ]);
    expect(parseRawDiff(bytes)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'new-name.ts', originalPath: 'old-name.ts' },
      { status: 'A', path: 'added.ts' },
      { status: 'D', path: 'gone.ts' },
    ]);
  });

  it('maps type changes to modified and unknown states to unmerged', () => {
    const bytes = Buffer.concat([
      Buffer.from(`:100644 120000 ${'a'.repeat(40)} ${'b'.repeat(40)} T\0link.ts\0`),
      Buffer.from(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} X\0odd.ts\0`),
    ]);
    expect(parseRawDiff(bytes).map((entry) => entry.status)).toEqual(['M', 'U']);
  });

  it('rejects headers without a path and malformed headers', () => {
    expect(() => parseRawDiff(Buffer.from(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0`))).toThrow('missing raw diff path');
    expect(() => parseRawDiff(Buffer.from('not-a-header\0x\0'))).toThrow('invalid raw diff record');
  });
});

describe('parseNumstat', () => {
  it('parses counts, binary markers and rename records', () => {
    const bytes = Buffer.concat([
      Buffer.from('3\t1\tsrc/a.ts\0'),
      Buffer.from('-\t-\timage.png\0'),
      Buffer.from('0\t0\t\0old-name.ts\0new-name.ts\0'),
    ]);
    expect(parseNumstat(bytes)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'image.png', additions: null, deletions: null },
      { path: 'new-name.ts', originalPath: 'old-name.ts', additions: 0, deletions: 0 },
    ]);
  });
});

describe('parseUnifiedPatch', () => {
  it('builds hunks with stable ids and numbered context lines', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@ function head',
      ' context',
      '-old',
      '+new',
      '+extra',
      ' tail',
      '\\ No newline at end of file',
      '@@ -10,1 +11,1 @@',
      ' more',
    ].join('\n');
    const hunks = parseUnifiedPatch(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.id).toBe('h0');
    expect(hunks[1]?.id).toBe('h1');
    expect(hunks[0]?.oldStart).toBe(1);
    expect(hunks[0]?.newStart).toBe(1);
    expect(hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'context', oldLine: 1, newLine: 1 },
      { kind: 'deletion', text: 'old', oldLine: 2 },
      { kind: 'addition', text: 'new', newLine: 2 },
      { kind: 'addition', text: 'extra', newLine: 3 },
      { kind: 'context', text: 'tail', oldLine: 3, newLine: 4 },
      { kind: 'noNewline', text: ' No newline at end of file' },
    ]);
  });
});

describe('whitespaceArgs', () => {
  it('maps the three session states to exact Git arguments', () => {
    expect(whitespaceArgs('none')).toEqual([]);
    expect(whitespaceArgs('eol')).toEqual(['--ignore-space-at-eol']);
    expect(whitespaceArgs('all')).toEqual(['--ignore-all-space']);
  });
});
