import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const sequencerCommands: Readonly<Record<string, { readonly continueArgs: readonly string[]; readonly skipArgs?: readonly string[]; readonly abortArgs: readonly string[] }>> = {
  merge: { continueArgs: ['commit', '--no-edit'], abortArgs: ['merge', '--abort'] },
  pullMerge: { continueArgs: ['commit', '--no-edit'], abortArgs: ['merge', '--abort'] },
  rebase: { continueArgs: ['rebase', '--continue'], skipArgs: ['rebase', '--skip'], abortArgs: ['rebase', '--abort'] },
  pullRebase: { continueArgs: ['rebase', '--continue'], skipArgs: ['rebase', '--skip'], abortArgs: ['rebase', '--abort'] },
  cherryPick: { continueArgs: ['cherry-pick', '--continue'], skipArgs: ['cherry-pick', '--skip'], abortArgs: ['cherry-pick', '--abort'] },
  revert: { continueArgs: ['revert', '--continue'], skipArgs: ['revert', '--skip'], abortArgs: ['revert', '--abort'] },
};

/**
 * Continue/Skip/Abort for paused sequencer operations. Every action maps to
 * exactly one Git sequencer command — never a combination that could replay
 * the whole list — and stashApply only supports checkpoint-based actions.
 */
export const sequencer = {
  async run(provider: MutationGitProvider, kind: string, action: 'continue' | 'skip' | 'abort'): Promise<void> {
    if (kind === 'stashApply') {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Stash 冲突只支持标记解决或恢复检查点', repositoryChanged: false, retry: 'none' });
    }
    const commands = sequencerCommands[kind];
    if (!commands) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `未知暂停操作：${kind}`, repositoryChanged: false, retry: 'none' });
    const args = action === 'continue' ? commands.continueArgs : action === 'skip' ? commands.skipArgs : commands.abortArgs;
    if (!args) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: `${kind} 不支持 ${action}`, repositoryChanged: false, retry: 'none' });
    const result = await provider.mutate([...args]);
    if (result.exitCode !== 0) {
      const stillConflicted = /conflict|unmerged/i.test(`${result.stdoutText()}\n${result.stderrText()}`);
      throw new GitWorkbenchError({
        code: stillConflicted ? 'CONFLICT_PAUSED' : 'POSTCONDITION_FAILED',
        message: `git ${args.join(' ')} 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`,
        repositoryChanged: true,
        retry: 'reconcile',
      });
    }
  },

  /** Stages one resolved path with `git add -- <path>` after validation. */
  async markResolved(provider: MutationGitProvider, path: string): Promise<void> {
    if (path.includes('\0') || path.startsWith('-') || path.includes('..')) {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '非法路径', repositoryChanged: false, retry: 'none' });
    }
    const result = await provider.mutate(['--literal-pathspecs', 'add', '--', path]);
    if (result.exitCode !== 0) {
      throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: `标记解决失败：${result.stderrText().trim()}`, repositoryChanged: false, retry: 'refresh' });
    }
  },
};
