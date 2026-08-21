import type { GitProcessRunner } from './process.js';

export interface CommitRow { readonly oid: string; readonly parents: readonly string[]; readonly author: string; readonly authoredAt: number; readonly subject: string }

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const orderArg = { topo: '--topo-order', date: '--date-order', authorDate: '--author-date-order' } as const;

export function parseLogRecords(bytes: Uint8Array): CommitRow[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text.split('\0\0\n').filter(Boolean).map((record) => {
    const fields = record.split('\0');
    if (fields.length !== 5) throw new Error('invalid log record');
    const [oid = '', parents = '', author = '', authoredAt = '0', subject = ''] = fields;
    const parentOids = parents ? parents.split(' ') : [];
    if (!oidPattern.test(oid) || parentOids.some((parent) => !oidPattern.test(parent)) || !/^\d+$/.test(authoredAt)) throw new Error('invalid log identity');
    return { oid, parents: parentOids, author, authoredAt: Number(authoredAt), subject };
  });
}

const encodeCursor = (generation: number, offset: number): string => Buffer.from(JSON.stringify({ generation, offset }), 'utf8').toString('base64url');
const decodeCursor = (cursor: string | undefined, generation: number): number => {
  if (!cursor) return 0;
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid log cursor');
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { generation?: unknown; offset?: unknown };
  if (value.generation !== generation || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error('stale or invalid log cursor');
  return value.offset;
};

export async function readLogPage(
  runner: GitProcessRunner,
  cwd: string,
  generation: number,
  order: keyof typeof orderArg,
  limit: number,
  cursor?: string,
): Promise<{ rows: CommitRow[]; nextCursor?: string }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid log page size');
  const offset = decodeCursor(cursor, generation);
  const args = [
    '-c', 'i18n.logOutputEncoding=UTF-8',
    'log', '--exclude=refs/git-workbench/*', '--all', orderArg[order],
    `--skip=${offset}`, `--max-count=${limit + 1}`,
    '--format=tformat:%H%x00%P%x00%an%x00%at%x00%s%x00%x00',
  ];
  const result = await runner.run({ args, cwd, kind: 'query', maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(`git log failed: ${result.stderrText()}`);
  const rows = parseLogRecords(result.stdout);
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return hasMore ? { rows: visible, nextCursor: encodeCursor(generation, offset + visible.length) } : { rows: visible };
}
