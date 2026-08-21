import { createHash } from 'node:crypto';

import { GitWorkbenchError } from '@git-workbench/domain';

import type { RawFilePatch, RawHunk, RawLine, RawUnifiedDiff } from './patchBuilder.js';
import type { GitProcessRunner } from './process.js';

const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const fileHeaderPattern = /^diff --git a\/(.+) b\/(.+)$/;
const parserFailure = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'PARSER_UNSUPPORTED', message, repositoryChanged: false, retry: 'none' });

/**
 * Parses a raw `git diff --binary --full-index --no-ext-diff --no-textconv
 * --unified=3` stream into files, hunks and stable per-line ids. Any
 * structural anomaly — missing headers, out-of-range hunks, truncated
 * input — is a parser failure; the parser never guesses.
 */
export function parseRawUnifiedDiff(bytes: Uint8Array): RawUnifiedDiff {
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split('\n');
  const files: RawFilePatch[] = [];
  let currentFile: { path: string; header: string[]; hunks: RawHunk[]; fullLines: string[] } | undefined;
  let currentHunk: { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: RawLine[]; oldLine: number; newLine: number } | undefined;
  let binary = false;
  let lineCounter = 0;
  let hunkCounter = 0;

  const closeHunk = (): void => {
    if (!currentFile || !currentHunk) return;
    if (currentHunk.lines.length === 0) throw parserFailure('空 Hunk');
    currentFile.hunks.push({
      id: `h${hunkCounter++}`,
      header: currentHunk.header,
      oldStart: currentHunk.oldStart,
      oldLines: currentHunk.oldLines,
      newStart: currentHunk.newStart,
      newLines: currentHunk.newLines,
      lines: currentHunk.lines,
    });
    currentHunk = undefined;
  };
  const closeFile = (): void => {
    closeHunk();
    if (!currentFile) return;
    const fullText = `${currentFile.fullLines.join('\n')}\n`;
    files.push({
      path: currentFile.path,
      header: currentFile.header,
      fullPatchBytes: Buffer.from(fullText, 'utf8'),
      lineSelectionAllowed: !binary && currentFile.hunks.length > 0,
      oldLineCount: currentFile.hunks.reduce((sum, hunk) => sum + hunk.oldLines, 0),
      newLineCount: currentFile.hunks.reduce((sum, hunk) => sum + hunk.newLines, 0),
      hunks: currentFile.hunks,
    });
    currentFile = undefined;
    binary = false;
  };

  for (const line of lines) {
    const fileMatch = fileHeaderPattern.exec(line);
    if (fileMatch) {
      closeFile();
      const left = fileMatch[1] ?? '';
      const right = fileMatch[2] ?? '';
      if (left !== right) throw parserFailure('rename 头部需单独处理');
      currentFile = { path: left, header: [line], hunks: [], fullLines: [line] };
      continue;
    }
    if (!currentFile) {
      if (line.trim() === '') continue;
      throw parserFailure('diff 头部缺失');
    }
    if (line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('deleted file') || line.startsWith('new file') || line.startsWith('GIT binary patch') || line.startsWith('Binary files')) {
      if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) binary = true;
      currentFile.header.push(line);
      currentFile.fullLines.push(line);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      currentFile.header.push(line);
      currentFile.fullLines.push(line);
      continue;
    }
    const hunkMatch = hunkPattern.exec(line);
    if (hunkMatch) {
      closeHunk();
      currentHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
        oldLine: Number(hunkMatch[1]),
        newLine: Number(hunkMatch[3]),
      };
      currentFile.fullLines.push(line);
      continue;
    }
    if (currentHunk) {
      if (line === '') {
        // The final newline of the diff stream: close the open hunk.
        closeHunk();
        continue;
      }
      const marker = line[0];
      const body = line.slice(1);
      if (marker === '\\') {
        currentHunk.lines.push({ id: `l${lineCounter++}`, marker: '\\', text: body });
      } else if (marker === '+') {
        currentHunk.lines.push({ id: `l${lineCounter++}`, marker: '+', text: body, newLine: currentHunk.newLine++ });
      } else if (marker === '-') {
        currentHunk.lines.push({ id: `l${lineCounter++}`, marker: '-', text: body, oldLine: currentHunk.oldLine++ });
      } else if (marker === ' ') {
        currentHunk.lines.push({ id: `l${lineCounter++}`, marker: ' ', text: body, oldLine: currentHunk.oldLine++, newLine: currentHunk.newLine++ });
      } else {
        throw parserFailure(`无法识别的 Hunk 行：${line.slice(0, 40)}`);
      }
      currentFile.fullLines.push(line);
      continue;
    }
    if (binary && line.trim() !== '') {
      currentFile.fullLines.push(line);
      continue;
    }
    if (line.trim() === '') continue;
    throw parserFailure(`diff 结构外的行：${line.slice(0, 40)}`);
  }
  closeFile();
  return { files };
}

export interface RawDiffSnapshot {
  readonly diff: RawUnifiedDiff;
  readonly digest: string;
}

/** Runs the fixed raw-diff command and returns the parsed diff with its digest. */
export async function readRawDiff(provider: { runner: GitProcessRunner; cwd: string }, endpoints: readonly string[]): Promise<RawDiffSnapshot> {
  const result = await provider.runner.run({
    args: ['--literal-pathspecs', '-c', 'core.safecrlf=false', 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--unified=3', ...endpoints],
    cwd: provider.cwd,
    kind: 'query',
    maxStdoutBytes: 64 * 1024 * 1024,
    maxStderrBytes: 256 * 1024,
  });
  if (result.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `raw diff 失败：${result.stderrText().trim()}`, repositoryChanged: false, retry: 'refresh' });
  return { diff: parseRawUnifiedDiff(result.stdout), digest: createHash('sha256').update(result.stdout).digest('hex') };
}
