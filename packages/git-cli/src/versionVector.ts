import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { FileVersion, PausedOperationKind, VersionVector } from '@git-workbench/domain';

import type { GitProcessRunner } from './process.js';

export interface CaptureOptions {
  readonly generation: number;
  readonly commonGeneration: number;
  /** Refs the plan reads or writes; read individually so deletions are visible. */
  readonly refs?: readonly string[];
  /** Repo-relative paths the plan touches. */
  readonly paths?: readonly string[];
}

const pausedHeadFiles: readonly { readonly file: string; readonly kind: PausedOperationKind }[] = [
  { file: 'MERGE_HEAD', kind: 'merge' },
  { file: 'REBASE_HEAD', kind: 'rebase' },
  { file: 'CHERRY_PICK_HEAD', kind: 'cherryPick' },
  { file: 'REVERT_HEAD', kind: 'revert' },
];

async function readGitPath(runner: GitProcessRunner, cwd: string, name: string): Promise<string> {
  const result = await runner.run({ args: ['rev-parse', '--git-path', name], cwd, kind: 'query', maxStdoutBytes: 1024, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(`cannot locate ${name}`);
  const path = result.stdoutText().trim();
  return isAbsolute(path) ? path : join(cwd, path);
}

/**
 * Samples the repository facts a plan depends on: HEAD identity, a full
 * content hash of the raw index bytes, the active sequencer state, the exact
 * OIDs of the plan's refs and the content hashes of its paths.
 */
export async function captureVersionVector(runner: GitProcessRunner, cwd: string, options: CaptureOptions): Promise<VersionVector> {
  const headNameResult = await runner.run({ args: ['symbolic-ref', '-q', '--short', 'HEAD'], cwd, kind: 'query', maxStdoutBytes: 1024, maxStderrBytes: 64 * 1024 });
  const headName = headNameResult.exitCode === 0 ? headNameResult.stdoutText().trim() : undefined;
  const headOidResult = await runner.run({ args: ['rev-parse', '--verify', '--end-of-options', 'HEAD'], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
  const headOid = headOidResult.exitCode === 0 ? headOidResult.stdoutText().trim() : undefined;

  const indexBytes = await readFile(await readGitPath(runner, cwd, 'index')).catch(() => Buffer.alloc(0));
  const indexStats = await stat(await readGitPath(runner, cwd, 'index')).catch(() => undefined);

  let pausedOperation: PausedOperationKind = 'none';
  for (const candidate of pausedHeadFiles) {
    const probe = await runner.run({ args: ['rev-parse', '--verify', '-q', '--end-of-options', candidate.file], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
    if (probe.exitCode === 0) {
      pausedOperation = candidate.kind;
      break;
    }
  }

  const refs: { readonly ref: string; readonly oid?: string }[] = [];
  for (const ref of options.refs ?? []) {
    const result = await runner.run({ args: ['rev-parse', '--verify', '--end-of-options', ref], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
    refs.push(result.exitCode === 0 ? { ref, oid: result.stdoutText().trim() } : { ref });
  }

  const files: FileVersion[] = [];
  for (const path of options.paths ?? []) {
    const absolute = isAbsolute(path) ? path : join(cwd, path);
    const bytes = await readFile(absolute).catch(() => undefined);
    const stats = bytes === undefined ? undefined : await stat(absolute).catch(() => undefined);
    files.push({
      path,
      hash: createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex'),
      mode: stats ? String(stats.mode & 0o7777) : '0000',
      exists: bytes !== undefined,
    });
  }

  const fingerprint = createHash('sha256');
  fingerprint.update(`${headOid ?? ''}\0${headName ?? ''}\0`);
  fingerprint.update(indexBytes);
  fingerprint.update(indexStats ? String(indexStats.size) : 'absent');

  return {
    generation: options.generation,
    commonGeneration: options.commonGeneration,
    ...(headOid ? { headOid } : {}),
    ...(headName ? { headName } : {}),
    indexFingerprint: fingerprint.digest('hex'),
    pausedOperation,
    refs,
    files,
  };
}
