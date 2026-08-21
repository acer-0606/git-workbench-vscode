import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const invalid = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'INVALID_INPUT', message, repositoryChanged: false, retry: 'none' });

const failed = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message, repositoryChanged: true, retry: 'reconcile' });

/**
 * History-rewriting operations. Every dangerous entry point pins the exact
 * expected old state first: force-with-lease names the confirmed remote OID,
 * reset records a recovery ref, and reword only touches HEAD.
 */
export const history = {
  /**
   * Pushes with `--force-with-lease=<ref>:<confirmedRemoteOid>`: the push is
   * rejected unless the remote ref still points at the OID the user previewed
   * — never a blanket force.
   */
  async forceWithLease(provider: MutationGitProvider, input: { readonly remote: string; readonly localRef: string; readonly remoteRef: string; readonly confirmedRemoteOid: string }): Promise<void> {
    if (!oidPattern.test(input.confirmedRemoteOid)) throw invalid('force-with-lease 需要确认的远端 OID');
    const localOidResult = await provider.query(['rev-parse', '--verify', '--end-of-options', input.localRef]);
    if (localOidResult.exitCode !== 0) throw invalid(`本地 Ref 不存在：${input.localRef}`);
    const result = await provider.mutate(
      ['push', `--force-with-lease=${input.remoteRef}:${input.confirmedRemoteOid}`, '--', input.remote, `${input.localRef}:${input.remoteRef}`],
      undefined,
      'userInitiatedNetwork',
    );
    if (result.exitCode !== 0) {
      const stale = /stale info|fetch first|force-with-lease/i.test(`${result.stdoutText()}\n${result.stderrText()}`);
      throw failed(`${stale ? '远端已前进，精确 force-with-lease 被拒绝' : 'push 失败'}（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
    }
  },

  /**
   * Resets HEAD to a confirmed OID. soft/mixed never touch the working tree;
   * hard additionally requires a recorded recovery ref so the previous HEAD
   * stays reachable.
   */
  async reset(provider: MutationGitProvider, input: { readonly oid: string; readonly mode: 'soft' | 'mixed' | 'hard'; readonly operationId: string }): Promise<string> {
    if (!oidPattern.test(input.oid)) throw invalid('Reset 需要完整 OID');
    const headBeforeResult = await provider.query(['rev-parse', '--verify', '--end-of-options', 'HEAD']);
    if (headBeforeResult.exitCode !== 0) throw invalid('无法读取当前 HEAD');
    const headBefore = headBeforeResult.stdoutText().trim();
    if (input.mode === 'hard') {
      // Record the recovery ref BEFORE rewriting so the old head is never lost.
      const recoveryRef = `refs/git-workbench/recovery/${input.operationId}/head`;
      const record = await provider.mutate(['update-ref', recoveryRef, headBefore]);
      if (record.exitCode !== 0) throw failed('无法创建恢复 Ref，拒绝 hard reset');
    }
    const result = await provider.mutate(['reset', `--${input.mode}`, input.oid]);
    if (result.exitCode !== 0) throw failed(`reset 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
    return headBefore;
  },

  /** Rewords HEAD via amend; amending published history is the caller's confirmation gate. */
  async reword(provider: MutationGitProvider, message: string): Promise<void> {
    if (!message.trim()) throw invalid('提交说明不能为空');
    const result = await provider.mutate(['commit', '--amend', '--file=-', '--cleanup=verbatim'], Buffer.from(`${message.replace(/\r\n/g, '\n')}\n`, 'utf8'));
    if (result.exitCode !== 0) throw failed(`reword 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`);
  },

  /** Lists commits between two OIDs that a history rewrite would republish. */
  async commitsBetween(provider: MutationGitProvider, fromOid: string, toOid: string): Promise<readonly { readonly oid: string; readonly subject: string }[]> {
    if (!oidPattern.test(fromOid) || !oidPattern.test(toOid)) throw invalid('需要完整 OID');
    const result = await provider.query(['log', '--format=%H%x00%s', `${fromOid}..${toOid}`]);
    if (result.exitCode !== 0) throw failed('无法枚举受影响提交');
    return result.stdoutText().split('\n').filter(Boolean).map((line) => {
      const [oid = '', subject = ''] = line.split('\0');
      return { oid, subject };
    });
  },
};
