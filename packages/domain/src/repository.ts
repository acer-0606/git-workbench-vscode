import type {
  CommonRepositoryId,
  ObjectId,
  RepoRelativePath,
  RepositoryId,
} from './ids.js';

export type RepositoryMode = 'readWrite' | 'compatibilityReadOnly';

export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked'
  | 'ignored';

export interface RepositoryDescriptor {
  readonly id: RepositoryId;
  readonly commonRepositoryId: CommonRepositoryId;
  readonly worktreeUri: string;
  readonly commonDirUri: string;
  readonly mode: RepositoryMode;
  readonly objectFormat: 'sha1' | 'sha256';
}

export interface BranchState {
  readonly headName?: string;
  readonly headOid?: ObjectId;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface WorkingTreeChange {
  readonly path: RepoRelativePath;
  readonly originalPath?: RepoRelativePath;
  readonly index: ChangeKind | 'unchanged';
  readonly worktree: ChangeKind | 'unchanged';
  readonly submodule: boolean;
}

export interface RepositoryStatus {
  readonly branch: BranchState;
  readonly changes: readonly WorkingTreeChange[];
  readonly generation: number;
}
