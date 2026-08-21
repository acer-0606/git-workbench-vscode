import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { restoreIndexWithCas, sha256, type RefCheckpoint } from './refCheckpoint.js';

const checkpointFor = (bytes: Buffer): RefCheckpoint => ({
  refs: [],
  index: { bytes, sha256: sha256(bytes), mode: 0o100644, exists: true },
  affectedPaths: [],
});

describe('restoreIndexWithCas', () => {
  let root: string;
  let indexPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-workbench-checkpoint-'));
    indexPath = join(root, 'index');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('restores checkpoint bytes when the after-image still matches', async () => {
    const original = Buffer.from('index-v1');
    const mutated = Buffer.from('index-v2');
    await writeFile(indexPath, mutated);
    await restoreIndexWithCas(indexPath, checkpointFor(original), sha256(mutated));
    expect(await readFile(indexPath)).toEqual(original);
  });

  it('refuses to overwrite when another writer changed the index first', async () => {
    const original = Buffer.from('index-v1');
    const external = Buffer.from('index-external');
    await writeFile(indexPath, external);
    await expect(restoreIndexWithCas(indexPath, checkpointFor(original), sha256(Buffer.from('index-v2')))).rejects.toThrow('CAS_FAILED');
    expect(await readFile(indexPath)).toEqual(external);
  });

  it('returns REPOSITORY_LOCKED when a foreign index.lock exists', async () => {
    await writeFile(indexPath, Buffer.from('current'));
    await writeFile(`${indexPath}.lock`, Buffer.from('foreign'));
    await expect(restoreIndexWithCas(indexPath, checkpointFor(Buffer.from('old')), sha256(Buffer.from('current')))).rejects.toThrow('REPOSITORY_LOCKED');
    // The foreign lock is never deleted by this plugin.
    expect(await readFile(`${indexPath}.lock`)).toEqual(Buffer.from('foreign'));
  });
});
