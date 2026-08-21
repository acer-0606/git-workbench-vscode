import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const applyFailure = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message, repositoryChanged: true, retry: 'reconcile' });

/**
 * Applies a built patch through a single Git invocation. Index targets use
 * `git apply --cached`, working-tree targets plain `git apply`; the patch
 * always travels as stdin and never carries `--reject`/`--unidiff-zero`.
 */
export async function applyPatch(
  provider: MutationGitProvider,
  input: { readonly bytes: Uint8Array; readonly target: 'index' | 'workingTree'; readonly reverse: boolean },
): Promise<void> {
  const args = ['apply', '--whitespace=nowarn'];
  if (input.target === 'index') args.push('--cached');
  if (input.reverse) args.push('--reverse');
  const result = await provider.mutate(args, input.bytes);
  if (result.exitCode !== 0) {
    throw applyFailure(`git apply 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
  }
}

/** Dry-runs a patch with `git apply --check` for preflight and property tests. */
export async function checkPatchApplies(
  provider: MutationGitProvider,
  input: { readonly bytes: Uint8Array; readonly target: 'index' | 'workingTree' },
): Promise<boolean> {
  const args = ['apply', '--check', '--whitespace=nowarn'];
  if (input.target === 'index') args.push('--cached');
  const result = await provider.mutate(args, input.bytes);
  return result.exitCode === 0;
}
