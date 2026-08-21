import type { GitProcessRunner } from './process.js';

export type RefKind = 'branch' | 'remoteBranch' | 'tag';

export interface RefRecord {
  readonly kind: RefKind;
  readonly fullName: string;
  readonly displayName: string;
  readonly oid: string;
  readonly upstream?: string;
  readonly isHead?: boolean;
}

export interface StashRecord { readonly index: number; readonly oid: string; readonly subject: string }

export interface WorktreeRecord {
  readonly path: string;
  readonly headOid?: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
}

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function classify(fullName: string): RefKind | undefined {
  if (fullName.startsWith('refs/heads/')) return 'branch';
  if (fullName.startsWith('refs/remotes/') && !fullName.endsWith('/HEAD')) return 'remoteBranch';
  if (fullName.startsWith('refs/tags/')) return 'tag';
  return undefined;
}

const displayNameFor = (kind: RefKind, fullName: string): string =>
  kind === 'branch' ? fullName.slice('refs/heads/'.length)
    : kind === 'remoteBranch' ? fullName.slice('refs/remotes/'.length)
      : fullName.slice('refs/tags/'.length);

/**
 * Parses `for-each-ref` output where records are newline-terminated (ref
 * names cannot contain control characters) and the five format fields are
 * separated by literal NUL bytes. Only branch, remote branch and tag refs
 * survive; internal `refs/git-workbench/**` never does.
 */
export function parseForEachRef(bytes: Uint8Array): RefRecord[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const refs: RefRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split('\0');
    if (fields.length !== 5) throw new Error('invalid ref record');
    const [fullName = '', oid = '', , upstream = '', headMarker = ''] = fields;
    if (!oidPattern.test(oid)) throw new Error('invalid ref record');
    const kind = classify(fullName);
    if (!kind) continue;
    refs.push({
      kind,
      fullName,
      displayName: displayNameFor(kind, fullName),
      oid,
      ...(upstream ? { upstream } : {}),
      ...(headMarker === '*' ? { isHead: true } : {}),
    });
  }
  return refs;
}

export async function readRefs(runner: GitProcessRunner, cwd: string): Promise<readonly RefRecord[]> {
  const result = await runner.run({
    args: [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00%(HEAD)',
      'refs/heads', 'refs/remotes', 'refs/tags',
    ],
    cwd,
    kind: 'query',
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(`git for-each-ref failed: ${result.stderrText()}`);
  return parseForEachRef(result.stdout);
}

export function parseStashReflog(text: string): StashRecord[] {
  const records: StashRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [oid = '', subject = ''] = line.split('\t');
    if (!oidPattern.test(oid) || subject === '') throw new Error('invalid stash reflog line');
    records.push({ index: records.length, oid, subject });
  }
  return records;
}

export async function readStashes(runner: GitProcessRunner, cwd: string): Promise<readonly StashRecord[]> {
  const result = await runner.run({
    args: ['-c', 'i18n.logOutputEncoding=UTF-8', 'reflog', 'show', '--format=%H%x00%gs', 'refs/stash'],
    cwd,
    kind: 'query',
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) {
    // An empty reflog exits non-zero with "unknown revision"; that simply means no stashes exist.
    if (result.stderrText().includes('refs/stash')) return [];
    throw new Error(`git reflog failed: ${result.stderrText()}`);
  }
  return parseStashReflog(result.stdoutText().replace(/\x00/g, '\t'));
}

/**
 * Parses `worktree list --porcelain -z`: lines inside a record are NUL
 * terminated and each record ends with a second NUL.
 */
export function parseWorktreeList(bytes: Uint8Array): WorktreeRecord[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const records: WorktreeRecord[] = [];
  for (const block of text.split('\0\0')) {
    if (!block.trim()) continue;
    const record: { path?: string; headOid?: string; branch?: string; bare: boolean; detached: boolean; locked: boolean } = { bare: false, detached: false, locked: false };
    for (const line of block.split('\0')) {
      if (!line) continue;
      if (line.startsWith('worktree ')) record.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) record.headOid = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) record.branch = line.slice('branch '.length);
      else if (line.startsWith('branch ')) record.branch = line.slice('branch '.length);
      else if (line === 'bare') record.bare = true;
      else if (line === 'detached') record.detached = true;
      else if (line === 'locked') record.locked = true;
    }
    if (!record.path) throw new Error('invalid worktree record');
    records.push({
      path: record.path,
      ...(record.headOid ? { headOid: record.headOid } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      bare: record.bare,
      detached: record.detached,
      locked: record.locked,
    });
  }
  return records;
}

export async function readWorktrees(runner: GitProcessRunner, cwd: string): Promise<readonly WorktreeRecord[]> {
  const result = await runner.run({
    args: ['worktree', 'list', '--porcelain', '-z'],
    cwd,
    kind: 'query',
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(`git worktree list failed: ${result.stderrText()}`);
  return parseWorktreeList(result.stdout);
}
