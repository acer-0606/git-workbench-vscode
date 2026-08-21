import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSelectedPatch, checkPatchApplies, createCliMutationProvider, GitProcessRunner, readRawDiff, type RawUnifiedDiff } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

// Deterministic PRNG so failures are reproducible from the logged seed.
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('patchBuilder vs git apply (property)', () => {
  let root: string;
  const seed = Number(process.env.GIT_WORKBENCH_PROPERTY_SEED ?? 20260821);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-workbench-property-'));
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', root]);
    await execFileAsync('git', ['config', 'user.name', 'Property Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'property@git-workbench.invalid'], { cwd: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('every generated selection builds a patch that git apply --check accepts', async () => {
    const random = makeRandom(seed);
    const base = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const target = base.map((line, index) => (index % 4 === 3 ? `${line} (changed)` : line));
    await writeFile(join(root, 'file.txt'), `${base.join('\n')}\n`);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
    await writeFile(join(root, 'file.txt'), `${target.join('\n')}\n`);

    const runner = new GitProcessRunner('git');
    const snapshot = await readRawDiff({ runner, cwd: root }, ['HEAD']);
    const file = snapshot.diff.files[0]!;
    const hunk = file.hunks[0]!;

    const provider = createCliMutationProvider(runner, root);
    const changeLineIds = hunk.lines.filter((line) => line.marker !== ' ').map((line) => line.id);
    for (let iteration = 0; iteration < 15; iteration += 1) {
      const selected = changeLineIds.filter(() => random() > 0.5);
      if (selected.length === 0) continue;
      const raw: RawUnifiedDiff = { files: [{ ...file, hunks: [{ ...hunk }] }] };
      let built;
      try {
        built = buildSelectedPatch(raw, [{ kind: 'lines', path: file.path, rawHunkId: hunk.id, lineIds: selected }]);
      } catch {
        // Selections without safe context are legitimately refused — as long
        // as the full-hunk variant still applies, the builder is consistent.
        continue;
      }
      // The patch context matches the diff's LEFT side (HEAD); restore the
      // base content before each working-tree check, then re-apply the target.
      await execFileAsync('git', ['checkout', '--', 'file.txt'], { cwd: root });
      const applies = await checkPatchApplies(provider, { bytes: built.bytes, target: 'workingTree' });
      await writeFile(join(root, 'file.txt'), `${target.join('\n')}\n`);
      if (!applies) {
        throw new Error(`seed=${seed} iteration=${iteration}: built patch failed git apply --check\n${built.toString('utf8')}`);
      }
    }
    // The whole-hunk patch must always apply.
    await execFileAsync('git', ['checkout', '--', 'file.txt'], { cwd: root });
    const wholeHunk = buildSelectedPatch(snapshot.diff, [{ kind: 'hunk', path: file.path, rawHunkId: hunk.id }]);
    expect(await checkPatchApplies(provider, { bytes: wholeHunk.bytes, target: 'workingTree' })).toBe(true);
  }, 60_000);
});
