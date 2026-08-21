import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, createCliMutationProvider, stash } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

const stashList = async (cwd: string): Promise<string[]> => {
  const result = await execFileAsync('git', ['stash', 'list', '--format=%H'], { cwd }).catch(() => ({ stdout: '' }));
  return result.stdout.split('\n').filter(Boolean);
};

const isClean = async (cwd: string): Promise<boolean> => {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  return stdout.trim() === '';
};

describe('recoverable stash workflows', () => {
  let fixture: RepositoryFixture;
  let provider: ReturnType<typeof createCliMutationProvider>;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    await fixture.write('a.txt', 'base\n');
    await fixture.commitAll('base');
    provider = createCliMutationProvider(new GitProcessRunner('git'), fixture.path);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('creates a stash with verified refs/stash advancement and restores it', async () => {
    await fixture.write('a.txt', 'change\n');
    const oid = await stash.create(provider, { message: 'wip', includeUntracked: false, keepIndex: false, stagedOnly: false });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await isClean(fixture.path)).toBe(true);

    await stash.apply(provider, { selector: 'stash@{0}', dropAfterSuccess: false });
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(`${fixture.path}/a.txt`, 'utf8')).replace(/\r\n/g, '\n')).toBe('change\n');
    expect(await stashList(fixture.path)).toHaveLength(1);
  });

  it('uses native pop and keeps the stash when application conflicts', async () => {
    // Reset the applied change back into a clean state, then rebuild a stash.
    const { rm } = await import('node:fs/promises');
    await rm(`${fixture.path}/a.txt`);
    await execFileAsync('git', ['checkout', '--', 'a.txt'], { cwd: fixture.path });
    // Drop the leftover stash from the previous test.
    await stash.drop(provider, 'stash@{0}');

    // Stash a change to a.txt, then modify a.txt on the branch to conflict.
    await fixture.write('a.txt', 'stashed version\n');
    await stash.create(provider, { message: 'conflicting', includeUntracked: false, keepIndex: false, stagedOnly: false });
    await fixture.write('a.txt', 'branch version\n');
    await fixture.commitAll('branch moves');

    await expect(stash.apply(provider, { selector: 'stash@{0}', dropAfterSuccess: true }))
      .rejects.toMatchObject({ payload: { code: 'CONFLICT_PAUSED' } });
    expect(await stashList(fixture.path)).toHaveLength(1);
  });

  it('drops an exact verified stash and rejects malformed selectors', async () => {
    // Reset the conflict state left by the previous test.
    await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: fixture.path });
    await expect(stash.apply(provider, { selector: 'stash@{not-a-number}', dropAfterSuccess: false })).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    await expect(stash.apply(provider, { selector: 'stash@{9}', dropAfterSuccess: false })).rejects.toMatchObject({ payload: { code: 'POSTCONDITION_FAILED' } });
    await stash.drop(provider, 'stash@{0}');
    expect(await stashList(fixture.path)).toHaveLength(0);
  });
});
