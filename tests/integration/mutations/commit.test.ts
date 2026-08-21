import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';

import { MutationService } from '../../../src/extension/mutations/mutationService.js';

const execFileAsync = promisify(execFile);

const fixtureId = 'a'.repeat(64);

async function head(path: string): Promise<string> {
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
}

async function stagedPaths(path: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: path });
  return stdout.split('\0').filter(Boolean);
}

async function makeService(fixture: RepositoryFixture): Promise<MutationService> {
  const commonGitDir = (await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: fixture.path })).stdout.trim();
  return MutationService.withEphemeralJournal({
    repositoryId: fixtureId,
    commonRepositoryId: fixtureId,
    commonGitDir,
    cwd: fixture.path,
    generation: 1,
    commonGeneration: 1,
    configFingerprint: 'f'.repeat(64),
  });
}

describe('guarded staging and commits', () => {
  let fixture: RepositoryFixture;
  let services: MutationService[] = [];
  let initialHead: string;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    await fixture.write('a.txt', 'base\n');
    await fixture.commitAll('base');
    initialHead = await head(fixture.path);
  });

  afterAll(async () => {
    for (const service of services) await service.dispose().catch(() => undefined);
    await fixture.dispose();
  });

  it('keeps hooks enabled and never stages unstaged files implicitly', async () => {
    const hookDirectory = join(fixture.path, '.git', 'hooks');
    await mkdir(hookDirectory, { recursive: true });
    const hookRanMarker = join(hookDirectory, 'hook-ran-marker');
    const hookPath = join(hookDirectory, 'commit-msg');
    await writeFile(hookPath, `#!/bin/sh\ntouch '${hookRanMarker}'\nexit 23\n`, { mode: 0o755 });
    await chmod(hookPath, 0o755);

    const service = await makeService(fixture);
    services.push(service);
    await fixture.write('unstaged.txt', 'not reviewed\n');
    // Stage one reviewed modification so the commit attempt reaches the hook.
    await fixture.write('a.txt', 'base\nreviewed change\n');
    const stagePlan = await service.plan({ type: 'stage.files', paths: ['a.txt'] });
    await service.execute(stagePlan, { operationId: String(stagePlan.operationId), planDigest: stagePlan.planDigest });

    const plan = await service.plan({ type: 'commit.create', message: 'message' });
    await expect(service.execute(plan, { operationId: String(plan.operationId), planDigest: plan.planDigest }))
      .rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });

    // The hook really ran and refused the commit; nothing moved and the
    // unstaged file was never implicitly staged.
    expect(await readFile(hookRanMarker, 'utf8').then(() => true, () => false)).toBe(true);
    expect(await stagedPaths(fixture.path)).toEqual(['a.txt']);
    expect(await head(fixture.path)).toBe(initialHead);
    // Housekeeping for later tests: discard the refused staging.
    await execFileAsync('git', ['restore', '--staged', '--', 'a.txt'], { cwd: fixture.path });
    await writeFile(join(fixture.path, 'a.txt'), 'base\n');
  });

  it('commits through stdin with verbatim cleanup and advances HEAD', async () => {
    const hookPath = join(fixture.path, '.git', 'hooks', 'commit-msg');
    await writeFile(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(hookPath, 0o755);

    const service = await makeService(fixture);
    services.push(service);
    await fixture.write('b.txt', 'staged\n');
    const stagePlan = await service.plan({ type: 'stage.files', paths: ['b.txt'] });
    await service.execute(stagePlan, { operationId: String(stagePlan.operationId), planDigest: stagePlan.planDigest });
    expect(await stagedPaths(fixture.path)).toEqual(['b.txt']);

    const message = `subject\n\n# comment line kept verbatim\nbody\twith tab\n`;
    const commitPlan = await service.plan({ type: 'commit.create', message });
    await service.execute(commitPlan, { operationId: String(commitPlan.operationId), planDigest: commitPlan.planDigest });

    const newHead = await head(fixture.path);
    expect(newHead).not.toBe(initialHead);
    const committedMessage = (await execFileAsync('git', ['log', '-1', '--format=%B'], { cwd: fixture.path })).stdout;
    expect(committedMessage).toContain('# comment line kept verbatim');
    expect(committedMessage).toContain('body\twith tab');
    expect(await stagedPaths(fixture.path)).toEqual([]);
  });

  it('stages hostile file names as data, never as arguments', async () => {
    const service = await makeService(fixture);
    services.push(service);
    const hostileNames = ['-n', 'with tab.txt', '中文/文件.txt'];
    for (const name of hostileNames) await fixture.write(name, 'hostile\n');
    const plan = await service.plan({ type: 'stage.files', paths: hostileNames });
    await service.execute(plan, { operationId: String(plan.operationId), planDigest: plan.planDigest });
    const staged = await stagedPaths(fixture.path);
    expect(staged).toEqual(expect.arrayContaining(hostileNames));
    const { stdout: ls } = await execFileAsync('git', ['ls-files', '-s', '-z', '--', '中文'], { cwd: fixture.path });
    expect(ls).toContain('100644');
    const unstageHostile = await service.plan({ type: 'unstage.files', paths: hostileNames });
    await service.execute(unstageHostile, { operationId: String(unstageHostile.operationId), planDigest: unstageHostile.planDigest });
    expect(await stagedPaths(fixture.path)).toEqual(expect.not.arrayContaining(hostileNames));
  });

  it('unstages exact paths against HEAD and on unborn branches', async () => {
    const service = await makeService(fixture);
    services.push(service);
    await fixture.write('c.txt', 'to unstage\n');
    const stagePlan = await service.plan({ type: 'stage.files', paths: ['c.txt'] });
    await service.execute(stagePlan, { operationId: String(stagePlan.operationId), planDigest: stagePlan.planDigest });
    const unstagePlan = await service.plan({ type: 'unstage.files', paths: ['c.txt'] });
    await service.execute(unstagePlan, { operationId: String(unstagePlan.operationId), planDigest: unstagePlan.planDigest });
    expect(await stagedPaths(fixture.path)).toEqual([]);

    // Unborn branch: a fresh repository has no HEAD commit to restore from.
    const unborn = await createRepositoryFixture();
    try {
      await unborn.write('x.txt', 'unborn\n');
      const unbornService = await makeService(unborn);
      services.push(unbornService);
      const unbornStage = await unbornService.plan({ type: 'stage.files', paths: ['x.txt'] });
      await unbornService.execute(unbornStage, { operationId: String(unbornStage.operationId), planDigest: unbornStage.planDigest });
      expect(await stagedPaths(unborn.path)).toEqual(['x.txt']);
      const unbornUnstage = await unbornService.plan({ type: 'unstage.files', paths: ['x.txt'] });
      await unbornService.execute(unbornUnstage, { operationId: String(unbornUnstage.operationId), planDigest: unbornUnstage.planDigest });
      expect(await stagedPaths(unborn.path)).toEqual([]);
      void readFile;
    } finally {
      await unborn.dispose();
    }
  }, 60_000);
});
