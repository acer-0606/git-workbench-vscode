import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { GitWorkbenchError } from '@git-workbench/domain';
import { StatusV2Decoder, parseStatusV2, statusV2Limits } from './status.js';

const encoder = new TextEncoder();
const oid = 'a'.repeat(40);

const fixture = (): Uint8Array => readFileSync(
  fileURLToPath(new URL('../testdata/status-v2.bin', import.meta.url)),
);

const parserError = (
  action: () => unknown,
  code: 'PARSER_UNSUPPORTED' | 'TOO_LARGE' = 'PARSER_UNSUPPORTED',
): void => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GitWorkbenchError);
    expect((error as GitWorkbenchError).payload).toMatchObject({
      code,
      retry: 'none',
      repositoryChanged: false,
    });
    return;
  }
  throw new Error('Expected a controlled parser error');
};

describe('parseStatusV2', () => {
  test('preserves Chinese and newline filenames in NUL-delimited rename output', () => {
    const status = parseStatusV2(fixture(), 7);

    expect(status).toEqual({
      generation: 7,
      branch: {
        headName: 'main',
        headOid: oid,
        upstream: 'origin/main',
        ahead: 2,
        behind: 1,
      },
      changes: [
        {
          path: '新 名\nrenamed.txt',
          originalPath: '旧 名\noriginal.txt',
          index: 'renamed',
          worktree: 'modified',
          submodule: false,
        },
      ],
    });
  });

  test('preserves a BOM at the beginning of a rename old path across chunk boundaries', () => {
    const bytes = encoder.encode([
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R52 renamed.txt`,
      '\uFEFFsource.txt',
      '',
    ].join('\0'));
    const decoder = new StatusV2Decoder(0);
    for (let index = 0; index < bytes.length; index += 2) {
      decoder.push(bytes.subarray(index, index + 2));
    }

    expect(decoder.finish().changes).toMatchObject([
      { path: 'renamed.txt', originalPath: '\uFEFFsource.txt' },
    ]);
  });

  test('maps ordinary, unmerged, untracked, and ignored records', () => {
    const bytes = encoder.encode([
      `1 .M N... 100644 100644 100644 ${oid} ${oid} regular file.txt`,
      `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflicted.txt`,
      '? new file.txt',
      '! ignored file.txt',
      '',
    ].join('\0'));

    expect(parseStatusV2(bytes, 0)).toMatchObject({
      generation: 0,
      branch: { ahead: 0, behind: 0 },
      changes: [
        { path: 'regular file.txt', index: 'unchanged', worktree: 'modified', submodule: false },
        { path: 'conflicted.txt', index: 'unmerged', worktree: 'unmerged', submodule: false },
        { path: 'new file.txt', index: 'untracked', worktree: 'untracked', submodule: false },
        { path: 'ignored file.txt', index: 'ignored', worktree: 'ignored', submodule: false },
      ],
    });
  });

  test('handles initial and detached branch sentinels', () => {
    const initial = encoder.encode([
      '# branch.oid (initial)',
      '# branch.head main',
      '',
    ].join('\0'));
    const detached = encoder.encode([
      `# branch.oid ${'b'.repeat(40)}`,
      '# branch.head (detached)',
      '',
    ].join('\0'));

    expect(parseStatusV2(initial, 1).branch).toEqual({
      headName: 'main',
      ahead: 0,
      behind: 0,
    });
    expect(parseStatusV2(detached, 1).branch).toEqual({
      headOid: 'b'.repeat(40),
      ahead: 0,
      behind: 0,
    });
  });

  test('accepts only ordinary XY combinations valid for type 1 records', () => {
    const records = ['.M', '.A', 'M.', 'TT', 'AD', 'D.'];
    const bytes = encoder.encode([
      ...records.map((xy, index) => `1 ${xy} N... 100644 100644 100644 ${oid} ${oid} file-${index}`),
      '',
    ].join('\0'));

    expect(parseStatusV2(bytes, 1).changes.map((change) => [change.index, change.worktree])).toEqual([
      ['unchanged', 'modified'],
      ['unchanged', 'added'],
      ['modified', 'unchanged'],
      ['modified', 'modified'],
      ['added', 'deleted'],
      ['deleted', 'unchanged'],
    ]);
  });

  test.each(['..', '?.', '!.', 'R.', 'C.', 'U.', '.R', '.C', '.U', '.?', '.!', 'DM', 'DT', 'DD'])
  ('rejects impossible ordinary type 1 XY %s', (xy) => {
    const bytes = encoder.encode(`1 ${xy} N... 100644 100644 100644 ${oid} ${oid} malformed.txt\0`);

    parserError(() => parseStatusV2(bytes, 0));
  });

  test('accepts only valid type 2 rename and copy XY/score boundaries', () => {
    const bytes = encoder.encode([
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R52 renamed.txt`,
      'old-renamed.txt',
      `2 CT N... 100644 100644 100644 ${oid} ${oid} C0 copied.txt`,
      'old-copied.txt',
      '',
    ].join('\0'));

    expect(parseStatusV2(bytes, 0).changes).toMatchObject([
      { path: 'renamed.txt', originalPath: 'old-renamed.txt', index: 'renamed', worktree: 'unchanged' },
      { path: 'copied.txt', originalPath: 'old-copied.txt', index: 'copied', worktree: 'modified' },
    ]);
  });

  test.each([
    ['M.', 'R001'],
    ['R?', 'R001'],
    ['R.', 'C001'],
    ['R.', 'R00'],
    ['R.', 'R001'],
    ['C.', 'C00'],
    ['R.', 'R-1'],
    ['R.', 'R101'],
    ['R.', 'Rabc'],
  ])('rejects invalid type 2 XY/score %s %s', (xy, score) => {
    const bytes = encoder.encode(`2 ${xy} N... 100644 100644 100644 ${oid} ${oid} ${score} new.txt\0old.txt\0`);

    parserError(() => parseStatusV2(bytes, 0));
  });

  test.each(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
  ('accepts the defined unmerged XY combination %s', (xy) => {
    const bytes = encoder.encode(`u ${xy} N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt\0`);

    expect(parseStatusV2(bytes, 0).changes).toMatchObject([
      { path: 'conflict.txt', index: 'unmerged', worktree: 'unmerged' },
    ]);
  });

  test.each(['U.', '.U', 'MM', '??', 'UR'])('rejects invalid unmerged XY combination %s', (xy) => {
    const bytes = encoder.encode(`u ${xy} N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt\0`);

    parserError(() => parseStatusV2(bytes, 0));
  });

  test('rejects invalid generations without guessing', () => {
    for (const generation of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      parserError(() => parseStatusV2(new Uint8Array(), generation));
    }
  });

  test('fails closed for unsupported headers and invalid UTF-8 without leaking output', () => {
    for (const bytes of [
      encoder.encode('# branch.future secret-name\0'),
      Uint8Array.from([0x3f, 0x20, 0xff, 0]),
    ]) {
      parserError(() => parseStatusV2(bytes, 0));
    }
  });

  test('rejects invalid critical record data', () => {
    const invalidRenameScore = encoder.encode(
      `2 RM N... 100644 100644 100644 ${oid} ${oid} R101 new.txt\0old.txt\0`,
    );

    parserError(() => parseStatusV2(invalidRenameScore, 0));
  });

  test('does not turn unknown ordinary records into fatal errors', () => {
    const decoder = new StatusV2Decoder(3);
    decoder.push(encoder.encode('x future extension\0? visible.txt\0'));

    expect(decoder.finish()).toMatchObject({ changes: [{ path: 'visible.txt' }] });
    expect(decoder.diagnostics).toEqual([{ code: 'UNKNOWN_RECORD' }]);
  });

  test.each(['?', '!', '?malformed.txt', '!malformed.txt'])
  ('rejects a malformed dedicated path record %j', (record) => {
    parserError(() => parseStatusV2(encoder.encode(`${record}\0`), 0));
  });

  test('bounds unknown NUL record diagnostics with a controlled error', () => {
    const bytes = encoder.encode('x future\0'.repeat(statusV2Limits.maxDiagnostics + 1));

    parserError(() => parseStatusV2(bytes, 0), 'TOO_LARGE');
  });

  test('rejects a truncated rename and all random fixture truncations with only controlled errors', () => {
    const rename = encoder.encode(`2 RM N... 100644 100644 100644 ${oid} ${oid} R100 new.txt\0`);
    parserError(() => parseStatusV2(rename, 0));

    const bytes = fixture();
    for (let end = 0; end < bytes.length; end += Math.max(1, Math.floor(bytes.length / 11))) {
      try {
        parseStatusV2(bytes.subarray(0, end), 0);
      } catch (error) {
        expect(error).toBeInstanceOf(GitWorkbenchError);
        expect((error as GitWorkbenchError).payload.code).toBe('PARSER_UNSUPPORTED');
      }
    }
  });
});

describe('StatusV2Decoder', () => {
  test('incrementally accepts arbitrary chunk boundaries, including a rename old path', () => {
    const bytes = fixture();
    const decoder = new StatusV2Decoder(7);
    for (let index = 0; index < bytes.length; index += 3) {
      decoder.push(bytes.subarray(index, index + 3));
    }

    expect(decoder.finish()).toEqual(parseStatusV2(bytes, 7));
  });

  test('rejects repeated finish and pushes after finish in a controlled way', () => {
    const decoder = new StatusV2Decoder(0);
    decoder.finish();
    parserError(() => decoder.finish());
    parserError(() => decoder.push(encoder.encode('? later.txt\0')));
  });

  test('bounds a million-byte unterminated record streamed in small chunks', () => {
    const decoder = new StatusV2Decoder(0);
    const source = new Uint8Array(statusV2Limits.maxRecordBytes + 1).fill(0x61);

    parserError(() => {
      for (let index = 0; index < source.length; index += 4096) {
        decoder.push(source.subarray(index, index + 4096));
      }
    }, 'TOO_LARGE');
  });
});
