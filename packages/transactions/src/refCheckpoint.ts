import { createHash } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { GitProcessRunner } from '@git-workbench/git-cli';

export interface RefState { readonly ref: string; readonly oid?: string }

export interface IndexSnapshot {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mode: number;
  readonly exists: true;
}

export interface RefCheckpoint {
  readonly headOid?: string;
  readonly headName?: string;
  readonly refs: readonly RefState[];
  readonly index: IndexSnapshot;
  readonly affectedPaths: readonly string[];
}

/**
 * Captures the Phase 2 checkpoint: HEAD identity, the plan's target refs and
 * the full raw bytes of the index (so staged entries, intent-to-add and
 * skip-worktree flags all survive). Working-tree content is deliberately not
 * snapshotted before Phase 3.
 */
export async function captureRefCheckpoint(
  provider: { runner: GitProcessRunner; cwd: string },
  refs: readonly string[],
  affectedPaths: readonly string[] = [],
): Promise<RefCheckpoint> {
  const headNameResult = await provider.runner.run({ args: ['symbolic-ref', '-q', '--short', 'HEAD'], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 1024, maxStderrBytes: 64 * 1024 });
  const headName = headNameResult.exitCode === 0 ? headNameResult.stdoutText().trim() : undefined;
  const headOidResult = await provider.runner.run({ args: ['rev-parse', '--verify', '--end-of-options', 'HEAD'], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
  const headOid = headOidResult.exitCode === 0 ? headOidResult.stdoutText().trim() : undefined;
  const refStates: RefState[] = [];
  for (const ref of refs) {
    const result = await provider.runner.run({ args: ['rev-parse', '--verify', '--end-of-options', ref], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
    refStates.push(result.exitCode === 0 ? { ref, oid: result.stdoutText().trim() } : { ref });
  }
  // Git deletes the index file when the last entry is removed; a missing
  // index is a valid state and snapshots as an empty buffer.
  const indexBytes = await readFile(await locateIndex(provider)).catch(() => Buffer.alloc(0));
  const stats = await stat(await locateIndex(provider)).catch(() => undefined);
  return {
    ...(headOid ? { headOid } : {}),
    ...(headName ? { headName } : {}),
    refs: refStates,
    index: { bytes: indexBytes, sha256: sha256(indexBytes), mode: stats?.mode ?? 0o600, exists: true },
    affectedPaths,
  };
}

async function locateIndex(provider: { runner: GitProcessRunner; cwd: string }): Promise<string> {
  const result = await provider.runner.run({ args: ['rev-parse', '--git-path', 'index'], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 1024, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error('cannot locate index');
  const path = result.stdoutText().trim();
  return isAbsolute(path) ? path : join(provider.cwd, path);
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Restores the checkpointed index under the Git lockfile protocol: create
 * `index.lock` exclusively (EEXIST means someone else is writing), re-verify
 * the current index still hashes to the expected after-image, then publish
 * the checkpoint bytes with an atomic rename. A CAS mismatch never overwrites
 * whatever the other writer left behind.
 */
export async function restoreIndexWithCas(indexPath: string, checkpoint: RefCheckpoint, expectedAfterSha256: string): Promise<void> {
  const lockPath = `${indexPath}.lock`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('REPOSITORY_LOCKED');
    throw error;
  }
  try {
    const current = await readFile(indexPath).catch(() => Buffer.alloc(0));
    if (sha256(current) !== expectedAfterSha256) throw new Error('CAS_FAILED');
    await handle.writeFile(checkpoint.index.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(lockPath, indexPath);
  } catch (error) {
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(indexPath));
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeRefCheckpointForRecovery(provider: { runner: GitProcessRunner; cwd: string }, operationId: string, expectedOldOid: string | undefined): Promise<void> {
  if (!expectedOldOid) return;
  const recoveryRef = `refs/git-workbench/recovery/${operationId}/head`;
  await provider.runner.run({ args: ['update-ref', recoveryRef, expectedOldOid], cwd: provider.cwd, kind: 'mutation', maxStdoutBytes: 1024, maxStderrBytes: 64 * 1024 });
  void writeFile;
}
