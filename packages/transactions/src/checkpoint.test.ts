import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureFileCheckpoint, restoreFileWithCas } from './checkpoint.js';
import { ContentStore } from './contentStore.js';
import { sha256 } from './refCheckpoint.js';

describe('file checkpoints', () => {
  let root: string;
  let cwd: string;
  let store: ContentStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-workbench-checkpoint3-'));
    cwd = join(root, 'work');
    store = new ContentStore(join(root, 'store'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('snapshots and restores plain files under the after-image CAS', async () => {
    await writeFile(join(cwd, 'a.txt'), 'before\n');
    const checkpoint = await captureFileCheckpoint(store, cwd, ['a.txt']);
    await writeFile(join(cwd, 'a.txt'), 'after\n');
    const entry = checkpoint.files[0]!;
    await restoreFileWithCas(store, cwd, entry, sha256(Buffer.from('after\n')));
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('before\n');
  });

  it('refuses to overwrite externally modified content', async () => {
    await writeFile(join(cwd, 'a.txt'), 'before\n');
    const checkpoint = await captureFileCheckpoint(store, cwd, ['a.txt']);
    await writeFile(join(cwd, 'a.txt'), 'external writer\n');
    const entry = checkpoint.files[0]!;
    await expect(restoreFileWithCas(store, cwd, entry, sha256(Buffer.from('after\n')))).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('external writer\n');
  });

  it('snapshots symlinks as links and restores the link, not its target', async () => {
    await writeFile(join(cwd, 'real.txt'), 'real\n');
    await symlink('real.txt', join(cwd, 'link.txt'));
    const checkpoint = await captureFileCheckpoint(store, cwd, ['link.txt']);
    await rm(join(cwd, 'link.txt'));
    await writeFile(join(cwd, 'link.txt'), 'now a plain file\n');
    const entry = checkpoint.files[0]!;
    await restoreFileWithCas(store, cwd, entry, sha256(Buffer.from('now a plain file\n')));
    const { lstat } = await import('node:fs/promises');
    expect((await lstat(join(cwd, 'link.txt'))).isSymbolicLink()).toBe(true);
  });

  it('restores the did-not-exist state for files created by the operation', async () => {
    const checkpoint = await captureFileCheckpoint(store, cwd, ['created-later.txt']);
    await writeFile(join(cwd, 'created-later.txt'), 'created\n');
    const entry = checkpoint.files[0]!;
    await restoreFileWithCas(store, cwd, entry, sha256(Buffer.from('created\n')));
    await expect(readFile(join(cwd, 'created-later.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
