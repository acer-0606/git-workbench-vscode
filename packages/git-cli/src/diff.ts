import { asObjectId, asRepoRelativePath, effectiveCompareMode, GitWorkbenchError, type CompareEndpoint, type CompareMode, type DiffFile, type DiffHunk, type DiffLine, type EffectiveCompareMode, type IgnoreWhitespace } from '@git-workbench/domain';

import type { GitProcessRunner } from './process.js';

export interface ComparisonPlan {
  readonly left: CompareEndpoint;
  readonly right: CompareEndpoint;
  readonly effectiveMode: EffectiveCompareMode;
  readonly baseArgs: readonly string[];
  readonly empty: boolean;
  readonly generation: number;
}

export const whitespaceArgs = (mode: IgnoreWhitespace): readonly string[] =>
  mode === 'eol' ? ['--ignore-space-at-eol'] : mode === 'all' ? ['--ignore-all-space'] : [];

const withResolvedOid = (endpoint: CompareEndpoint, oid: string | undefined): CompareEndpoint => oid ? { ...endpoint, resolvedOid: asObjectId(oid) } : endpoint;

const parseSingleOid = (bytes: Uint8Array): string => {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\r?\n$/.exec(value);
  if (!match?.[1]) throw new Error('invalid single OID output');
  return match[1];
};

export async function resolveRevision(runner: GitProcessRunner, cwd: string, endpoint: CompareEndpoint): Promise<string | undefined> {
  if (endpoint.kind === 'workingTree' || endpoint.kind === 'index') return undefined;
  const value = endpoint.kind === 'head' ? 'HEAD' : endpoint.value;
  const result = await runner.run({ args: ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `unresolvable endpoint: ${endpoint.label}`, repositoryChanged: false, retry: 'none' });
  return parseSingleOid(result.stdout);
}

function directDiffArgs(left: CompareEndpoint, right: CompareEndpoint, leftOid: string | undefined, rightOid: string | undefined): { readonly baseArgs: readonly string[]; readonly empty: boolean } {
  if (leftOid && rightOid) return { baseArgs: [leftOid, rightOid], empty: leftOid === rightOid };
  if (left.kind === right.kind && (left.kind === 'index' || left.kind === 'workingTree')) return { baseArgs: [], empty: true };
  if (leftOid && right.kind === 'workingTree') return { baseArgs: [leftOid], empty: false };
  if (left.kind === 'workingTree' && rightOid) return { baseArgs: ['--reverse', rightOid], empty: false };
  if (leftOid && right.kind === 'index') return { baseArgs: ['--cached', leftOid], empty: false };
  if (left.kind === 'index' && rightOid) return { baseArgs: ['--cached', '--reverse', rightOid], empty: false };
  if (left.kind === 'index' && right.kind === 'workingTree') return { baseArgs: [], empty: false };
  if (left.kind === 'workingTree' && right.kind === 'index') return { baseArgs: ['--reverse'], empty: false };
  throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'unsupported endpoint pair', repositoryChanged: false, retry: 'none' });
}

export async function planComparison(provider: { runner: GitProcessRunner; cwd: string }, left: CompareEndpoint, right: CompareEndpoint, mode: CompareMode, generation: number): Promise<ComparisonPlan> {
  const effectiveMode = effectiveCompareMode(mode, left, right);
  const leftOid = await resolveRevision(provider.runner, provider.cwd, left);
  const rightOid = await resolveRevision(provider.runner, provider.cwd, right);
  let command: { readonly baseArgs: readonly string[]; readonly empty: boolean };
  if (effectiveMode === 'mergeBase') {
    if (!leftOid || !rightOid) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'merge-base requires two commit-like endpoints', repositoryChanged: false, retry: 'none' });
    const base = await provider.runner.run({ args: ['merge-base', leftOid, rightOid], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
    if (base.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'merge-base unavailable', repositoryChanged: false, retry: 'none' });
    const baseOid = parseSingleOid(base.stdout);
    command = { baseArgs: [baseOid, rightOid], empty: baseOid === rightOid };
  } else {
    command = directDiffArgs(left, right, leftOid, rightOid);
  }
  return { left: withResolvedOid(left, leftOid), right: withResolvedOid(right, rightOid), effectiveMode, ...command, generation };
}

const rawHeaderPattern = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMRCTXU])(\d*)$/;

interface RawEntry {
  readonly status: DiffFile['status'];
  readonly path: string;
  readonly originalPath?: string;
}

function rawStatus(letter: string | undefined): DiffFile['status'] {
  if (letter === 'T') return 'M';
  if (letter === 'X') return 'U';
  if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'R' || letter === 'C' || letter === 'U') return letter;
  throw new Error('invalid raw diff header');
}

/**
 * Parses `git diff --raw -z` output. Headers carry the file modes, object ids
 * and status; the NUL-terminated paths that follow are ordered original-first
 * for rename/copy entries.
 */
export function parseRawDiff(bytes: Uint8Array): RawEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const tokens = text.split('\0');
  const entries: RawEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (!token.startsWith(':')) throw new Error('invalid raw diff record');
    const match = rawHeaderPattern.exec(token);
    if (!match) throw new Error('invalid raw diff header');
    const letter = rawStatus(match[5]);
    const firstPath = tokens[index + 1];
    if (firstPath === undefined || firstPath === '') throw new Error('missing raw diff path');
    if (letter === 'R' || letter === 'C') {
      const secondPath = tokens[index + 2];
      if (secondPath === undefined || secondPath === '') throw new Error('missing rename destination path');
      entries.push({
        status: letter,
        path: secondPath,
        originalPath: firstPath,
      });
      index += 2;
    } else {
      entries.push({ status: letter, path: firstPath });
      index += 1;
    }
  }
  return entries;
}

interface NumstatEntry { readonly path: string; readonly originalPath?: string; readonly additions: number | null; readonly deletions: number | null }

const numstatPattern = /^(\d+|-)\t(\d+|-)\t(.*)$/;

/**
 * Parses `git diff --numstat -z`. Rename records carry an empty inline path
 * followed by the original and new path as separate NUL fields.
 */
export function parseNumstat(bytes: Uint8Array): NumstatEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const tokens = text.split('\0');
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const match = numstatPattern.exec(token);
    if (!match) throw new Error('invalid numstat record');
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    const inlinePath = match[3] ?? '';
    if (inlinePath === '') {
      const originalPath = tokens[index + 1];
      const path = tokens[index + 2];
      if (!originalPath || path === undefined || path === '') throw new Error('missing numstat rename paths');
      entries.push({ path, originalPath, additions, deletions });
      index += 2;
    } else {
      entries.push({ path: inlinePath, additions, deletions });
      index += 0;
    }
  }
  return entries;
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses a unified diff patch body into hunks with stable per-file hunk ids.
 */
export function parseUnifiedPatch(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] } | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const rawLine of text.split('\n')) {
    const match = hunkHeaderPattern.exec(rawLine);
    if (match) {
      if (current) hunks.push(finalizeHunk(current, hunks.length));
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      current = { header: rawLine, oldStart: oldLine, oldLines: match[2] === undefined ? 1 : Number(match[2]), newStart: newLine, newLines: match[4] === undefined ? 1 : Number(match[4]), lines: [] };
      continue;
    }
    if (!current) continue;
    const marker = rawLine[0];
    const body = rawLine.slice(1);
    if (marker === '\\') {
      current.lines.push({ kind: 'noNewline', text: body });
    } else if (marker === '+') {
      current.lines.push({ kind: 'addition', text: body, ...(newLine > 0 ? { newLine } : {}) });
      newLine += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'deletion', text: body, ...(oldLine > 0 ? { oldLine } : {}) });
      oldLine += 1;
    } else {
      current.lines.push({ kind: 'context', text: body, ...(oldLine > 0 ? { oldLine } : {}), ...(newLine > 0 ? { newLine } : {}) });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (current) hunks.push(finalizeHunk(current, hunks.length));
  return hunks;
}

function finalizeHunk(hunk: { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }, index: number): DiffHunk {
  return { id: `h${index}`, header: hunk.header, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: hunk.lines };
}

export interface ReadComparisonOptions {
  readonly renameDetection: boolean;
  readonly maxFileBytes: number;
}

const tooLarge = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'TOO_LARGE', message, repositoryChanged: false, retry: 'refresh' });

/**
 * Reads the file list of a non-empty comparison plan: raw status and mode
 * records merged with numstat line counts, keyed by the new path.
 */
export async function readComparisonFileList(
  provider: { runner: GitProcessRunner; cwd: string },
  plan: ComparisonPlan,
  options: ReadComparisonOptions,
): Promise<readonly DiffFile[]> {
  if (plan.empty) return [];
  const renameArgs = options.renameDetection ? ['--find-renames'] : ['--no-renames'];
  const [raw, numstat] = await Promise.all([
    provider.runner.run({ args: ['diff', '--raw', '-z', '--no-ext-diff', '--no-textconv', '--full-index', ...renameArgs, ...plan.baseArgs], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 64 * 1024 }),
    provider.runner.run({ args: ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', ...renameArgs, ...plan.baseArgs], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 64 * 1024 }),
  ]);
  if (raw.exitCode !== 0 || numstat.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `diff failed: ${raw.exitCode !== 0 ? raw.stderrText() : numstat.stderrText()}`, repositoryChanged: false, retry: 'none' });
  const stats = new Map(parseNumstat(numstat.stdout).map((entry) => [entry.path, entry] as const));
  return parseRawDiff(raw.stdout).map((entry) => {
    const stat = stats.get(entry.path);
    const binary = stat?.additions === null && stat?.deletions === null;
    return {
      path: asRepoRelativePath(entry.path),
      ...(entry.originalPath ? { originalPath: asRepoRelativePath(entry.originalPath) } : {}),
      status: entry.status,
      binary,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      hunks: [],
    };
  });
}

/**
 * Reads the full patch of one file within a comparison plan. Files over the
 * byte budget fail structurally with TOO_LARGE instead of returning a
 * truncated patch that could be mistaken for the complete diff.
 */
export async function readFilePatch(
  provider: { runner: GitProcessRunner; cwd: string },
  plan: ComparisonPlan,
  path: string,
  ignoreWhitespace: IgnoreWhitespace,
  maxPatchBytes: number,
): Promise<readonly DiffHunk[]> {
  if (plan.empty) return [];
  const result = await provider.runner.run({
    args: ['--literal-pathspecs', 'diff', '--patch', '--no-ext-diff', '--no-textconv', '--full-index', '--unified=3', ...whitespaceArgs(ignoreWhitespace), ...plan.baseArgs, '--', path],
    cwd: provider.cwd,
    kind: 'query',
    maxStdoutBytes: Math.min(maxPatchBytes, 32 * 1024 * 1024),
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `patch query failed: ${result.stderrText()}`, repositoryChanged: false, retry: 'none' });
  if (result.stdoutTruncated || result.stdout.byteLength > maxPatchBytes) throw tooLarge(`patch for ${path} exceeds the configured budget`);
  return parseUnifiedPatch(result.stdoutText());
}
