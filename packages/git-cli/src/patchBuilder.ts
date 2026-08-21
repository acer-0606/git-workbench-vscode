import { GitWorkbenchError, type PatchSelectionItem } from '@git-workbench/domain';

export interface RawLine { readonly id: string; readonly marker: ' ' | '+' | '-' | '\\'; readonly text: string; readonly oldLine?: number; readonly newLine?: number }
export interface RawHunk { readonly id: string; readonly header: string; readonly oldStart: number; readonly oldLines: number; readonly newStart: number; readonly newLines: number; readonly lines: readonly RawLine[] }
export interface RawFilePatch { readonly path: string; readonly header: readonly string[]; readonly fullPatchBytes: Uint8Array; readonly lineSelectionAllowed: boolean; readonly oldLineCount: number; readonly newLineCount: number; readonly hunks: readonly RawHunk[] }
export interface RawUnifiedDiff { readonly files: readonly RawFilePatch[] }
export interface BuiltPatch { readonly bytes: Uint8Array; readonly contextLines: number; toString(encoding: BufferEncoding): string }

interface HunkChoice { readonly all: boolean; readonly lineIds: ReadonlySet<string> }
interface FileChoice { all: boolean; readonly hunks: Map<string, HunkChoice> }

const selectionError = (message: string): GitWorkbenchError => new GitWorkbenchError({ code: 'INVALID_INPUT', message, repositoryChanged: false, retry: 'refresh' });
const unsafeLineSelection = (message: string): GitWorkbenchError => new GitWorkbenchError({ code: 'UNSAFE_LINE_SELECTION', message, repositoryChanged: false, retry: 'refresh' });

function indexSelection(selection: readonly PatchSelectionItem[]): Map<string, FileChoice> {
  const result = new Map<string, FileChoice>();
  for (const item of selection) {
    const file = result.get(item.path) ?? { all: false, hunks: new Map<string, HunkChoice>() };
    if (item.kind === 'file') file.all = true;
    else if (item.kind === 'hunk') file.hunks.set(item.rawHunkId, { all: true, lineIds: new Set() });
    else file.hunks.set(item.rawHunkId, { all: false, lineIds: new Set(item.lineIds) });
    result.set(item.path, file);
  }
  return result;
}

function selectAndRecount(file: RawFilePatch, hunk: RawHunk, choice: HunkChoice, selectedNewStart: number): { readonly header: string; readonly lines: readonly RawLine[]; readonly oldLines: number; readonly newLines: number; readonly contextLines: number } {
  if (!choice.all && !file.lineSelectionAllowed) throw unsafeLineSelection('该文件类型只能选择完整 Hunk 或文件');
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
  if (!range || Number(range[1]) !== hunk.oldStart || Number(range[2] ?? 1) !== hunk.oldLines || Number(range[3]) !== hunk.newStart || Number(range[4] ?? 1) !== hunk.newLines) throw selectionError('Raw Hunk 身份不一致');
  const availableChangeIds = new Set(hunk.lines.filter((line) => line.marker === '+' || line.marker === '-').map((line) => line.id));
  if ([...choice.lineIds].some((id) => !availableChangeIds.has(id))) throw selectionError('选择包含未知行');
  const lines: RawLine[] = [];
  let keptChange = false;
  let previousKept = false;
  for (const line of hunk.lines) {
    if (line.marker === '\\') {
      if (previousKept) lines.push(line);
      continue;
    }
    if (line.marker === ' ') {
      lines.push(line);
      previousKept = true;
      continue;
    }
    const selected = choice.all || choice.lineIds.has(line.id);
    if (line.marker === '+' && !selected) {
      previousKept = false;
      continue;
    }
    if (line.marker === '-' && !selected) {
      lines.push({ ...line, marker: ' ' });
      previousKept = true;
      continue;
    }
    lines.push(line);
    keptChange = true;
    previousKept = true;
  }
  if (!keptChange) throw selectionError('选择未产生任何变更');
  const oldLines = lines.filter((line) => line.marker === ' ' || line.marker === '-').length;
  const newLines = lines.filter((line) => line.marker === ' ' || line.marker === '+').length;
  const firstChange = lines.findIndex((line) => line.marker === '+' || line.marker === '-');
  let lastChange = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.marker === '+' || lines[index]?.marker === '-') {
      lastChange = index;
      break;
    }
  }
  const leadingContext = lines.slice(0, firstChange).filter((line) => line.marker === ' ').length;
  const trailingContext = lines.slice(lastChange + 1).filter((line) => line.marker === ' ').length;
  if (!choice.all) {
    const touchesStart = hunk.oldStart <= 1;
    const touchesEnd = hunk.oldStart + hunk.oldLines - 1 >= file.oldLineCount;
    if ((leadingContext < 3 && !touchesStart) || (trailingContext < 3 && !touchesEnd) || leadingContext + trailingContext === 0) {
      throw unsafeLineSelection('所选行无法形成有安全上下文的 Patch，请选择完整 Hunk');
    }
  }
  const contextLines = Math.min(leadingContext, trailingContext);
  const suffix = hunk.header.slice(range[0].length);
  return { header: `@@ -${hunk.oldStart},${oldLines} +${selectedNewStart},${newLines} @@${suffix}`, lines, oldLines, newLines, contextLines };
}

/**
 * Maps a raw-diff selection to a minimal unified patch with the raw diff's
 * original context: unselected additions drop out, unselected deletions
 * become context lines, and later hunks' new-start offsets accumulate the
 * deltas of earlier selected hunks.
 */
export function buildSelectedPatch(raw: RawUnifiedDiff, selection: readonly PatchSelectionItem[]): BuiltPatch {
  const selected = indexSelection(selection);
  const parts: Buffer[] = [];
  let minimumContext = Number.POSITIVE_INFINITY;
  for (const file of raw.files) {
    const fileSelection = selected.get(file.path);
    if (!fileSelection) continue;
    if (fileSelection.all) {
      if (!file.fullPatchBytes.byteLength) throw selectionError('完整文件 Patch 缺失');
      parts.push(Buffer.from(file.fullPatchBytes));
      selected.delete(file.path);
      continue;
    }
    const output: string[] = [...file.header];
    let selectedDelta = 0;
    let selectedHunks = 0;
    for (const hunk of file.hunks) {
      const choice = fileSelection.hunks.get(hunk.id);
      if (!choice) continue;
      const normalized = selectAndRecount(file, hunk, choice, hunk.oldStart + selectedDelta);
      minimumContext = Math.min(minimumContext, normalized.contextLines);
      output.push(normalized.header, ...normalized.lines.map((line) => `${line.marker}${line.text}`));
      selectedDelta += normalized.newLines - normalized.oldLines;
      selectedHunks += 1;
      fileSelection.hunks.delete(hunk.id);
    }
    if (fileSelection.hunks.size > 0) throw selectionError('选择包含未知 Hunk');
    if (!selectedHunks) throw selectionError('选择未产生文件 Patch');
    parts.push(Buffer.from(`${output.join('\n')}\n`, 'utf8'));
    selected.delete(file.path);
  }
  if (selected.size > 0) throw selectionError('选择包含未知文件');
  if (!parts.length) throw selectionError('选择未产生 Patch');
  const bytes = Buffer.concat(parts);
  return { bytes, contextLines: Number.isFinite(minimumContext) ? minimumContext : 0, toString: (encoding) => Buffer.from(bytes).toString(encoding) };
}
