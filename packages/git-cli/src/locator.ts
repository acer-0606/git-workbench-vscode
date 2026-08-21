import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  asCommonRepositoryId,
  asRepositoryId,
  type RepositoryDescriptor,
} from '@git-workbench/domain';

import { decideRepositoryMode, probeGit, type GitProbeRunner } from './capabilities.js';
import type { GitRunRequest, GitRunResult } from './process.js';

/** The small runner surface needed for safe repository location. */
export interface RepositoryLocatorRunner extends GitProbeRunner {
  run(request: GitRunRequest): Promise<GitRunResult>;
}

export interface LocateRepositoryOptions {
  /** Untrusted workspaces must not issue stateful capability probes. */
  readonly trusted: boolean;
  readonly signal?: AbortSignal;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function withSignal(request: GitRunRequest, signal: AbortSignal | undefined): GitRunRequest {
  return signal === undefined ? request : { ...request, signal };
}

function strictLines(stdout: Uint8Array): readonly [string, string] | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch {
    return undefined;
  }
  // Git emits exactly one complete line per requested rev-parse switch. Git
  // for Windows can use CRLF, but mixed or unterminated separators are invalid.
  const separator = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(separator);
  if (lines.length !== 3 || lines[2] !== '' || lines[0] === '' || lines[1] === ''
    || lines[0]!.includes('\r') || lines[1]!.includes('\r')) return undefined;
  return [lines[0]!, lines[1]!];
}

/**
 * Locates a worktree using only Git's path-aware query.  All expected failures
 * are deliberately represented as `undefined`, so callers never surface Git
 * stderr or local paths as an error message.
 */
export async function locateRepository(
  runner: RepositoryLocatorRunner,
  cwd: string,
  options: LocateRepositoryOptions,
): Promise<RepositoryDescriptor | undefined> {
  try {
    if (options.signal?.aborted) return undefined;
    const result = await runner.run(withSignal({
      args: ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      cwd,
      kind: 'query',
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 4 * 1024,
    }, options.signal));
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) return undefined;
    const lines = strictLines(result.stdout);
    if (lines === undefined || !isAbsolute(lines[0]) || !isAbsolute(lines[1])) return undefined;

    const [worktree, commonDir] = await Promise.all([realpath(lines[0]), realpath(lines[1])]);
    const capabilities = await probeGit(runner, worktree, {
      trusted: options.trusted,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted) return undefined;
    return {
      id: asRepositoryId(sha256(`${commonDir}\0${worktree}`)),
      commonRepositoryId: asCommonRepositoryId(sha256(commonDir)),
      worktreeUri: pathToFileURL(worktree).href,
      commonDirUri: pathToFileURL(commonDir).href,
      mode: decideRepositoryMode(capabilities),
      objectFormat: capabilities.objectFormat,
    };
  } catch {
    return undefined;
  }
}
