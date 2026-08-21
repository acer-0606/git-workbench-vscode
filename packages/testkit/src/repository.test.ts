import { access, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { GitProcessRunner } from '@git-workbench/git-cli';
import { createRepositoryFixture, type RepositoryFixture } from './repository.js';

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function createFixture(): Promise<RepositoryFixture> {
  const fixture = await createRepositoryFixture();
  fixtures.push(fixture);
  return fixture;
}

async function runQuery(fixture: RepositoryFixture, args: readonly string[], cwd = fixture.path): Promise<string> {
  const result = await fixture.runner.run({
    args,
    cwd,
    kind: 'query',
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  expect(result.exitCode).toBe(0);
  return result.stdoutText();
}

describe('createRepositoryFixture', () => {
  test('creates a private filesystem boundary for fixture writes', async () => {
    const fixture = await createFixture();
    const metadata = await stat(fixture.path);

    if (process.platform !== 'win32') expect(metadata.mode & 0o077).toBe(0);
  });

  test('creates an isolated repository that commits special file names', async () => {
    const fixture = await createFixture();
    const fileName = '目录/space and\nnewline.txt';

    await fixture.write(fileName, 'fixture contents');
    const enableSigning = await fixture.runner.run({
      args: ['config', '--local', 'commit.gpgSign', 'true'],
      cwd: fixture.path,
      kind: 'mutation',
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    expect(enableSigning.exitCode).toBe(0);
    const oid = await fixture.commitAll('initial fixture commit');

    expect(fixture.runner).toBeInstanceOf(GitProcessRunner);
    expect(oid).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
    await expect(readFile(join(fixture.path, fileName), 'utf8')).resolves.toBe('fixture contents');
    await expect(runQuery(fixture, ['branch', '--show-current'])).resolves.toBe('main\n');
    await expect(runQuery(fixture, ['log', '-1', '--format=%an <%ae>'])).resolves.toBe('Git Workbench Test <test@git-workbench.invalid>\n');
    await expect(runQuery(fixture, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])).resolves.toBe(`${fileName}\0`);
  });

  test('creates and removes sibling linked worktrees', async () => {
    const fixture = await createFixture();
    await fixture.write('README.md', '# fixture\n');
    await fixture.commitAll('initial fixture commit');

    const linked = await fixture.addWorktree('feature/testkit');
    const linkedRealPath = await realpath(linked);

    expect(linked).not.toBe(fixture.path);
    await expect(access(join(linked, 'README.md'))).resolves.toBeUndefined();
    await expect(runQuery(fixture, ['worktree', 'list', '--porcelain'])).resolves.toContain(`worktree ${linkedRealPath}\n`);
    await fixture.dispose();
    await expect(access(linked)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('refuses a write that escapes through a symbolic-link ancestor', async () => {
    const fixture = await createFixture();
    const outsidePath = await mkdtemp(join(tmpdir(), 'git-workbench-outside-'));
    try {
      await symlink(outsidePath, join(fixture.path, 'outside'));

      await expect(fixture.write('outside/escaped.txt', 'must not escape')).rejects.toThrow('must not resolve through a symbolic link');
      await expect(access(join(outsidePath, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'win32')('refuses a write that escapes through a junction ancestor', async () => {
    const fixture = await createFixture();
    const outsidePath = await mkdtemp(join(tmpdir(), 'git-workbench-outside-junction-'));
    try {
      await symlink(outsidePath, join(fixture.path, 'outside-junction'), 'junction');

      await expect(fixture.write('outside-junction/escaped.txt', 'must not escape')).rejects.toThrow('must not resolve through a symbolic link');
      await expect(access(join(outsidePath, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  test('refuses case-variant Git metadata paths', async () => {
    const fixture = await createFixture();

    await expect(fixture.write('.GIT/config', 'must not modify Git metadata')).rejects.toThrow('must not modify Git metadata');
  });

  test('rejects platform-ambiguous file names before writing', async () => {
    const fixture = await createFixture();

    await expect(fixture.write('notes.txt:ads', 'must not create an ADS')).rejects.toThrow('not supported');
    await expect(fixture.write('CON.txt', 'must not create a device path')).rejects.toThrow('not supported');
    await expect(fixture.write('COM¹.txt', 'must not create a superscript device alias')).rejects.toThrow('not supported');
    await expect(fixture.write('CONIN$.txt', 'must not create a console device alias')).rejects.toThrow('not supported');
    await expect(fixture.write('trailing. ', 'must not create an aliased path')).rejects.toThrow('not supported');
    await expect(fixture.write('GIT~1/config', 'must not guess an 8.3 metadata alias')).rejects.toThrow('not supported');
  });

  test('keeps the fixture runner isolated when callers provide a hostile global config', async () => {
    const fixture = await createFixture();
    const configDirectory = await mkdtemp(join(tmpdir(), 'git-workbench-hostile-config-'));
    const hostileConfig = join(configDirectory, 'global.gitconfig');
    await writeFile(hostileConfig, '[alias]\nfixture-hostile = !false\n', 'utf8');
    try {
      const result = await fixture.runner.run({
        args: ['config', '--get', 'alias.fixture-hostile'],
        cwd: fixture.path,
        kind: 'query',
        env: { GIT_CONFIG_GLOBAL: hostileConfig },
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });

      expect(result.exitCode).toBe(1);
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  test('retries cleanup after an injected root removal failure while attempting linked cleanup', async () => {
    let fixturePath = '';
    let linkedPath = '';
    let failRootRemoval = true;
    const attemptedRemovals: string[] = [];
    const fixture = await createRepositoryFixture({
      removePath: async (path) => {
        attemptedRemovals.push(path);
        if (path === fixturePath && failRootRemoval) {
          failRootRemoval = false;
          throw new Error('simulated root removal failure');
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    fixtures.push(fixture);
    fixturePath = fixture.path;
    await fixture.write('README.md', '# fixture\n');
    await fixture.commitAll('initial fixture commit');
    linkedPath = await fixture.addWorktree('cleanup/retry');

    await expect(fixture.dispose()).rejects.toThrow('Git fixture cleanup failed');
    expect(attemptedRemovals).toContain(linkedPath);
    expect(attemptedRemovals).toContain(fixture.path);
    await expect(access(fixture.path)).resolves.toBeUndefined();
    await fixture.dispose();
    await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(linkedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('preserves a failed worktree creation error when its cleanup must be retried', async () => {
    let failWorktreeCleanup = true;
    const attemptedRemovals: string[] = [];
    const fixture = await createRepositoryFixture({
      removePath: async (path) => {
        attemptedRemovals.push(path);
        if (path.includes('-worktree-') && failWorktreeCleanup) {
          failWorktreeCleanup = false;
          throw new Error('simulated failed worktree cleanup');
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    fixtures.push(fixture);
    await fixture.write('README.md', '# fixture\n');
    await fixture.commitAll('initial fixture commit');

    await expect(fixture.addWorktree('main')).rejects.toThrow('Git fixture command failed');
    expect(attemptedRemovals.some((path) => path.includes('-worktree-'))).toBe(true);
    await fixture.dispose();
    expect(attemptedRemovals.filter((path) => path.includes('-worktree-'))).toHaveLength(2);
  });

  test('disposes repeatedly without leaving its repository directory behind', async () => {
    const fixture = await createFixture();
    const repositoryPath = fixture.path;

    await fixture.dispose();
    await fixture.dispose();

    await expect(access(repositoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
