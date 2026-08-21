import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const refPattern = /^refs\/(heads|tags|remotes)\/[A-Za-z0-9._\/-]+$/;

export type PushReconciliation =
  | { readonly outcome: 'reconciledSuccess' }
  | { readonly outcome: 'notApplied' }
  | { readonly outcome: 'remoteDiverged'; readonly remoteOid: string };

const fail = (code: 'POSTCONDITION_FAILED' | 'INVALID_INPUT' | 'PARSER_UNSUPPORTED', message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code, message, repositoryChanged: true, retry: code === 'INVALID_INPUT' ? 'none' : 'reconcile' });

/**
 * Parses `git ls-remote --refs -- <remote> <ref>` output strictly: exactly one
 * line of `<full OID>\t<exactly the requested ref>`. Anything else — multiple
 * refs, abbreviated OIDs, extra lines — is a parser failure, never a guess.
 */
export function parseLsRemote(output: string, expectedRef: string): string {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) throw fail('PARSER_UNSUPPORTED', `ls-remote 返回 ${lines.length} 行，拒绝猜测`);
  const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/.exec(lines[0] ?? '');
  if (!match?.[1] || !match[2]) throw fail('PARSER_UNSUPPORTED', 'ls-remote 输出格式非法');
  if (match[2] !== expectedRef) throw fail('PARSER_UNSUPPORTED', `ls-remote 返回了未请求的 Ref：${match[2]}`);
  return match[1];
}

/** Remote operations with confirmed OIDs and explicit reconciliation. */
export const remote = {
  async listRemotes(provider: MutationGitProvider): Promise<readonly string[]> {
    const result = await provider.query(['remote']);
    if (result.exitCode !== 0) throw fail('POSTCONDITION_FAILED', `无法枚举 Remote：${result.stderrText().trim()}`);
    return result.stdoutText().split('\n').map((line) => line.trim()).filter(Boolean);
  },

  async fetch(provider: MutationGitProvider, remoteName: string, prune: boolean): Promise<void> {
    const remotes = await this.listRemotes(provider);
    if (!remotes.includes(remoteName)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `Remote 不存在：${remoteName}`, repositoryChanged: false, retry: 'none' });
    // Only the remote's own tracking namespace is ever written.
    const refspec = `+refs/heads/*:refs/remotes/${remoteName}/*`;
    const args = ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-commit-graph'];
    if (prune) args.push('--prune');
    args.push('--', remoteName, refspec);
    const result = await provider.mutate(args, undefined, 'userInitiatedNetwork');
    if (result.exitCode !== 0) throw fail('POSTCONDITION_FAILED', `fetch 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
  },

  async fetchBranchForPull(provider: MutationGitProvider, remoteName: string, branch: string): Promise<string> {
    const format = await provider.query(['check-ref-format', '--branch', branch]);
    if (format.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `非法分支名：${branch}`, repositoryChanged: false, retry: 'none' });
    const remoteRef = `refs/heads/${branch}`;
    const result = await provider.mutate(['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-commit-graph', '--', remoteName, remoteRef], undefined, 'userInitiatedNetwork');
    if (result.exitCode !== 0) throw fail('POSTCONDITION_FAILED', `fetch 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
    const headResult = await provider.query(['rev-parse', '--verify', '--end-of-options', 'FETCH_HEAD']);
    if (headResult.exitCode !== 0) throw fail('POSTCONDITION_FAILED', '无法解析 FETCH_HEAD');
    const oid = headResult.stdoutText().trim();
    if (!oidPattern.test(oid)) throw fail('PARSER_UNSUPPORTED', `FETCH_HEAD 不是完整 OID：${oid}`);
    return oid;
  },

  async pull(provider: MutationGitProvider, confirmedOid: string, strategy: 'ffOnly' | 'merge' | 'rebase'): Promise<void> {
    if (!oidPattern.test(confirmedOid)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Pull 需要确认的完整 OID', repositoryChanged: false, retry: 'none' });
    const args: readonly string[] = strategy === 'ffOnly'
      ? ['merge', '--ff-only', confirmedOid]
      : strategy === 'merge'
        ? ['-c', 'merge.autoStash=false', 'merge', '--no-edit', confirmedOid]
        : ['-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', 'rebase', confirmedOid];
    const result = await provider.mutate(args, undefined, 'userInitiatedNetwork');
    if (result.exitCode !== 0 && /conflict/i.test(`${result.stdoutText()}\n${result.stderrText()}`)) {
      throw new GitWorkbenchError({ code: 'CONFLICT_PAUSED', message: 'Pull 整合出现冲突', repositoryChanged: true, retry: 'reconcile' });
    }
    if (result.exitCode !== 0) throw fail('POSTCONDITION_FAILED', `pull 整合失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
  },

  async push(provider: MutationGitProvider, input: { readonly remote: string; readonly localRef: string; readonly remoteRef: string }): Promise<void> {
    if (!refPattern.test(input.remoteRef)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `非法远端 Ref：${input.remoteRef}`, repositoryChanged: false, retry: 'none' });
    if (!refPattern.test(input.localRef)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `非法本地 Ref：${input.localRef}`, repositoryChanged: false, retry: 'none' });
    // The confirmed local OID is the refspec source: a branch that moved in
    // the execution window can never be force-pushed implicitly.
    const localOid = (await provider.query(['rev-parse', '--verify', '--end-of-options', input.localRef])).stdoutText().trim();
    if (!oidPattern.test(localOid)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '无法确认本地 OID', repositoryChanged: false, retry: 'none' });
    const result = await provider.mutate(['push', '--', input.remote, `${localOid}:${input.remoteRef}`], undefined, 'userInitiatedNetwork');
    if (result.exitCode !== 0) throw fail('POSTCONDITION_FAILED', `push 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
  },

  /**
   * Reconciles a push whose transport result is unknown (connection dropped
   * mid-pack). Runs exactly one `ls-remote` for the single confirmed ref and
   * classifies the outcome structurally; never retries the push itself.
   */
  async reconcileUnknownPush(provider: MutationGitProvider, input: { readonly remote: string; readonly remoteRef: string; readonly confirmedLocalOid: string }): Promise<PushReconciliation> {
    const result = await provider.mutate(['ls-remote', '--refs', '--', input.remote, input.remoteRef], undefined, 'userInitiatedNetwork');
    if (result.exitCode !== 0) throw fail('POSTCONDITION_FAILED', `无法对账远端状态：${result.stderrText().trim()}`);
    const remoteOid = parseLsRemote(`${result.stdoutText()}\n`, input.remoteRef);
    if (remoteOid === input.confirmedLocalOid) return { outcome: 'reconciledSuccess' };
    if (!oidPattern.test(remoteOid)) throw fail('PARSER_UNSUPPORTED', `远端 OID 非法：${remoteOid}`);
    return { outcome: 'remoteDiverged', remoteOid };
  },
};
