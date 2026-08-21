import { GitWorkbenchError } from '@git-workbench/domain';

export interface WorkspaceEditLike {
  readonly entries: readonly { readonly uri: string; readonly range: { readonly start: number; readonly end: number }; readonly newText: string }[];
  perform(apply: (entry: { uri: string; range: { start: number; end: number }; newText: string }) => Promise<void>): Promise<void>;
}

export interface OpenDocument {
  readonly uri: string;
  readonly version: number;
  readonly dirty: boolean;
}

/**
 * Minimal-edit adapter for applying a selected patch to a DIRTY editor: the
 * patch must never clobber unsaved buffer content. The adapter converts the
 * patch into line-range edits against the CURRENT document version and
 * refuses (rather than saves) when the buffer is dirty — the user saves
 * first, exactly like text-conflict resolution.
 */
export function planWorkspaceEdit(input: {
  readonly document: OpenDocument;
  readonly currentText: string;
  readonly patchedText: string;
}): WorkspaceEditLike {
  if (input.document.dirty) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '文档有未保存修改，请先保存后再应用 Patch', repositoryChanged: false, retry: 'none' });
  }
  const currentLines = input.currentText.split('\n');
  const patchedLines = input.patchedText.split('\n');
  const entries: WorkspaceEditLike['entries'][number][] = [];
  let index = 0;
  while (index < currentLines.length || index < patchedLines.length) {
    if (currentLines[index] === patchedLines[index]) {
      index += 1;
      continue;
    }
    // One contiguous replace block per diverging region.
    let end = index;
    while (end < currentLines.length && end < patchedLines.length && currentLines[end] !== patchedLines[end]) end += 1;
    if (end === index) end = index + 1;
    const newEnd = Math.min(end, patchedLines.length);
    entries.push({
      uri: input.document.uri,
      range: { start: index, end: Math.min(end, currentLines.length) },
      newText: patchedLines.slice(index, newEnd).join('\n'),
    });
    index = Math.max(end, newEnd);
  }
  return {
    entries,
    async perform(apply) {
      // Edits apply bottom-up so earlier ranges stay valid.
      for (const entry of [...entries].sort((left, right) => right.range.start - left.range.start)) {
        await apply(entry);
      }
    },
  };
}
