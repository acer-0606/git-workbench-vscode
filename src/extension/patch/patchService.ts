import { createHash, randomUUID } from 'node:crypto';

import { GitWorkbenchError, validatePatchSelection, type PatchSelection, type PatchTarget, type RawDiffToken } from '@git-workbench/domain';
import { GitProcessRunner, applyPatch, captureVersionVector, createCliMutationProvider, readRawDiff, buildSelectedPatch, type MutationGitProvider, type RawUnifiedDiff } from '@git-workbench/git-cli';

/**
 * Plans and applies file/hunk/line patches. The raw diff is captured once per
 * compare session and held host-side; selections only reference the token,
 * generation and view digest, so a whitespace view can never become the
 * write source and stale selections are refused before Git runs.
 */
export class PatchService {
  private readonly tokens = new Map<string, { token: RawDiffToken; diff: RawUnifiedDiff; baseline: { headOid?: string; indexFingerprint: string } }>();

  private readonly provider: MutationGitProvider;

  constructor(private readonly runner: GitProcessRunner, private readonly cwd: string, private readonly repositoryId: string) {
    this.provider = createCliMutationProvider(runner, cwd);
  }

  async openSession(input: { readonly generation: number; readonly leftIdentity: string; readonly rightIdentity: string; readonly endpoints: readonly string[] }): Promise<RawDiffToken> {
    const snapshot = await readRawDiff({ runner: this.runner, cwd: this.cwd }, input.endpoints);
    const baseline = await captureVersionVector(this.runner, this.cwd, { generation: input.generation, commonGeneration: 0 });
    const token: RawDiffToken = {
      id: randomUUID(),
      repositoryId: this.repositoryId,
      generation: input.generation,
      leftIdentity: input.leftIdentity,
      rightIdentity: input.rightIdentity,
      rawDigest: snapshot.digest,
      viewDigest: createHash('sha256').update(`${snapshot.digest}:raw`).digest('hex'),
    };
    this.tokens.set(token.id, { token, diff: snapshot.diff, baseline: { ...(baseline.headOid ? { headOid: baseline.headOid } : {}), indexFingerprint: baseline.indexFingerprint } });
    return token;
  }

  closeSession(tokenId: string): void {
    this.tokens.delete(tokenId);
  }

  async plan(token: RawDiffToken, selection: PatchSelection, target: PatchTarget, currentGeneration: number): Promise<{ readonly bytes: Uint8Array }> {
    const errors = validatePatchSelection(token, selection);
    if (currentGeneration !== token.generation) errors.push('current-generation');
    if (errors.length > 0) {
      throw new GitWorkbenchError({ code: 'STALE_PLAN', message: `选择已过期：${errors.join(', ')}`, repositoryChanged: true, retry: 'refresh' });
    }
    const held = this.tokens.get(token.id);
    if (!held) throw new GitWorkbenchError({ code: 'STALE_PLAN', message: 'Raw Diff 会话已关闭', repositoryChanged: true, retry: 'refresh' });
    // Re-sample the repository: any drift between preview and execution
    // (external commit, staging, editor save) invalidates the raw session.
    const current = await captureVersionVector(this.runner, this.cwd, { generation: token.generation, commonGeneration: 0 });
    if (current.headOid !== held.baseline.headOid || current.indexFingerprint !== held.baseline.indexFingerprint) {
      throw new GitWorkbenchError({ code: 'STALE_PLAN', message: '仓库在预览后发生变化，Raw Diff 已过期', repositoryChanged: true, retry: 'refresh' });
    }
    if (target.kind === 'newWorktree') {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '新 Worktree 目标需要专用工作流', repositoryChanged: false, retry: 'none' });
    }
    return { bytes: buildSelectedPatch(held.diff, selection.items).bytes };
  }

  async applyToIndex(bytes: Uint8Array): Promise<void> {
    await applyPatch(this.provider, { bytes, target: 'index', reverse: false });
  }

  async applyToWorkingTree(bytes: Uint8Array): Promise<void> {
    await applyPatch(this.provider, { bytes, target: 'workingTree', reverse: false });
  }

  async currentGenerationBaseline(): Promise<string> {
    const vector = await captureVersionVector(this.runner, this.cwd, { generation: 0, commonGeneration: 0 });
    return vector.indexFingerprint;
  }
}
