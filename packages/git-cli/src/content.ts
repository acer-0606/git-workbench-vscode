import { GitWorkbenchError } from '@git-workbench/domain';

import type { GitProcessRunner } from './process.js';

const tooLarge = (what: string): GitWorkbenchError =>
  new GitWorkbenchError({ code: 'TOO_LARGE', message: `${what} exceeds the configured byte budget`, repositoryChanged: false, retry: 'refresh' });

/**
 * Reads the blob content of one object. Reads are bounded and never trimmed
 * silently: an object above the budget fails with TOO_LARGE.
 */
export async function readObjectContent(runner: GitProcessRunner, cwd: string, oid: string, maxBytes: number): Promise<Uint8Array> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'invalid object id', repositoryChanged: false, retry: 'none' });
  const result = await runner.run({ args: ['cat-file', 'blob', oid], cwd, kind: 'query', maxStdoutBytes: maxBytes, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new GitWorkbenchError({ code: 'MISSING_LOCAL_OBJECT', message: `object ${oid} is not available locally`, repositoryChanged: false, retry: 'refresh' });
  if (result.stdoutTruncated) throw tooLarge(`object ${oid}`);
  return result.stdout;
}

/**
 * Reads the staged (index) content of one repo-relative path.
 */
export async function readIndexContent(runner: GitProcessRunner, cwd: string, path: string, maxBytes: number): Promise<Uint8Array> {
  const result = await runner.run({ args: ['--literal-pathspecs', 'show', `:${path}`], cwd, kind: 'query', maxStdoutBytes: maxBytes, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new GitWorkbenchError({ code: 'MISSING_LOCAL_OBJECT', message: `index content for ${path} is unavailable`, repositoryChanged: false, retry: 'none' });
  if (result.stdoutTruncated) throw tooLarge(`index content for ${path}`);
  return result.stdout;
}
