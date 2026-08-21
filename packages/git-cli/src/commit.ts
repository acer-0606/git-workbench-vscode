import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const maxMessageBytes = 64 * 1024;

/**
 * Creates (or amends) a commit with the message passed verbatim on stdin.
 * Hooks, signing and the user's git config stay fully in effect: no
 * `--no-verify`, `--no-gpg-sign` or author overrides are ever added.
 */
export async function commit(provider: MutationGitProvider, input: { readonly message: string; readonly amend: boolean }): Promise<void> {
  const message = input.message.replace(/\r\n/g, '\n');
  if (!message.trim()) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'commit message is empty', repositoryChanged: false, retry: 'none' });
  const payload = Buffer.from(`${message}\n`, 'utf8');
  if (payload.byteLength > maxMessageBytes) throw new GitWorkbenchError({ code: 'TOO_LARGE', message: 'commit message exceeds the byte budget', repositoryChanged: false, retry: 'none' });
  const args = ['commit', '--file=-', '--cleanup=verbatim'];
  if (input.amend) args.push('--amend');
  const result = await provider.mutate(args, payload);
  if (result.exitCode !== 0) {
    throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: `git commit 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`, repositoryChanged: false, retry: 'refresh' });
  }
}
