import type { GitRunResult, MutationProfile } from './process.js';

export type { MutationProfile } from './process.js';
export type GitFailureClass = 'authCancelled' | 'offline' | 'timeout' | 'remoteRejected';

export interface QueryGitProvider {
  readonly cwd: string;
  query(args: readonly string[], stdin?: Uint8Array, signal?: AbortSignal): Promise<GitRunResult>;
}

export interface MutationGitProvider extends QueryGitProvider {
  mutate(
    args: readonly string[],
    stdin?: Uint8Array,
    profile?: MutationProfile,
  ): Promise<GitRunResult & { readonly outcome: 'known' | 'unknown'; readonly failureClass?: GitFailureClass }>;
  resolve(ref: string): Promise<string>;
}

export class GitCommandFailure extends Error {
  constructor(readonly exitCode: number, readonly stderr: Uint8Array) {
    super(`Git command failed with exit code ${exitCode}`);
    this.name = 'GitCommandFailure';
  }
}
