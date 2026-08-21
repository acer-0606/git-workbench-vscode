import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const stashOidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const fail = (message: string, code: 'POSTCONDITION_FAILED' | 'CONFLICT_PAUSED' = 'POSTCONDITION_FAILED'): GitWorkbenchError =>
  new GitWorkbenchError({ code, message, repositoryChanged: true, retry: code === 'CONFLICT_PAUSED' ? 'reconcile' : 'refresh' });

const stderrOf = (result: { stderrText(): string; exitCode: number }): string => `git 退出码 ${result.exitCode}：${result.stderrText().trim()}`;

/** Resolves a UI selector (stash@{n}) to a concrete stash OID right now. */
export async function resolveStashSelector(provider: MutationGitProvider, selector: string): Promise<string> {
  if (!/^stash@\{\d+\}$/.test(selector)) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '非法 Stash 选择器', repositoryChanged: false, retry: 'none' });
  }
  const result = await provider.query(['rev-parse', '--verify', '--end-of-options', selector]);
  if (result.exitCode !== 0) throw fail(`Stash 不存在：${selector}`);
  const oid = result.stdoutText().trim();
  if (!stashOidPattern.test(oid)) throw fail(`无法解析 Stash OID：${selector}`);
  return oid;
}

async function requireCleanWorktree(provider: MutationGitProvider): Promise<void> {
  const status = await provider.query(['status', '--porcelain']);
  if (status.exitCode === 0 && status.stdoutText().trim() !== '') {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Phase 2 的 Apply/Pop 只允许干净工作区', repositoryChanged: false, retry: 'none' });
  }
}

/** Stash operations with OID-locked selectors verified against refs/stash. */
export const stash = {
  async currentOid(provider: MutationGitProvider): Promise<string | undefined> {
    const result = await provider.query(['rev-parse', '--verify', '-q', '--end-of-options', 'refs/stash']);
    return result.exitCode === 0 ? result.stdoutText().trim() : undefined;
  },

  async create(provider: MutationGitProvider, input: { readonly message: string; readonly includeUntracked: boolean; readonly keepIndex: boolean; readonly stagedOnly: boolean }): Promise<string> {
    const before = await this.currentOid(provider);
    const args = ['stash', 'push', '-m', input.message];
    if (input.includeUntracked) args.push('--include-untracked');
    if (input.keepIndex) args.push('--keep-index');
    if (input.stagedOnly) args.push('--staged');
    const result = await provider.mutate(args);
    if (result.exitCode !== 0) throw fail(`创建 Stash 失败：${stderrOf(result)}`);
    const after = await this.currentOid(provider);
    if (!after || after === before) throw fail('创建 Stash 后 refs/stash 未前进');
    return after;
  },

  async apply(provider: MutationGitProvider, input: { readonly selector: string; readonly dropAfterSuccess: boolean }): Promise<void> {
    await requireCleanWorktree(provider);
    const oid = await resolveStashSelector(provider, input.selector);
    if (input.dropAfterSuccess) {
      // Native pop with the just-verified selector: Git deletes the stash
      // only when the application succeeds, keeping it on conflicts.
      const reverified = await resolveStashSelector(provider, input.selector);
      if (reverified !== oid) throw fail('Stash 索引在执行窗口内变化');
      const result = await provider.mutate(['stash', 'pop', input.selector]);
      if (result.exitCode !== 0) {
        if (/conflict/i.test(`${result.stdoutText()}\n${result.stderrText()}`)) throw fail('应用 Stash 出现冲突，Stash 已保留', 'CONFLICT_PAUSED');
        throw fail(`应用 Stash 失败：${stderrOf(result)}`);
      }
      const remaining = await this.currentOid(provider);
      if (remaining === oid) throw fail('Pop 成功但 Stash 未删除，进入对账');
      return;
    }
    const result = await provider.mutate(['stash', 'apply', '--', oid]);
    if (result.exitCode !== 0) {
      if (/conflict/i.test(`${result.stdoutText()}\n${result.stderrText()}`)) throw fail('应用 Stash 出现冲突', 'CONFLICT_PAUSED');
      throw fail(`应用 Stash 失败：${stderrOf(result)}`);
    }
  },

  async drop(provider: MutationGitProvider, selector: string): Promise<void> {
    const oid = await resolveStashSelector(provider, selector);
    void oid;
    const result = await provider.mutate(['stash', 'drop', selector]);
    if (result.exitCode !== 0) throw fail(`删除 Stash 失败：${stderrOf(result)}`);
  },

  async createBranch(provider: MutationGitProvider, selector: string, branchName: string): Promise<void> {
    const format = await provider.query(['check-ref-format', '--branch', branchName]);
    if (format.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `非法分支名：${branchName}`, repositoryChanged: false, retry: 'none' });
    const oid = await resolveStashSelector(provider, selector);
    const result = await provider.mutate(['stash', 'branch', branchName, '--', oid]);
    if (result.exitCode !== 0) throw fail(`从 Stash 创建分支失败：${stderrOf(result)}`);
  },
};
