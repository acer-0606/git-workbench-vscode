import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '@git-workbench/testkit';
import { GitProcessRunner, createCliMutationProvider, readConflicts, reconstructPausedOperation, sequencer, specialResolution, stageResolvedText } from '@git-workbench/git-cli';

const execFileAsync = promisify(execFile);

describe('text conflict resolution with frozen bytes', () => {
  let fixture: RepositoryFixture;
  let provider: ReturnType<typeof createCliMutationProvider>;
  let runner: GitProcessRunner;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    runner = new GitProcessRunner('git');
    provider = createCliMutationProvider(runner, fixture.path);
    await fixture.write('shared.txt', 'base\n');
    await fixture.commitAll('base');
    await execFileAsync('git', ['switch', '-c', 'topic'], { cwd: fixture.path });
    await fixture.write('shared.txt', 'topic\n');
    await fixture.commitAll('topic change');
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('shared.txt', 'main\n');
    await fixture.commitAll('main change');
    await provider.mutate(['merge', '--no-edit', 'topic']).catch(() => undefined);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('stages exactly the frozen bytes and clears all conflict stages', async () => {
    const conflicts = await readConflicts(runner, fixture.path);
    expect(conflicts[0]).toMatchObject({ path: 'shared.txt', kind: 'text' });

    // The user's confirmed content (frozen at click time, before any race).
    const frozen = Buffer.from('resolved by user\n', 'utf8');
    const stagedOid = await stageResolvedText(provider, { path: 'shared.txt', frozenBytes: frozen, mode: '100644' });

    const after = await readConflicts(runner, fixture.path);
    expect(after).toEqual([]);
    const stage0 = await execFileAsync('git', ['ls-files', '-s', '--', 'shared.txt'], { cwd: fixture.path });
    expect(stage0.stdout.trim()).toContain(stagedOid);
    // The working tree keeps whatever is on disk; only confirmed bytes staged.
    await writeFile(`${fixture.path}/shared.txt`, 'resolved by user\n');
    expect(await readFile(`${fixture.path}/shared.txt`, 'utf8')).toBe('resolved by user\n');
  });

  it('continues the merge after resolution and ends the paused state', async () => {
    await sequencer.run(provider, 'merge', 'continue');
    expect(await reconstructPausedOperation(runner, fixture.path)).toBeUndefined();
    const subject = (await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: fixture.path })).stdout;
    expect(subject).toContain("Merge branch 'topic'");
  });
});

describe('special conflict resolutions', () => {
  let fixture: RepositoryFixture;
  let provider: ReturnType<typeof createCliMutationProvider>;
  let runner: GitProcessRunner;

  beforeAll(async () => {
    fixture = await createRepositoryFixture();
    runner = new GitProcessRunner('git');
    provider = createCliMutationProvider(runner, fixture.path);
    await fixture.write('base.txt', 'base\n');
    await fixture.commitAll('base');
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('resolves a delete/modify conflict by keeping the modified side', async () => {
    await execFileAsync('git', ['switch', '-c', 'delete-side'], { cwd: fixture.path });
    await execFileAsync('git', ['rm', '-q', 'base.txt'], { cwd: fixture.path });
    await fixture.commitAll('delete base');
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('base.txt', 'modified\n');
    await fixture.commitAll('modify base');
    await provider.mutate(['merge', '--no-edit', 'delete-side']).catch(() => undefined);

    const conflicts = await readConflicts(runner, fixture.path);
    expect(conflicts[0]?.kind).toBe('deleteModify');
    await specialResolution.resolveDeleteModify(provider, { path: 'base.txt', keep: 'ours' });
    expect(await readConflicts(runner, fixture.path)).toEqual([]);
    const stage0 = await execFileAsync('git', ['ls-files', '-s', '--', 'base.txt'], { cwd: fixture.path });
    expect(stage0.stdout.trim()).toMatch(/^100644 [0-9a-f]{40} 0/);
    await sequencer.run(provider, 'merge', 'continue');
  });

  it('resolves a delete/modify conflict by confirming the deletion', async () => {
    await execFileAsync('git', ['switch', '-c', 'del2'], { cwd: fixture.path });
    await execFileAsync('git', ['rm', '-q', 'base.txt'], { cwd: fixture.path });
    await fixture.commitAll('delete again');
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('base.txt', 'modified again\n');
    await fixture.commitAll('modify again');
    await provider.mutate(['merge', '--no-edit', 'del2']).catch(() => undefined);

    await specialResolution.resolveDeleteModify(provider, { path: 'base.txt', keep: 'deleted' });
    expect(await readConflicts(runner, fixture.path)).toEqual([]);
    const tracked = await execFileAsync('git', ['ls-files', '--', 'base.txt'], { cwd: fixture.path });
    expect(tracked.stdout.trim()).toBe('');
    await sequencer.run(provider, 'merge', 'continue');
  });

  it('keeps both sides of an add/add conflict at an explicit new path', async () => {
    await execFileAsync('git', ['switch', '-c', 'add-a'], { cwd: fixture.path });
    await fixture.write('new.txt', 'version a\n');
    await fixture.commitAll('add a');
    await execFileAsync('git', ['switch', 'main'], { cwd: fixture.path });
    await fixture.write('new.txt', 'version b\n');
    await fixture.commitAll('add b');
    await provider.mutate(['merge', '--no-edit', 'add-a']).catch(() => undefined);

    await specialResolution.keepBothBinary(provider, { path: 'new.txt', newPath: 'new.theirs.txt' });
    const conflicts = await readConflicts(runner, fixture.path);
    expect(conflicts).toEqual([]);
    const both = await execFileAsync('git', ['ls-files', '-s', '--', 'new.txt', 'new.theirs.txt'], { cwd: fixture.path });
    expect(both.stdout.trim().split('\n')).toHaveLength(2);
    await sequencer.run(provider, 'merge', 'continue');
  });

  it('rejects keep-both when the explicit new path is already tracked', async () => {
    await expect(specialResolution.keepBothBinary(provider, { path: 'new.txt', newPath: 'base.txt' })).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });
});
