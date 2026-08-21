import { describe, expect, it } from 'vitest';
import { createRepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, readLogPage, readRefs, readStashes, readWorktrees } from '@git-workbench/git-cli';

describe('paged log and ref reads', () => {
  it('paginates a real merge DAG without duplicates or gaps and preserves parent order', async () => {
    const fixture = await createRepositoryFixture();
    try {
      const runner = new GitProcessRunner('git');
      await fixture.write('root.txt', 'root\n');
      const commits: string[] = [];
      commits.push(await fixture.commitAll('root'));
      await fixture.write('second.txt', 'second\n');
      commits.push(await fixture.commitAll('second'));
      await fixture.write('third.txt', 'third\n');
      const mainTip = await fixture.commitAll('third on main');
      void mainTip;

      // Build a real merge commit with two parents via a diverged topic branch.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['switch', '-c', 'topic'], { cwd: fixture.path });
      await fixture.write('branch.txt', 'topic line\n');
      const topicTip = await fixture.commitAll('topic commit');
      await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
      await execFileAsync('git', ['merge', '--no-ff', '-m', 'merge topic into main', 'topic'], { cwd: fixture.path });
      const mergeOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
      void mainTip;

      const seen: string[] = [];
      let cursor: string | undefined;
      let mergeRow: { oid: string; parents: string[] } | undefined;
      for (;;) {
        const page = await readLogPage(runner, fixture.path, 1, 'topo', 2, cursor);
        for (const row of page.rows) {
          seen.push(row.oid);
          if (row.oid === mergeOid) mergeRow = { oid: row.oid, parents: [...row.parents] };
        }
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toContain(mergeOid);
      expect(seen.length).toBeGreaterThanOrEqual(5);
      expect(mergeRow?.parents).toHaveLength(2);
      expect(mergeRow?.parents[1]).toBe(topicTip);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a cursor minted for a different generation', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('root.txt', 'root\n');
      await fixture.commitAll('root');
      await fixture.write('b.txt', 'b\n');
      await fixture.commitAll('second');
      await fixture.write('c.txt', 'c\n');
      await fixture.commitAll('third');
      const runner = new GitProcessRunner('git');
      const first = await readLogPage(runner, fixture.path, 1, 'topo', 2);
      await expect(readLogPage(runner, fixture.path, 2, 'topo', 2, first.nextCursor)).rejects.toThrow('stale or invalid log cursor');
    } finally {
      await fixture.dispose();
    }
  });

  it('reads branches, tags, stashes and worktrees from a real repository', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('a.txt', 'base\n');
      const first = await fixture.commitAll('root');
      await fixture.write('a.txt', 'change\n');
      const second = await fixture.commitAll('second');
      const runner = new GitProcessRunner('git');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['tag', 'v1.0'], { cwd: fixture.path });
      await fixture.write('a.txt', 'dirty change\n');
      await execFileAsync('git', ['stash', 'push', '-m', 'wip change'], { cwd: fixture.path });
      await execFileAsync('git', ['worktree', 'add', '--quiet', `${fixture.path}-wt`, first], { cwd: fixture.path });

      const refs = await readRefs(runner, fixture.path);
      expect(refs.filter((ref) => ref.kind === 'branch' && ref.isHead).map((ref) => ref.displayName)).toEqual([expect.any(String)]);
      expect(refs.find((ref) => ref.kind === 'tag' && ref.displayName === 'v1.0')?.oid).toBe(second);

      const stashes = await readStashes(runner, fixture.path);
      expect(stashes).toHaveLength(1);
      expect(stashes[0]?.subject).toContain('wip change');

      const worktrees = await readWorktrees(runner, fixture.path);
      expect(worktrees).toHaveLength(2);
      expect(worktrees.every((worktree) => !worktree.bare)).toBe(true);
    } finally {
      await import('node:fs').then((fs) => fs.rmSync(`${fixture.path}-wt`, { recursive: true, force: true }));
      await fixture.dispose();
    }
  });
});
