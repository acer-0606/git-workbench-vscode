import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

/**
 * Creates an isolated linked worktree at an explicit, currently-nonexistent
 * directory for one confirmed OID. The path is checked with check-ref-format
 * style validation only for the branch; the directory itself must not exist
 * so `git worktree add` is always additive.
 */
export async function addIsolatedWorktree(provider: MutationGitProvider, input: { readonly directory: string; readonly oid: string }): Promise<void> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.oid)) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Worktree 目标需要完整 OID', repositoryChanged: false, retry: 'none' });
  }
  if (input.directory.includes('\0') || input.directory.includes('..')) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '非法 Worktree 目录', repositoryChanged: false, retry: 'none' });
  }
  const result = await provider.mutate(['worktree', 'add', '--', input.directory, input.oid]);
  if (result.exitCode !== 0) {
    throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: `创建 Worktree 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`, repositoryChanged: false, retry: 'refresh' });
  }
}
