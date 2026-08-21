import { describe, expect, it } from 'vitest';
import { createRepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, planComparison, readComparisonFileList, readFilePatch } from '@git-workbench/git-cli';

import type { CompareEndpoint } from '@git-workbench/domain';

const endpoint = (kind: CompareEndpoint['kind'], value: string): CompareEndpoint => ({ kind, value, label: value });

describe('comparison planning', () => {
  it('resolves commit auto directly and diverged branch auto through merge-base', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('a.txt', 'base\n');
      const base = await fixture.commitAll('base');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['switch', '-c', 'topic'], { cwd: fixture.path });
      await fixture.write('topic.txt', 'topic\n');
      const topicTip = await fixture.commitAll('topic');
      await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
      await fixture.write('main.txt', 'main\n');
      const mainTip = await fixture.commitAll('main');

      const runner = new GitProcessRunner('git');
      const provider = { runner, cwd: fixture.path };

      const commitPlan = await planComparison(provider, endpoint('commit', base), endpoint('commit', mainTip), 'auto', 4);
      expect(commitPlan.effectiveMode).toBe('direct');
      expect(commitPlan.baseArgs).toEqual([base, mainTip]);
      expect(commitPlan.generation).toBe(4);

      const branchPlan = await planComparison(provider, endpoint('branch', 'main'), endpoint('branch', 'topic'), 'auto', 4);
      expect(branchPlan.effectiveMode).toBe('mergeBase');
      expect(branchPlan.baseArgs).toEqual([base, topicTip]);

      const explicit = await planComparison(provider, endpoint('branch', 'main'), endpoint('branch', 'topic'), 'direct', 4);
      expect(explicit.effectiveMode).toBe('direct');
      expect(explicit.baseArgs).toEqual([mainTip, topicTip]);
    } finally {
      await fixture.dispose();
    }
  });

  it('plans every mutable endpoint pair and marks equal mutable pairs empty', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('a.txt', 'base\n');
      await fixture.commitAll('base');
      await fixture.write('a.txt', 'worktree change\n');
      const runner = new GitProcessRunner('git');
      const provider = { runner, cwd: fixture.path };

      const headOid = (await runner.run({ args: ['rev-parse', 'HEAD'], cwd: fixture.path, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 4096 })).stdoutText().trim();

      const commitToWorktree = await planComparison(provider, endpoint('commit', headOid), endpoint('workingTree', 'Working Tree'), 'direct', 1);
      expect(commitToWorktree.baseArgs).toEqual([headOid]);
      expect(commitToWorktree.empty).toBe(false);

      const worktreeToCommit = await planComparison(provider, endpoint('workingTree', 'Working Tree'), endpoint('commit', headOid), 'direct', 1);
      expect(worktreeToCommit.baseArgs).toEqual(['--reverse', headOid]);

      const commitToIndex = await planComparison(provider, endpoint('commit', headOid), endpoint('index', 'Index'), 'direct', 1);
      expect(commitToIndex.baseArgs).toEqual(['--cached', headOid]);

      const indexToWorktree = await planComparison(provider, endpoint('index', 'Index'), endpoint('workingTree', 'Working Tree'), 'direct', 1);
      expect(indexToWorktree.baseArgs).toEqual([]);

      const worktreeToIndex = await planComparison(provider, endpoint('workingTree', 'Working Tree'), endpoint('index', 'Index'), 'direct', 1);
      expect(worktreeToIndex.baseArgs).toEqual(['--reverse']);

      const sameMutable = await planComparison(provider, endpoint('workingTree', 'Working Tree'), endpoint('workingTree', 'Working Tree'), 'direct', 1);
      expect(sameMutable.empty).toBe(true);
      const sameIndex = await planComparison(provider, endpoint('index', 'Index'), endpoint('index', 'Index'), 'direct', 1);
      expect(sameIndex.empty).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('reads file lists and patches across swapped endpoints and whitespace modes', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('a.txt', 'one\ntwo\n');
      await fixture.write('renamed-old.txt', 'stable content\n');
      const base = await fixture.commitAll('base');
      await fixture.write('a.txt', 'one\ntwo\nthree\n');
      await fixture.commitAll('changes');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['mv', 'renamed-old.txt', 'renamed-new.txt'], { cwd: fixture.path });
      await execFileAsync('git', ['commit', '--no-gpg-sign', '-am', 'rename'], { cwd: fixture.path });

      const runner = new GitProcessRunner('git');
      const provider = { runner, cwd: fixture.path };
      const headOid = (await runner.run({ args: ['rev-parse', 'HEAD'], cwd: fixture.path, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 4096 })).stdoutText().trim();

      const plan = await planComparison(provider, endpoint('commit', base), endpoint('commit', headOid), 'direct', 1);
      const files = await readComparisonFileList(provider, plan, { renameDetection: true, maxFileBytes: 1024 * 1024 });
      const byPath = new Map(files.map((file) => [String(file.path), file] as const));
      expect(byPath.get('a.txt')).toMatchObject({ status: 'M', additions: 1, deletions: 0, binary: false });
      expect(byPath.get('renamed-new.txt')).toMatchObject({ status: 'R', originalPath: 'renamed-old.txt' });

      const hunks = await readFilePatch(provider, plan, 'a.txt', 'none', 1024 * 1024);
      expect(hunks).toHaveLength(1);
      expect(hunks[0]?.lines.filter((line) => line.kind === 'addition')).toEqual([
        { kind: 'addition', text: 'three', newLine: 3 },
      ]);

      const emptyPlan = await planComparison(provider, endpoint('commit', base), endpoint('commit', base), 'direct', 1);
      expect(emptyPlan.empty).toBe(true);
      expect(await readComparisonFileList(provider, emptyPlan, { renameDetection: true, maxFileBytes: 1024 * 1024 })).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
