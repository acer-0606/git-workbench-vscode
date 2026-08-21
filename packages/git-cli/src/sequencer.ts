import type { GitProcessRunner } from './process.js';

import type { ConflictEntry } from '@git-workbench/domain';
import type { PausedOperation } from '@git-workbench/domain';

const resolveSingle = (result: { exitCode: number; stdoutText(): string }): string | undefined =>
  result.exitCode === 0 ? result.stdoutText().trim() || undefined : undefined;

/**
 * Rebuilds the paused-operation state purely from Git's on-disk sequencer
 * state (HEAD files + sequencer directory), not from plugin memory, so a
 * restart or an external Git produces the same classification.
 */
export async function reconstructPausedOperation(runner: GitProcessRunner, cwd: string): Promise<PausedOperation | undefined> {
  const probe = async (name: string): Promise<string | undefined> => resolveSingle(await runner.run({ args: ['rev-parse', '--verify', '-q', '--end-of-options', name], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 4096 }));

  const rebaseMerge = await probe('REBASE_HEAD');
  const cherryPick = await probe('CHERRY_PICK_HEAD');
  const revert = await probe('REVERT_HEAD');
  const merge = await probe('MERGE_HEAD');

  const originalHead = await probe('ORIG_HEAD');

  if (rebaseMerge) return { kind: 'rebase', originalHead };
  if (cherryPick) return { kind: 'cherryPick', originalHead };
  if (revert) return { kind: 'revert', originalHead };
  if (merge) return { kind: 'merge', originalHead };
  return undefined;
}

/**
 * Reads unmerged index entries (`git ls-files --unmerged -z -s`) and
 * classifies each conflict from its stage set.
 */
export async function readConflicts(runner: GitProcessRunner, cwd: string): Promise<readonly ConflictEntry[]> {
  const { classifyConflict } = await import('@git-workbench/domain');
  const result = await runner.run({ args: ['ls-files', '--unmerged', '-z', '-s'], cwd, kind: 'query', maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(`ls-files --unmerged failed: ${result.stderrText()}`);
  const text = result.stdoutText();
  const byPath = new Map<string, { stage: 1 | 2 | 3; oid: string; mode: string }[]>();
  for (const record of text.split('\0')) {
    if (!record) continue;
    // Format: <mode> <oid> <stage>\t<path>
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/.exec(record);
    if (!match) throw new Error('invalid ls-files --unmerged record');
    const path = match[4]!;
    const entries = byPath.get(path) ?? [];
    entries.push({ stage: Number(match[3]) as 1 | 2 | 3, oid: match[2]!, mode: match[1]! });
    byPath.set(path, entries);
  }
  const conflicts: ConflictEntry[] = [];
  for (const [path, stages] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    conflicts.push(classifyConflict(stages, path));
  }
  return conflicts;
}
