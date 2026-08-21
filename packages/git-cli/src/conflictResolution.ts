import { GitWorkbenchError } from '@git-workbench/domain';

import type { MutationGitProvider } from './ports.js';

const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const invalid = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'INVALID_INPUT', message, repositoryChanged: false, retry: 'none' });

const failed = (message: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message, repositoryChanged: true, retry: 'reconcile' });

export interface ConflictStages {
  readonly path: string;
  readonly stages: readonly { readonly stage: 1 | 2 | 3; readonly oid: string; readonly mode: string }[];
}

async function readStages(provider: MutationGitProvider, path: string): Promise<ConflictStages> {
  const result = await provider.query(['ls-files', '--unmerged', '-z', '-s', '--', path]);
  if (result.exitCode !== 0) throw failed(`无法读取冲突阶段：${result.stderrText().trim()}`);
  const stages: { stage: 1 | 2 | 3; oid: string; mode: string }[] = [];
  for (const record of result.stdoutText().split('\0')) {
    if (!record) continue;
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/.exec(record);
    if (!match) throw failed('ls-files --unmerged 输出非法');
    stages.push({ stage: Number(match[3]) as 1 | 2 | 3, oid: match[2]!, mode: match[1]! });
  }
  return { path, stages };
}

/**
 * Marks a text conflict resolved with EXACTLY the frozen bytes the user
 * confirmed: `git hash-object -w --stdin --path=<path>` applies the path's
 * clean/EOL attributes to the frozen content, then a single NUL
 * `git update-index -z --index-info` writes stage 0 under one index lock.
 * The file is never re-read after confirmation, so an editor racing the
 * click cannot stage unreviewed content; it only surfaces as an unstaged
 * change afterwards.
 */
export async function stageResolvedText(provider: MutationGitProvider, input: { readonly path: string; readonly frozenBytes: Uint8Array; readonly mode: string }): Promise<string> {
  if (input.path.includes('\0') || input.path.startsWith('-') || input.path.includes('..')) throw invalid('非法冲突路径');
  // Re-verify the conflict still exists exactly as confirmed.
  const before = await readStages(provider, input.path);
  if (before.stages.length === 0) throw invalid('该路径已无冲突阶段');

  const hashResult = await provider.mutate(['hash-object', '-w', `--path=${input.path}`, '--stdin'], input.frozenBytes);
  if (hashResult.exitCode !== 0) throw failed(`hash-object 失败：${hashResult.stderrText().trim()}`);
  const frozenOid = hashResult.stdoutText().trim();
  if (!oidPattern.test(frozenOid)) throw failed('hash-object 返回非法 OID');

  // 100644/100755/120000 keep the confirmed mode; gitlinks never reach here.
  const indexInfo = `${input.mode} ${frozenOid} 0\t${input.path}\0`;
  const updateResult = await provider.mutate(['update-index', '-z', '--index-info'], Buffer.from(indexInfo, 'utf8'));
  if (updateResult.exitCode !== 0) throw failed(`update-index 失败：${updateResult.stderrText().trim()}`);

  return verifyResolution(provider, input.path, frozenOid);
}

/**
 * Records the user's decision to delete the conflicted path: a zero-OID
 * index-info entry removes it from the index inside the same single lock.
 */
export async function stageDeletedResolution(provider: MutationGitProvider, path: string): Promise<void> {
  if (path.includes('\0') || path.startsWith('-') || path.includes('..')) throw invalid('非法冲突路径');
  const before = await readStages(provider, path);
  if (before.stages.length === 0) throw invalid('该路径已无冲突阶段');
  const indexInfo = `000000 ${'0'.repeat(40)} 0\t${path}\0`;
  const updateResult = await provider.mutate(['update-index', '-z', '--index-info'], Buffer.from(indexInfo, 'utf8'));
  if (updateResult.exitCode !== 0) throw failed(`update-index 删除记录失败：${updateResult.stderrText().trim()}`);
  await verifyResolution(provider, path, undefined);
}

async function verifyResolution(provider: MutationGitProvider, path: string, expectedOid: string | undefined): Promise<string> {
  const after = await readStages(provider, path);
  if (after.stages.length > 0) throw failed(`冲突阶段未清除：${path}`);
  const stage0 = await provider.query(['ls-files', '-s', '-z', '--', path]);
  if (stage0.exitCode !== 0 || !stage0.stdoutText().trim()) {
    if (expectedOid === undefined) return '';
    throw failed(`Stage 0 缺失：${path}`);
  }
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t/.exec(stage0.stdoutText());
  if (!match?.[2]) throw failed('Stage 0 输出非法');
  if (expectedOid !== undefined && match[2] !== expectedOid) {
    throw failed(`Stage 0 OID 与确认内容不一致：${match[2]} != ${expectedOid}`);
  }
  return match[2];
}

/**
 * Special-conflict resolutions, all OID-locked against the live stages and
 * checkpointed by the caller before any write.
 */
export const specialResolution = {
  /** Keeps both binary versions: stage2 keeps its path, stage3 lands at an explicit non-existing path. */
  async keepBothBinary(provider: MutationGitProvider, input: { readonly path: string; readonly newPath: string }): Promise<void> {
    const conflict = await readStages(provider, input.path);
    const ours = conflict.stages.find((stage) => stage.stage === 2);
    const theirs = conflict.stages.find((stage) => stage.stage === 3);
    if (!ours || !theirs) throw invalid('二进制冲突缺少 Stage 2/3');
    if (input.newPath.includes('\0') || input.newPath.includes('..') || input.newPath.startsWith('/')) throw invalid('非法新路径');
    const exists = await provider.query(['cat-file', '-e', `${input.newPath}`]).then(() => true, () => false);
    const tracked = await provider.query(['ls-files', '--', input.newPath]);
    if (tracked.exitCode === 0 && tracked.stdoutText().trim() !== '') throw invalid('新路径已被跟踪，请另选路径');
    void exists;
    const keepIncoming = `100644 ${theirs.oid} 0\t${input.newPath}\0`;
    const keepOurs = `100644 ${ours.oid} 0\t${input.path}\0`;
    const result = await provider.mutate(['update-index', '-z', '--index-info'], Buffer.from(`${keepIncoming}${keepOurs}`, 'utf8'));
    if (result.exitCode !== 0) throw failed(`保留两份失败：${result.stderrText().trim()}`);
    await verifyResolution(provider, input.path, ours.oid);
  },

  /** Delete/Modify: keep the surviving side's blob at stage 0. */
  async resolveDeleteModify(provider: MutationGitProvider, input: { readonly path: string; readonly keep: 'ours' | 'theirs' | 'deleted' }): Promise<void> {
    const conflict = await readStages(provider, input.path);
    if (conflict.stages.length === 0) throw invalid('该路径已无冲突阶段');
    if (input.keep === 'deleted') {
      await stageDeletedResolution(provider, input.path);
      return;
    }
    const wanted = input.keep === 'ours' ? 2 : 3;
    const side = conflict.stages.find((stage) => stage.stage === wanted) ?? conflict.stages.find((stage) => stage.stage !== 1);
    if (!side) throw invalid('删除/修改冲突缺少可用 Stage');
    const indexInfo = `${side.mode} ${side.oid} 0\t${input.path}\0`;
    const result = await provider.mutate(['update-index', '-z', '--index-info'], Buffer.from(indexInfo, 'utf8'));
    if (result.exitCode !== 0) throw failed(`删除/修改解决失败：${result.stderrText().trim()}`);
    await verifyResolution(provider, input.path, side.oid);
  },

  /**
   * Submodule gitlink: point the index at a confirmed OID that must already
   * be reachable in the submodule repository — no checkout, no fetch.
   */
  async resolveSubmodule(provider: MutationGitProvider, input: { readonly path: string; readonly commitOid: string }): Promise<void> {
    if (!oidPattern.test(input.commitOid)) throw invalid('非法 Submodule Commit OID');
    const conflict = await readStages(provider, input.path);
    if (!conflict.stages.length) throw invalid('该路径已无冲突阶段');
    if (!conflict.stages.some((stage) => stage.mode === '160000')) throw invalid('该路径不是 Submodule 冲突');
    const indexInfo = `160000 ${input.commitOid} 0\t${input.path}\0`;
    const result = await provider.mutate(['update-index', '-z', '--index-info'], Buffer.from(indexInfo, 'utf8'));
    if (result.exitCode !== 0) throw failed(`Submodule 解决失败：${result.stderrText().trim()}`);
    await verifyResolution(provider, input.path, input.commitOid);
  },
};
