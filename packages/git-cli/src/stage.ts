import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';


const maxPaths = 5_000;
const maxTotalPathBytes = 512 * 1024;

function validatePaths(paths: readonly string[]): Buffer {
  if (paths.length === 0 || paths.length > maxPaths) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `路径数量必须在 1 到 ${maxPaths} 之间`, repositoryChanged: false, retry: 'none' });
  }
  const payload = Buffer.from(paths.join('\0'), 'utf8');
  if (payload.byteLength > maxTotalPathBytes) {
    throw new GitWorkbenchError({ code: 'TOO_LARGE', message: '路径列表超出字节预算', repositoryChanged: false, retry: 'refresh' });
  }
  return payload;
}

async function runPathspecMutation(provider: MutationGitProvider, args: readonly string[], paths: readonly string[]): Promise<void> {
  const result = await provider.mutate([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], validatePaths(paths));
  if (result.exitCode !== 0) {
    throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: `git ${args[0] ?? args.join(' ')} 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`, repositoryChanged: true, retry: 'reconcile' });
  }
}

/**
 * Stages the exact paths in one Index-atomic command. Pathspecs travel as
 * NUL-separated stdin so names with tabs, newlines, leading dashes or
 * `:(exclude)` magic are data, never arguments.
 */
export function stagePaths(provider: MutationGitProvider, paths: readonly string[]): Promise<void> {
  return runPathspecMutation(provider, ['--literal-pathspecs', 'add'], paths);
}

/** Unstages exact paths against HEAD; on an unborn branch empties the index instead. */
export async function unstagePaths(provider: MutationGitProvider, paths: readonly string[], hasHeadCommit: boolean): Promise<void> {
  if (hasHeadCommit) {
    await runPathspecMutation(provider, ['--literal-pathspecs', 'restore', '--staged', '--source=HEAD'], paths);
  } else {
    await runPathspecMutation(provider, ['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch'], paths);
  }
}
