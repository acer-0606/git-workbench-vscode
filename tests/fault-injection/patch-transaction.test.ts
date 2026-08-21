import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, buildSelectedPatch, readRawDiff } from '@git-workbench/git-cli';
import { ContentStore, DurableJournal, captureFileCheckpoint, restoreFileWithCas } from '@git-workbench/transactions';
import { sha256 } from '@git-workbench/transactions';

import { PatchService } from '../../src/extension/patch/patchService.js';

const execFileAsync = promisify(execFile);

describe('patch transaction fault injection', () => {
  let fixture: RepositoryFixture;
  let service: PatchService;
  let journalRoot: string;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    await fixture.write('a.ts', `${lines.join('\n')}\n`);
    await fixture.commitAll('base');
    journalRoot = await mkdtemp(join(tmpdir(), 'git-workbench-patch-fault-'));
    service = new PatchService(new GitProcessRunner('git'), fixture.path, 'a'.repeat(64));
  });

  afterAll(async () => {
    await rm(journalRoot, { recursive: true, force: true }).catch(() => undefined);
    await fixture.dispose();
  });

  const dirtyWorktree = async (): Promise<void> => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const changed = lines.map((line, index) => (index === 4 ? `${line} (changed)` : line));
    await fixture.write('a.ts', `${changed.join('\n')}\n`);
  };

  it('classifies a stale raw session after the index changes underneath', async () => {
    await execFileAsync('git', ['reset', '--hard', 'HEAD', '--quiet'], { cwd: fixture.path });
    await dirtyWorktree();
    const token = await service.openSession({ generation: 5, leftIdentity: 'HEAD', rightIdentity: 'worktree', endpoints: ['HEAD'] });
    // External writer stages something after the preview.
    await execFileAsync('git', ['add', 'a.ts'], { cwd: fixture.path });
    const snapshot = await readRawDiff({ runner: new GitProcessRunner('git'), cwd: fixture.path }, ['HEAD']);
    const hunk = snapshot.diff.files[0]!.hunks[0]!;
    const selection = { tokenId: token.id, generation: 5, viewDigest: token.viewDigest, items: [{ kind: 'hunk' as const, path: 'a.ts', rawHunkId: hunk.id }] };
    await expect(service.plan(token, selection, { kind: 'index' }, 5)).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
    service.closeSession(token.id);
  });

  it('restores overwritten working-tree content from the checkpoint after an aborted apply', async () => {
    await execFileAsync('git', ['reset', '--hard', 'HEAD', '--quiet'], { cwd: fixture.path });
    const store = new ContentStore(join(journalRoot, 'store'));
    const before = 'before content\n';
    await fixture.write('a.ts', before);
    const checkpoint = await captureFileCheckpoint(store, fixture.path, ['a.ts']);
    // The operation (or a crash mid-way) overwrote the file.
    await fixture.write('a.ts', 'operation overwrote\n');
    const entry = checkpoint.files[0]!;
    await restoreFileWithCas(store, fixture.path, entry, sha256(Buffer.from('operation overwrote\n')));
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(`${fixture.path}/a.ts`, 'utf8')).toBe(before);
  });

  it('never overwrites externally rescued content when the CAS mismatches', async () => {
    await execFileAsync('git', ['reset', '--hard', 'HEAD', '--quiet'], { cwd: fixture.path });
    const store = new ContentStore(join(journalRoot, 'store'));
    await fixture.write('a.ts', 'v1\n');
    const checkpoint = await captureFileCheckpoint(store, fixture.path, ['a.ts']);
    await fixture.write('a.ts', 'v2\n');
    // External editor writes v3 while the operation was in flight.
    await fixture.write('a.ts', 'v3 external\n');
    const entry = checkpoint.files[0]!;
    await expect(restoreFileWithCas(store, fixture.path, entry, sha256(Buffer.from('v2\n')))).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(`${fixture.path}/a.ts`, 'utf8')).toBe('v3 external\n');
  });

  it('leaves the journal describing the outcome of a failed apply', async () => {
    await execFileAsync('git', ['reset', '--hard', 'HEAD', '--quiet'], { cwd: fixture.path });
    await dirtyWorktree();
    const snapshot = await readRawDiff({ runner: new GitProcessRunner('git'), cwd: fixture.path }, ['HEAD']);
    const hunk = snapshot.diff.files[0]!.hunks[0]!;
    // Apply against a corrupted context by mangling the worktree first.
    await fixture.write('a.ts', 'completely different\n');
    const built = buildSelectedPatch({ files: [{ ...snapshot.diff.files[0]!, hunks: [hunk] }] }, [{ kind: 'hunk', path: 'a.ts', rawHunkId: hunk.id }]);
    await expect(service.applyToWorkingTree(built.bytes)).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });
    // The journal for this manual classification records NeedsAttention.
    const journal = new DurableJournal(journalRoot);
    await journal.append({
      schema: 1,
      operationId: 'patch-fault-1',
      state: 'Planned',
      sequence: 0,
      repositoryId: 'a'.repeat(64),
      planDigest: 'f'.repeat(64),
      updatedAt: new Date().toISOString(),
    });
    await journal.append({
      schema: 1,
      operationId: 'patch-fault-1',
      state: 'Preflight',
      sequence: 1,
      repositoryId: 'a'.repeat(64),
      planDigest: 'f'.repeat(64),
      updatedAt: new Date().toISOString(),
    });
    const records = await journal.readAll('a'.repeat(64), 'patch-fault-1');
    expect(records.map((record) => record.state)).toEqual(['Planned', 'Preflight']);
  });
});
