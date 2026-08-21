import type { ObjectId, RepoRelativePath } from './ids.js';

export type EndpointKind = 'commit' | 'branch' | 'tag' | 'stash' | 'head' | 'index' | 'workingTree';
export type CompareMode = 'auto' | 'direct' | 'mergeBase';
export type EffectiveCompareMode = Exclude<CompareMode, 'auto'>;
export type IgnoreWhitespace = 'none' | 'eol' | 'all';

export interface CompareEndpoint {
  readonly kind: EndpointKind;
  readonly value: string;
  readonly label: string;
  readonly resolvedOid?: ObjectId;
}

export interface DiffFile {
  readonly path: RepoRelativePath;
  readonly originalPath?: RepoRelativePath;
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'U';
  readonly binary: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffLine {
  readonly kind: 'context' | 'addition' | 'deletion' | 'noNewline';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export function effectiveCompareMode(mode: CompareMode, left: CompareEndpoint, right: CompareEndpoint): EffectiveCompareMode {
  return mode === 'auto' ? (left.kind === 'branch' && right.kind === 'branch' ? 'mergeBase' : 'direct') : mode;
}
