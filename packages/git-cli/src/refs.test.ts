import { describe, expect, it } from 'vitest';

import { parseForEachRef, parseStashReflog, parseWorktreeList } from './refs.js';

const record = (...fields: string[]): Buffer => Buffer.from(`${fields.join('\0')}\n`);

describe('parseForEachRef', () => {
  it('keeps branches, remotes and tags with display names and HEAD marker', () => {
    const headOid = 'a'.repeat(40);
    const otherOid = 'b'.repeat(40);
    const tagOid = 'c'.repeat(40);
    const bytes = Buffer.concat([
      record('refs/heads/main', headOid, 'commit', 'refs/remotes/origin/main', '*'),
      record('refs/heads/feature/主题', otherOid, 'commit', '', ''),
      record('refs/remotes/origin/main', otherOid, 'commit', '', ''),
      record('refs/tags/v1.0', tagOid, 'commit', '', ''),
    ]);
    expect(parseForEachRef(bytes)).toEqual([
      { kind: 'branch', fullName: 'refs/heads/main', displayName: 'main', oid: headOid, upstream: 'refs/remotes/origin/main', isHead: true },
      { kind: 'branch', fullName: 'refs/heads/feature/主题', displayName: 'feature/主题', oid: otherOid },
      { kind: 'remoteBranch', fullName: 'refs/remotes/origin/main', displayName: 'origin/main', oid: otherOid },
      { kind: 'tag', fullName: 'refs/tags/v1.0', displayName: 'v1.0', oid: tagOid },
    ]);
  });

  it('ignores internal and unexpected ref namespaces', () => {
    const oid = 'a'.repeat(40);
    const bytes = Buffer.concat([
      record('refs/git-workbench/checkpoint', oid, 'commit', '', ''),
      record('refs/stash', oid, 'commit', '', ''),
      record('refs/notes/commits', oid, 'commit', '', ''),
      record('refs/heads/kept', oid, 'commit', '', ''),
    ]);
    expect(parseForEachRef(bytes).map((ref) => ref.fullName)).toEqual(['refs/heads/kept']);
  });

  it('rejects records that do not carry five fields', () => {
    expect(() => parseForEachRef(Buffer.from(`${['refs/heads/main', 'a'.repeat(40)].join('\0')}\0`))).toThrow('invalid ref record');
  });
});

describe('parseStashReflog', () => {
  it('maps reflog lines to indexed stash entries', () => {
    const oid = 'a'.repeat(40);
    const text = `${oid}\tWIP on main: ${'b'.repeat(7)} base\n${'c'.repeat(40)}\tOn main: fix\n`;
    expect(parseStashReflog(text)).toEqual([
      { index: 0, oid, subject: `WIP on main: ${'b'.repeat(7)} base` },
      { index: 1, oid: 'c'.repeat(40), subject: 'On main: fix' },
    ]);
  });

  it('ignores blank lines and rejects malformed ones', () => {
    expect(parseStashReflog('\n')).toEqual([]);
    expect(() => parseStashReflog('no-oid\tsubject\n')).toThrow('invalid stash reflog line');
  });
});

describe('parseWorktreeList', () => {
  it('parses porcelain records with branch, bare and locked state', () => {
    const oid = 'a'.repeat(40);
    const bytes = Buffer.concat([
      Buffer.from(`worktree /repo/main\0HEAD ${oid}\0branch refs/heads/main\0\0`),
      Buffer.from(`worktree /repo/feature\0HEAD ${'b'.repeat(40)}\0detached\0\0`),
      Buffer.from(`worktree /repo/bare\0bare\0\0`),
      Buffer.from(`worktree /repo/locked\0HEAD ${oid}\0branch refs/heads/locked\0locked\0\0`),
    ]);
    expect(parseWorktreeList(bytes)).toEqual([
      { path: '/repo/main', headOid: oid, branch: 'refs/heads/main', bare: false, detached: false, locked: false },
      { path: '/repo/feature', headOid: 'b'.repeat(40), bare: false, detached: true, locked: false },
      { path: '/repo/bare', bare: true, detached: false, locked: false },
      { path: '/repo/locked', headOid: oid, branch: 'refs/heads/locked', bare: false, detached: false, locked: true },
    ]);
  });
});
