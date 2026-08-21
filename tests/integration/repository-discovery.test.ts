import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositoryFixture } from '@git-workbench/testkit';
import { discoverRepositories, WorkspaceFolderDiscoveryScheduler } from '../../src/extension/repositoryDiscovery.js';
import { locateRepository } from '@git-workbench/git-cli';

const descriptor = {
  id: 'a'.repeat(64) as never,
  commonRepositoryId: 'b'.repeat(64) as never,
  worktreeUri: 'file:///root/good',
  commonDirUri: 'file:///root/good/.git',
  mode: 'compatibilityReadOnly' as const,
  objectFormat: 'sha1' as const,
};

describe('bounded repository discovery', () => {
  it('finds nested repositories only through .git markers and does not follow symlinks', async () => {
    const fixture = await createRepositoryFixture();
    const nested = await createRepositoryFixture();
    try {
      const markerParent = join(fixture.path, 'nested');
      await mkdir(markerParent);
      await writeFile(join(markerParent, '.git'), `gitdir: ${join(nested.path, '.git')}\n`);
      await symlink(fixture.path, join(fixture.path, 'cycle'));
      const result = await discoverRepositories([fixture.path], (path) => locateRepository(fixture.runner, path, { trusted: false }), {
        mode: 'subFolders', scanDepth: 2,
      });

      expect(result.partial).toBe(false);
      expect(result.repositories).toHaveLength(2);
      // mkdtemp may hand back a Windows 8.3 short name while Git reports the
      // long form; compare canonicalized real paths instead of raw strings.
      const normalize = (value: string): string => decodeURIComponent(value).replace(/\\/g, '/').toLowerCase();
      const markerParentReal = await realpath(markerParent);
      expect(result.repositories.some((repository) => normalize(repository.worktreeUri).includes(normalize(markerParentReal)))).toBe(true);
    } finally {
      await nested.dispose();
      await fixture.dispose();
    }
  });

  it('does not invoke the locator in off mode and reports a bounded scan', async () => {
    const fixture = await createRepositoryFixture();
    try {
      let calls = 0;
      const locator = async () => { calls += 1; return undefined; };
      expect((await discoverRepositories([fixture.path], locator, { mode: 'off', scanDepth: 2 })).repositories).toEqual([]);
      expect(calls).toBe(0);

      const bounded = await discoverRepositories([fixture.path], locator, { mode: 'subFolders', scanDepth: 2, maxDirectories: 0 });
      expect(bounded.partial).toBe(true);
      expect(bounded.diagnostics.some((diagnostic) => diagnostic.code === 'scanBudgetExceeded')).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('still processes a single workspace root when the directory budget is one', async () => {
    const fixture = await createRepositoryFixture();
    try {
      const calls: string[] = [];
      const result = await discoverRepositories([fixture.path], async (path) => {
        calls.push(path);
        return undefined;
      }, { mode: 'subFolders', scanDepth: 1, maxDirectories: 1 });
      expect(result.partial).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('marks discovery partial when a configured workspace root cannot be canonicalized', async () => {
    const fixture = await createRepositoryFixture();
    try {
      const result = await discoverRepositories([join(fixture.path, 'does-not-exist')], async () => undefined, {
        mode: 'openFolders', scanDepth: 1,
      });
      expect(result.partial).toBe(true);
      expect(result.diagnostics).toContainEqual({ code: 'scanError' });
    } finally {
      await fixture.dispose();
    }
  });

  it('debounces workspace-folder changes for 250ms and uses the latest folder list', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[][] = [];
      const scheduler = new WorkspaceFolderDiscoveryScheduler(async (folders) => { calls.push([...folders]); });
      scheduler.update(['/one']);
      scheduler.update(['/two']);
      await vi.advanceTimersByTimeAsync(249);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([['/two']]);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes overlapping scans latest-wins and consumes scheduled callback failures', async () => {
    vi.useFakeTimers();
    try {
      let releaseOlder: (() => void) | undefined;
      const observed: string[] = [];
      const scheduler = new WorkspaceFolderDiscoveryScheduler(async (folders, signal) => {
        if (folders[0] === '/older') await new Promise<void>((resolve) => { releaseOlder = resolve; });
        if (!signal.aborted) observed.push(folders[0]!);
        if (folders[0] === '/failure') throw new Error('expected scheduler failure');
      });
      const older = scheduler.runNow(['/older']);
      scheduler.update(['/newer']);
      await vi.advanceTimersByTimeAsync(250);
      releaseOlder!();
      await older;
      scheduler.update(['/failure']);
      await vi.advanceTimersByTimeAsync(250);

      expect(observed).toEqual(['/newer', '/failure']);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops during a wide directory before it queues candidates beyond the budget', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await Promise.all(['one', 'two', 'three'].map((name) => mkdir(join(fixture.path, name))));
      const result = await discoverRepositories([fixture.path], async () => undefined, {
        mode: 'subFolders', scanDepth: 1, maxDirectories: 2,
      });
      expect(result.partial).toBe(true);
      expect(result.diagnostics).toContainEqual({ code: 'scanBudgetExceeded' });
    } finally {
      await fixture.dispose();
    }
  });

  it('checks elapsed time while enumerating entries and degrades to partial', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await mkdir(join(fixture.path, 'child'));
      const timestamps = [0, 0, 0, 3];
      const result = await discoverRepositories([fixture.path], async () => undefined, {
        mode: 'subFolders', scanDepth: 1, maxElapsedMs: 2, now: () => timestamps.shift() ?? 3,
      });
      expect(result.partial).toBe(true);
      expect(result.diagnostics).toContainEqual({ code: 'scanTimeExceeded' });
    } finally {
      await fixture.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('marks permission failures partial rather than escaping the scan', async () => {
    const fixture = await createRepositoryFixture();
    const locked = join(fixture.path, 'locked');
    try {
      await mkdir(locked);
      await chmod(locked, 0o000);
      const result = await discoverRepositories([locked], async () => undefined, { mode: 'subFolders', scanDepth: 1 });
      expect(result.partial).toBe(true);
      expect(result.diagnostics).toContainEqual({ code: 'scanError' });
    } finally {
      await chmod(locked, 0o700).catch(() => undefined);
      await fixture.dispose();
    }
  });

  it('continues with sibling directories after one child cannot be canonicalized', async () => {
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    const marker = { name: '.git', isDirectory: () => true, isSymbolicLink: () => false };
    const fileSystem = {
      lstat: async (_path: string) => directory,
      realpath: async (path: string) => {
        if (path.replace(/\\/g, '/').endsWith('/root/bad')) throw new Error('permission denied');
        return path;
      },
      readdir: async (path: string) => path.replace(/\\/g, '/') === '/root'
        ? [{ name: 'bad', ...directory }, { name: 'good', ...directory }]
        : path.replace(/\\/g, '/') === '/root/good' ? [marker] : [],
    };
    const result = await discoverRepositories(['/root'], async (path) => path.replace(/\\/g, '/').endsWith('/root/good') ? descriptor : undefined, {
      mode: 'subFolders', scanDepth: 1, fileSystem,
    });
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContainEqual({ code: 'scanError' });
    expect(result.repositories).toEqual([descriptor]);
  });
});
