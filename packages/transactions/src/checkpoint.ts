import { lstat, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GitWorkbenchError } from '@git-workbench/domain';

import type { GitProcessRunner } from '@git-workbench/git-cli';

import { ContentStore, type ContentRef } from './contentStore.js';
import { sha256 } from './refCheckpoint.js';
import { validateRepoRelativePath } from './safePath.js';

export interface FileCheckpointEntry {
  readonly path: string;
  readonly exists: boolean;
  readonly mode: number;
  readonly symlinkTarget?: string;
  readonly before: ContentRef;
}

export interface FullCheckpoint {
  readonly files: readonly FileCheckpointEntry[];
}

/**
 * Snapshots the affected working-tree paths into the content store (before
 * images) so Phase 3 can restore overwritten user content. Paths come from
 * the validated raw diff; every write target is lstat-checked against
 * symlink escapes before it is touched.
 */
export async function captureFileCheckpoint(store: ContentStore, cwd: string, paths: readonly string[]): Promise<FullCheckpoint> {
  const entries: FileCheckpointEntry[] = [];
  for (const path of paths) {
    validateRepoRelativePath(path);
    const absolute = join(cwd, path);
    const stats = await lstat(absolute).catch(() => undefined);
    if (!stats) {
      // Missing files snapshot as the empty object so restores can recreate
      // the "did not exist" state.
      entries.push({ path, exists: false, mode: 0, before: await store.put(Buffer.alloc(0)) });
      continue;
    }
    if (stats.isSymbolicLink()) {
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(absolute);
      entries.push({ path, exists: true, mode: stats.mode, symlinkTarget: target, before: await store.put(Buffer.from(target, 'utf8')) });
      continue;
    }
    const bytes = await readFile(absolute);
    entries.push({ path, exists: true, mode: stats.mode, before: await store.put(bytes) });
  }
  return { files: entries };
}

/**
 * Restores one file's before-image under an after-image CAS: the current
 * bytes must still hash to the recorded after image, otherwise the external
 * writer wins and we surface a three-way-recovery decision instead of
 * overwriting it. Publication is temp-file + atomic rename.
 */
export async function restoreFileWithCas(store: ContentStore, cwd: string, entry: FileCheckpointEntry, afterSha256: string): Promise<void> {
  validateRepoRelativePath(entry.path);
  const absolute = join(cwd, entry.path);
  const parent = await stat(join(absolute, '..')).catch(() => undefined);
  if (parent?.isSymbolicLink()) {
    throw new GitWorkbenchError({ code: 'STALE_PLAN', message: '父目录被符号链接替换，拒绝写入', repositoryChanged: true, retry: 'refresh' });
  }
  const current = await readFile(absolute).catch(() => Buffer.alloc(0));
  const currentExists = await lstat(absolute).then(() => true, () => false);
  const effectiveAfter = currentExists ? afterSha256 : sha256(Buffer.alloc(0));
  if (sha256(current) !== effectiveAfter) {
    throw new GitWorkbenchError({ code: 'STALE_PLAN', message: `外部修改了 ${entry.path}，需要三方恢复`, repositoryChanged: true, retry: 'refresh' });
  }
  const bytes = await store.get(entry.before);
  const temporary = `${absolute}.git-workbench-restore-${process.pid}`;
  if (entry.symlinkTarget !== undefined) {
    const { symlink } = await import('node:fs/promises');
    await unlink(absolute).catch(() => undefined);
    await symlink(entry.symlinkTarget, absolute);
    return;
  }
  if (!entry.exists) {
    await unlink(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  const file = await open(temporary, 'wx', entry.mode & 0o777 || 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, absolute);
  void writeFile;
}
