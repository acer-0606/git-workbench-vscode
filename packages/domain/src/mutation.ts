import type { CommonRepositoryId, OperationId, RepositoryId } from './ids.js';
import type { VersionVector } from './versionVector.js';

/**
 * The closed set of Phase 2 write intents. UI submits one of these; anything
 * else (free-form args, force flags, reset/rebase/hunk intents) is rejected
 * by construction because it is not representable here.
 */
export type MutationIntent =
  | { readonly type: 'stage.files'; readonly paths: readonly string[] }
  | { readonly type: 'unstage.files'; readonly paths: readonly string[] }
  | { readonly type: 'files.delete'; readonly paths: readonly string[] }
  | { readonly type: 'files.ignore'; readonly paths: readonly string[]; readonly target: 'repository' | 'local' }
  | { readonly type: 'commit.create'; readonly message: string }
  | { readonly type: 'commit.amend'; readonly message: string }
  | { readonly type: 'branch.create'; readonly name: string; readonly startPoint: string; readonly switch: boolean }
  | { readonly type: 'branch.switch'; readonly name: string; readonly dirtyStrategy: 'keep' | 'stash' | 'newWorktree' }
  | { readonly type: 'branch.rename'; readonly oldName: string; readonly newName: string }
  | { readonly type: 'branch.delete'; readonly name: string }
  | { readonly type: 'branch.upstream'; readonly name: string; readonly upstream: string | null }
  | { readonly type: 'stash.create'; readonly message: string; readonly includeUntracked: boolean; readonly keepIndex: boolean; readonly stagedOnly: boolean }
  | { readonly type: 'stash.apply'; readonly selector: string; readonly dropAfterSuccess: boolean }
  | { readonly type: 'stash.drop'; readonly selector: string }
  | { readonly type: 'stash.branch'; readonly selector: string; readonly branchName: string }
  | { readonly type: 'commit.cherryPick'; readonly oids: readonly string[] }
  | { readonly type: 'commit.revert'; readonly oids: readonly string[] }
  | { readonly type: 'partialClone.materialize'; readonly contentToken: string }
  | { readonly type: 'remote.fetch'; readonly remote: string; readonly prune: boolean }
  | { readonly type: 'remote.pull'; readonly remote: string; readonly branch: string; readonly strategy: 'ffOnly' | 'merge' | 'rebase' }
  | { readonly type: 'remote.push'; readonly remote: string; readonly localRef: string; readonly remoteRef: string };

export interface MutationPlan {
  readonly operationId: OperationId;
  readonly repositoryId: RepositoryId;
  readonly commonRepositoryId: CommonRepositoryId;
  readonly intent: MutationIntent;
  readonly baseline: VersionVector;
  readonly summary: string;
  readonly effects: readonly string[];
  readonly risk: 'normal' | 'confirmation';
  /** SHA-256 over the canonical JSON of the effective settings, capability snapshot and safety policy this plan was built against. */
  readonly configFingerprint: string;
  /** SHA-256 over the whole plan including configFingerprint; the confirmation token binds to this. */
  readonly planDigest: string;
}

export interface MutationConfirmation {
  readonly operationId: string;
  readonly planDigest: string;
}
