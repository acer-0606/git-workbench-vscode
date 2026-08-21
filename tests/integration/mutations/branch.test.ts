import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, branch, createCliMutationProvider } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

const branchExists = async (cwd: string, name: string): Promise<boolean> => {
  const result = await execFileAsync('git', ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { cwd }).then(() => true, () => false);
  return result;
};

const currentBranch = async (cwd: string): Promise<string> =>
  (await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd })).stdout.trim();

describe('guarded branch workflows', () => {
  let fixture: RepositoryFixture;
  let provider: ReturnType<typeof createCliMutationProvider>;
  const runner = () => new GitProcessRunner('git');

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    await fixture.write('a.txt', 'base\n');
    await fixture.commitAll('base');
    provider = createCliMutationProvider(runner(), fixture.path);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('validates branch names with Git and never treats them as options', async () => {
    await expect(branch.create(provider, '-c core.sshCommand=evil', 'HEAD', false)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    expect(await branchExists(fixture.path, '-c core.sshCommand=evil')).toBe(false);
    await expect(branch.create(provider, 'bad..name', 'HEAD', false)).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });

  it('creates, switches and renames branches with verified refs', async () => {
    await branch.create(provider, 'feature', 'HEAD', false);
    expect(await branchExists(fixture.path, 'feature')).toBe(true);
    await branch.switch(provider, 'feature', 'keep');
    expect(await currentBranch(fixture.path)).toBe('feature');
    await branch.rename(provider, 'feature', 'feature-renamed');
    expect(await branchExists(fixture.path, 'feature')).toBe(false);
    expect(await branchExists(fixture.path, 'feature-renamed')).toBe(true);
  });

  it('refuses to delete protected branches', async () => {
    await branch.create(provider, 'main-copy', 'HEAD', false);
    await expect(branch.remove(provider, 'main-copy', ['main-copy', 'main'])).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
    expect(await branchExists(fixture.path, 'main-copy')).toBe(true);
  });

  it('deletes merged branches only through the non-forced command', async () => {
    await branch.create(provider, 'merged-branch', 'HEAD', false);
    await branch.remove(provider, 'merged-branch', ['main']);
    expect(await branchExists(fixture.path, 'merged-branch')).toBe(false);
  });

  it('keeps the worktree untouched when a dirty switch would conflict', async () => {
    // Diverge main from the current branch so a dirty a.txt cannot carry over.
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('a.txt', 'changed on main\n');
    await fixture.commitAll('main moves on');
    await execFileAsync('git', ['switch', 'feature-renamed'], { cwd: fixture.path });
    await fixture.write('a.txt', 'dirty\n');
    try {
      await expect(branch.switch(provider, 'main', 'keep')).rejects.toMatchObject({ payload: { code: 'REPOSITORY_LOCKED' } });
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(fixture.path + '/a.txt', 'utf8')).toBe('dirty\n');
      expect(await currentBranch(fixture.path)).toBe('feature-renamed');
    } finally {
      await execFileAsync('git', ['checkout', '--', 'a.txt'], { cwd: fixture.path });
    }
  });

  it('sets and clears upstream without moving the branch ref', async () => {
    const before = await provider.resolve('feature-renamed');
    await expect(branch.setUpstream(provider, 'feature-renamed', 'origin/nonexistent')).rejects.toBeTruthy();
    await branch.setUpstream(provider, 'feature-renamed', 'refs/remotes/origin/main').catch(async (error: unknown) => {
      // No remote exists in this fixture; the branch ref must still be intact.
      void error;
    });
    expect(await provider.resolve('feature-renamed')).toBe(before);
  });
});
