import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface SequencerPaused {
  readonly operationKind: 'cherryPick' | 'revert';
  readonly step: number;
}

const classifyError = (result: { exitCode: number; stdoutText(): string; stderrText(): string }): SequencerPaused | undefined => {
  const output = `${result.stdoutText()}\n${result.stderrText()}`;
  if (/conflict/i.test(output)) return { operationKind: /revert/i.test(output) && /cherry/i.test(output) === false ? 'revert' : 'cherryPick', step: 0 };
  return undefined;
};

/**
 * Starts cherry-pick or revert runs over fully resolved commit OIDs in the
 * user-confirmed order. Hooks and signing stay enabled; a mid-run conflict
 * surfaces as a structured paused outcome instead of a partial retry.
 */
export const commitActions = {
  async cherryPick(provider: MutationGitProvider, oids: readonly string[]): Promise<{ outcome: 'success' } | { outcome: 'paused'; paused: SequencerPaused }> {
    validateOidList(oids);
    await this.requireClean(provider);
    const result = await provider.mutate(['cherry-pick', '--', ...oids]);
    if (result.exitCode === 0) return { outcome: 'success' };
    const paused = classifyError(result);
    if (paused) return { outcome: 'paused', paused: { ...paused, operationKind: 'cherryPick' } };
    throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: `cherry-pick 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`, repositoryChanged: true, retry: 'reconcile' });
  },

  async revert(provider: MutationGitProvider, oids: readonly string[]): Promise<{ outcome: 'success' } | { outcome: 'paused'; paused: SequencerPaused }> {
    validateOidList(oids);
    await this.requireClean(provider);
    const result = await provider.mutate(['revert', '--no-edit', '--', ...oids]);
    if (result.exitCode === 0) return { outcome: 'success' };
    const paused = classifyError(result);
    if (paused) return { outcome: 'paused', paused: { ...paused, operationKind: 'revert' } };
    throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: `revert 失败（退出码 ${result.exitCode}）：${result.stderrText().trim()}`, repositoryChanged: true, retry: 'reconcile' });
  },

  async requireClean(provider: MutationGitProvider): Promise<void> {
    const status = await provider.query(['status', '--porcelain']);
    if (status.exitCode === 0 && status.stdoutText().trim() !== '') {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Phase 2 的 Cherry-pick/Revert 只允许干净工作区', repositoryChanged: false, retry: 'none' });
    }
    for (const head of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const probe = await provider.query(['rev-parse', '--verify', '-q', '--end-of-options', head]);
      if (probe.exitCode === 0) {
        throw new GitWorkbenchError({ code: 'CONFLICT_PAUSED', message: '存在未完成的操作，请先 Continue/Skip/Abort', repositoryChanged: true, retry: 'reconcile' });
      }
    }
  },
};

function validateOidList(oids: readonly string[]): void {
  if (oids.length < 1 || oids.length > 100) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Commit 数量必须在 1 到 100 之间', repositoryChanged: false, retry: 'none' });
  }
  if (oids.some((oid) => !oidPattern.test(oid))) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '只接受完整 Commit OID', repositoryChanged: false, retry: 'none' });
  }
}
