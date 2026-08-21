import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { GitWorkbenchError } from '@git-workbench/domain';

export interface ContentRef { readonly digest: string; readonly bytes: number }

/**
 * Content-addressed store for recovery snapshots. Objects are published via
 * flushed temporary files and same-directory hard links, so a digest either
 * exists completely or not at all; existing objects are never overwritten
 * and every read verifies the hash and byte count.
 */
export class ContentStore {
  constructor(private readonly root: string) {}

  async put(content: Uint8Array): Promise<ContentRef> {
    const digest = createHash('sha256').update(content).digest('hex');
    const directory = join(this.root, 'objects', digest.slice(0, 2));
    const target = join(directory, digest.slice(2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(target);
        if (!Buffer.from(existing).equals(Buffer.from(content))) throw new GitWorkbenchError({ code: 'CORRUPT_REPOSITORY', message: '内容寻址对象冲突或损坏', repositoryChanged: false, retry: 'none' });
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return { digest, bytes: content.byteLength };
  }

  async get(ref: ContentRef): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(ref.digest) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new GitWorkbenchError({ code: 'CORRUPT_REPOSITORY', message: '恢复快照引用无效', repositoryChanged: false, retry: 'none' });
    const content = await readFile(join(this.root, 'objects', ref.digest.slice(0, 2), ref.digest.slice(2)));
    if (content.byteLength !== ref.bytes || createHash('sha256').update(content).digest('hex') !== ref.digest) throw new GitWorkbenchError({ code: 'CORRUPT_REPOSITORY', message: '恢复快照校验失败', repositoryChanged: false, retry: 'none' });
    return content;
  }
}
