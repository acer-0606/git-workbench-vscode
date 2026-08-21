import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { ContentStore } from './contentStore.js';

it('deduplicates binary content and verifies every read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-workbench-store-'));
  try {
    const store = new ContentStore(root);
    const bytes = Uint8Array.from([0, 255, 1, 2]);
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    expect(first.digest).toBe(second.digest);
    expect(Uint8Array.from(await store.get(first))).toEqual(bytes);
    await writeFile(join(root, 'objects', first.digest.slice(0, 2), first.digest.slice(2)), Uint8Array.from([9]));
    await expect(store.get(first)).rejects.toMatchObject({ payload: { code: 'CORRUPT_REPOSITORY' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
