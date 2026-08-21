import { describe, expect, it } from 'vitest';

import { parseLogRecords } from './log.js';

describe('parseLogRecords', () => {
  it('preserves all parents and commit message text', () => {
    const oid = 'a'.repeat(40);
    const parents = ['b'.repeat(40), 'c'.repeat(40)];
    const bytes = Buffer.from(`${[oid, parents.join(' '), '作者', '1700000000', '主题含控制符\x1f 😀'].join('\0')}\0\0\n`);
    expect(parseLogRecords(bytes)).toEqual([{ oid, parents, author: '作者', authoredAt: 1700000000, subject: '主题含控制符\x1f 😀' }]);
  });

  it('parses multiple records including a root commit', () => {
    const root = '1'.repeat(40);
    const child = '2'.repeat(40);
    const bytes = Buffer.from(`${[child, root, 'A', '1', 'second'].join('\0')}\0\0\n${[root, '', 'A', '0', 'first'].join('\0')}\0\0\n`);
    expect(parseLogRecords(bytes)).toEqual([
      { oid: child, parents: [root], author: 'A', authoredAt: 1, subject: 'second' },
      { oid: root, parents: [], author: 'A', authoredAt: 0, subject: 'first' },
    ]);
  });

  it('rejects records with the wrong field count', () => {
    expect(() => parseLogRecords(Buffer.from(`${['a'.repeat(40), '', 'A', '1'].join('\0')}\0\0\n`))).toThrow('invalid log record');
  });

  it('rejects malformed object ids and timestamps', () => {
    expect(() => parseLogRecords(Buffer.from(`${['not-an-oid', '', 'A', '1', 's'].join('\0')}\0\0\n`))).toThrow('invalid log identity');
    expect(() => parseLogRecords(Buffer.from(`${['a'.repeat(40), 'parent', 'A', '1', 's'].join('\0')}\0\0\n`))).toThrow('invalid log identity');
    expect(() => parseLogRecords(Buffer.from(`${['a'.repeat(40), '', 'A', 'soon', 's'].join('\0')}\0\0\n`))).toThrow('invalid log identity');
  });
});
