import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const validateBranchName = async (provider: MutationGitProvider, name: string): Promise<void> => {
  const result = await provider.query(['check-ref-format', '--branch', name]);
  if (result.exitCode !== 0) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `非法分支名：${name}`, repositoryChanged: false, retry: 'none' });
  }
};

const fail = (message: string, repositoryChanged = false): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message, repositoryChanged, retry: 'reconcile' });

const stderrOf = (result: { stderrText(): string; exitCode: number }): string => `git 退出码 ${result.exitCode}：${result.stderrText().trim()}`;

/**
 * Branch workflows with Git-validated names. Names are always validated with
 * `check-ref-format --branch` first and passed strictly after `--` so a name
 * like `-c core.sshCommand=evil` can never become an option.
 */
export const branch = {
  async create(provider: MutationGitProvider, name: string, startPoint: string, switchTo: boolean): Promise<void> {
    await validateBranchName(provider, name);
    const resolved = await provider.resolve(startPoint);
    const createResult = await provider.mutate(['branch', '--no-track', '--', name, resolved]);
    if (createResult.exitCode !== 0) throw fail(`创建分支失败：${stderrOf(createResult)}`);
    if (switchTo) await this.switch(provider, name, 'keep');
  },

  async switch(provider: MutationGitProvider, name: string, _dirtyStrategy: 'keep' | 'stash' | 'newWorktree'): Promise<void> {
    await validateBranchName(provider, name);
    // Phase 2 only allows switching a clean worktree; a conflict aborts with
    // the worktree untouched. Stash/newWorktree strategies arrive in Phase 3.
    const result = await provider.mutate(['switch', '--', name]);
    if (result.exitCode !== 0) {
      const stderr = result.stderrText();
      if (/local changes.*would be overwritten|conflict/i.test(stderr)) {
        throw new GitWorkbenchError({ code: 'REPOSITORY_LOCKED', message: '工作区包含未提交修改，请先创建 Stash 或新 Worktree', repositoryChanged: false, retry: 'none' });
      }
      throw fail(`切换分支失败：${stderrOf(result)}`);
    }
  },

  async rename(provider: MutationGitProvider, oldName: string, newName: string): Promise<void> {
    await validateBranchName(provider, oldName);
    await validateBranchName(provider, newName);
    const oldOid = await provider.resolve(oldName);
    const result = await provider.mutate(['branch', '--move', '--', oldName, newName]);
    if (result.exitCode !== 0) throw fail(`重命名分支失败：${stderrOf(result)}`);
    // Case-insensitive filesystems can report success while the old ref still
    // resolves; verify both sides explicitly.
    const newOid = await provider.resolve(newName).catch(() => undefined);
    if (newOid !== oldOid) throw fail('重命名后 Ref 校验失败', true);
  },

  async remove(provider: MutationGitProvider, name: string, protectedBranches: readonly string[]): Promise<void> {
    await validateBranchName(provider, name);
    if (protectedBranches.includes(name)) {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `分支 ${name} 受保护，拒绝删除`, repositoryChanged: false, retry: 'none' });
    }
    const merged = await provider.query(['branch', '--merged', '--list', name]);
    if (merged.exitCode === 0 && !merged.stdoutText().trim().includes(name)) {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `分支 ${name} 包含未合并提交，普通删除被拒绝`, repositoryChanged: false, retry: 'none' });
    }
    // Non-forced delete only; `git branch -d` refuses unmerged branches itself.
    const result = await provider.mutate(['branch', '--delete', '--', name]);
    if (result.exitCode !== 0) throw fail(`删除分支失败：${stderrOf(result)}`);
  },

  async setUpstream(provider: MutationGitProvider, name: string, upstream: string): Promise<void> {
    await validateBranchName(provider, name);
    await validateBranchName(provider, upstream.replace(/^refs\/remotes\//, '').split('/').slice(1).join('/') || upstream);
    const before = await provider.resolve(name);
    const result = await provider.mutate(['branch', '--set-upstream-to', upstream, '--', name]);
    if (result.exitCode !== 0) throw fail(`设置上游失败：${stderrOf(result)}`);
    if (await provider.resolve(name) !== before) throw fail('设置上游不应移动分支 Ref', true);
  },

  async unsetUpstream(provider: MutationGitProvider, name: string): Promise<void> {
    await validateBranchName(provider, name);
    const before = await provider.resolve(name);
    const result = await provider.mutate(['branch', '--unset-upstream', '--', name]);
    if (result.exitCode !== 0) throw fail(`清除上游失败：${stderrOf(result)}`);
    if (await provider.resolve(name) !== before) throw fail('清除上游不应移动分支 Ref', true);
  },
};
