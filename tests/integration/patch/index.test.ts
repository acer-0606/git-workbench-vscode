import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner } from '@git-workbench/git-cli';

import { PatchService } from '../../../src/extension/patch/patchService.js';

const execFileAsync = promisify(execFile);

const stagedPaths = async (cwd: string): Promise<string[]> => {
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd });
  return stdout.split('\0').filter(Boolean);
};

const fileContent = async (cwd: string, path: string): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile(`${cwd}/${path}`, 'utf8');
};

let patchToken: ReturnType<PatchService['openSession']> extends Promise<infer T> ? T : never;

describe('patch application', () => {
  let fixture: RepositoryFixture;
  let service: PatchService;
  let hunkOneId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawHunk: any;
  let addLineIds: string[];

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    await fixture.write('a.ts', `${lines.join('\n')}\n`);
    await fixture.commitAll('base');
    const changed = lines.map((line, index) => (index === 4 ? `${line} (changed)` : line)).concat(['appended line']);
    await fixture.write('a.ts', `${changed.join('\n')}\n`);

    service = new PatchService(new GitProcessRunner('git'), fixture.path, 'a'.repeat(64));
    const token = await service.openSession({ generation: 1, leftIdentity: 'HEAD', rightIdentity: 'worktree', endpoints: ['HEAD'] });
    patchToken = token;
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('applies a selected single change to the index without touching the worktree', async () => {
    const token = patchToken!;
    const probe = await service.openSession({ generation: 1, leftIdentity: 'probe', rightIdentity: 'worktree', endpoints: ['HEAD'] });
    await service.closeSession(probe.id);

    // Discover change line ids from the raw session by planning the whole file first.
    const { readRawDiff } = await import('@git-workbench/git-cli');
    const snapshot = await readRawDiff({ runner: new GitProcessRunner('git'), cwd: fixture.path }, ['HEAD']);
    const hunk = snapshot.diff.files[0]!.hunks[0]!;
    hunkOneId = hunk.id;
    addLineIds = hunk.lines.filter((line) => line.marker === '+' || line.marker === '-').map((line) => line.id);
    rawHunk = hunk;
    void token;

    const selection = { tokenId: patchToken!.id, generation: 1, viewDigest: patchToken!.viewDigest, items: [{ kind: 'hunk' as const, path: 'a.ts', rawHunkId: hunk.id }] };
    const plan = await service.plan(patchToken!, selection, { kind: 'index' }, 1);
    await service.applyToIndex(plan.bytes);

    expect(await stagedPaths(fixture.path)).toEqual(['a.ts']);
    // The staged content keeps the change while the working tree still has both changes.
    const staged = (await execFileAsync('git', ['show', ':a.ts'], { cwd: fixture.path })).stdout;
    expect(staged).toContain('(changed)');
    const worktree = await fileContent(fixture.path, 'a.ts');
    expect(worktree).toContain('appended line');
  });

  it('rejects a stale selection from another generation', async () => {
    const token = patchToken!;
    const selection = { tokenId: token.id, generation: 1, viewDigest: token.viewDigest, items: [{ kind: 'hunk' as const, path: 'a.ts', rawHunkId: hunkOneId }] };
    await expect(service.plan(token, selection, { kind: 'index' }, 2)).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
  });

  it('rejects a selection made against a closed or foreign token', async () => {
    const token = patchToken!;
    const foreign = { ...token, id: 'not-open' };
    const selection = { tokenId: 'not-open', generation: 1, viewDigest: token.viewDigest, items: [{ kind: 'hunk' as const, path: 'a.ts', rawHunkId: hunkOneId }] };
    await expect(service.plan(foreign, selection, { kind: 'index' }, 1)).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
  });

  it('applies selected lines from a commit range to the base worktree', async () => {
    // Build A -> B where B changes one line and appends another, then put the
    // worktree back on A: the raw diff is A->B and the working tree is the
    // patch context, exactly like the cherry-pick-style apply flow.
    await execFileAsync('git', ['reset', '--hard', 'HEAD', '--quiet'], { cwd: fixture.path });
    await execFileAsync('git', ['clean', '-fd'], { cwd: fixture.path });
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const changed = lines.map((line, index) => (index === 4 ? `${line} (changed)` : line)).concat(['appended line']);
    await fixture.write('a.ts', `${changed.join('\n')}\n`);
    await fixture.commitAll('changed for range');
    const changedOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
    await execFileAsync('git', ['reset', '--hard', 'HEAD~1', '--quiet'], { cwd: fixture.path });

    const fresh = await service.openSession({ generation: 3, leftIdentity: 'HEAD', rightIdentity: changedOid, endpoints: ['HEAD', changedOid] });
    const selection = { tokenId: fresh.id, generation: 3, viewDigest: fresh.viewDigest, items: [{ kind: 'lines' as const, path: 'a.ts', rawHunkId: hunkOneId, lineIds: addLineIds.slice(0, 2) }] };
    const plan = await service.plan(fresh, selection, { kind: 'workingTree' }, 3);
    await service.applyToWorkingTree(plan.bytes);
    const content = await fileContent(fixture.path, 'a.ts');
    expect(content).toContain('(changed)');
    await service.closeSession(fresh.id);
  });
});
