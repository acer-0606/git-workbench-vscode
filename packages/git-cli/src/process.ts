import { spawn } from 'node:child_process';
import { GitWorkbenchError } from '@git-workbench/domain';

export type MutationProfile = 'default' | 'userInitiatedNetwork' | 'materializeMissingObjects';

export interface GitControlledEnvironment {
  readonly GIT_CONFIG_NOSYSTEM?: '0' | '1';
  readonly GIT_CONFIG_GLOBAL?: string;
  readonly GIT_TERMINAL_PROMPT?: '0' | '1';
  readonly GIT_NO_LAZY_FETCH?: '0' | '1';
  readonly GIT_ASKPASS?: string;
  readonly GIT_SSH?: string;
  readonly GCM_INTERACTIVE?: 'Never';
  readonly SSH_ASKPASS?: string;
  readonly SSH_ASKPASS_REQUIRE?: 'force' | 'prefer' | 'never';
  readonly GIT_SEQUENCE_EDITOR?: string;
  readonly GIT_EDITOR?: string;
  readonly GIT_WORKBENCH_OPERATION_FILE?: string;
  readonly GIT_WORKBENCH_OPERATION_TOKEN?: string;
}

export interface GitStdoutSink {
  push(chunk: Uint8Array): void;
  finish(): void;
}

export interface GitRunRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly kind: 'query' | 'mutation';
  readonly profile?: MutationProfile;
  readonly stdin?: Uint8Array;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly stdoutSink?: GitStdoutSink;
  readonly env?: Readonly<GitControlledEnvironment>;
  readonly signal?: AbortSignal;
}

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  stdoutText(): string;
  stderrText(): string;
}

const inheritedEnvironmentKeys = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP', 'APPDATA',
  'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'GPG_TTY', 'DISPLAY',
  'WAYLAND_DISPLAY', 'LANG', 'LC_ALL',
] as const;

const controlledEnvironmentKeys = [
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
  'GIT_NO_LAZY_FETCH', 'GIT_ASKPASS', 'GIT_SSH', 'GCM_INTERACTIVE', 'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE', 'GIT_SEQUENCE_EDITOR', 'GIT_EDITOR',
  'GIT_WORKBENCH_OPERATION_FILE', 'GIT_WORKBENCH_OPERATION_TOKEN',
] as const satisfies readonly (keyof GitControlledEnvironment)[];

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function controlledEnvironment(environment: Readonly<GitControlledEnvironment> | undefined): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (environment === undefined) return result;
  for (const key of controlledEnvironmentKeys) {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, size: number, limit: number): { readonly size: number; readonly truncated: boolean } {
  const remaining = Math.max(0, limit - size);
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return { size: size + Math.min(remaining, chunk.byteLength), truncated: chunk.byteLength > remaining };
}

function validateLimit(limit: number, name: string): void {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

function assertNoPagination(args: readonly string[]): void {
  if (args.some((arg) => arg === '-p' || arg === '--paginate' || arg.startsWith('-p=') || arg.startsWith('--paginate='))) {
    throw new TypeError('Pagination is not allowed');
  }
}

function cancelledError(): GitWorkbenchError {
  return new GitWorkbenchError({ code: 'CANCELLED', message: 'Git 查询已取消', repositoryChanged: false, retry: 'none' });
}

function tooLargeError(): GitWorkbenchError {
  return new GitWorkbenchError({ code: 'TOO_LARGE', message: 'Git 输出超过安全上限', repositoryChanged: false, retry: 'none' });
}

export class GitProcessRunner {
  constructor(private readonly executable: string) {}

  run(request: GitRunRequest): Promise<GitRunResult> {
    validateLimit(request.maxStdoutBytes, 'maxStdoutBytes');
    validateLimit(request.maxStderrBytes, 'maxStderrBytes');
    assertNoPagination(request.args);
    if (request.kind === 'mutation' && request.stdoutSink !== undefined) {
      return Promise.reject(new TypeError('stdoutSink is query-only'));
    }
    if (request.kind === 'query' && request.signal?.aborted) return Promise.reject(cancelledError());

    const permitsNetwork = request.kind === 'mutation'
      && (request.profile === 'userInitiatedNetwork' || request.profile === 'materializeMissingObjects');
    const environment: NodeJS.ProcessEnv = {
      ...inheritedEnvironment(),
      ...controlledEnvironment(request.env),
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: request.kind === 'query' ? '0' : '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '',
    };
    if (permitsNetwork) {
      delete environment.GIT_NO_LAZY_FETCH;
      delete environment.GIT_ALLOW_PROTOCOL;
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--no-pager', ...request.args], {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        env: environment,
        stdio: 'pipe',
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;

      const cleanup = (): void => request.signal?.removeEventListener('abort', onAbort);
      const rejectOnce = (error: unknown, terminateQuery: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminateQuery && request.kind === 'query') child.kill();
        reject(error);
      };
      const onAbort = (): void => {
        if (request.kind === 'query') rejectOnce(cancelledError(), true);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        const remaining = Math.max(0, request.maxStdoutBytes - stdoutSize);
        const accepted = chunk.subarray(0, remaining);
        if (request.stdoutSink !== undefined) {
          try {
            if (accepted.byteLength > 0) request.stdoutSink.push(accepted);
          } catch (error) {
            rejectOnce(error, true);
            return;
          }
          stdoutSize += accepted.byteLength;
          stdoutTruncated ||= chunk.byteLength > remaining;
        } else {
          const appended = appendBounded(stdout, chunk, stdoutSize, request.maxStdoutBytes);
          stdoutSize = appended.size;
          stdoutTruncated ||= appended.truncated;
        }
        if (stdoutTruncated && request.kind === 'query') rejectOnce(tooLargeError(), true);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        const appended = appendBounded(stderr, chunk, stderrSize, request.maxStderrBytes);
        stderrSize = appended.size;
        stderrTruncated ||= appended.truncated;
        if (stderrTruncated && request.kind === 'query') rejectOnce(tooLargeError(), true);
      });
      child.on('error', (error) => rejectOnce(error, false));
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') rejectOnce(error, request.kind === 'query');
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        try {
          request.stdoutSink?.finish();
        } catch (error) {
          rejectOnce(error, true);
          return;
        }
        settled = true;
        cleanup();
        const capturedStdout = Buffer.concat(stdout);
        const capturedStderr = Buffer.concat(stderr);
        resolve({
          exitCode: exitCode ?? -1,
          stdout: capturedStdout,
          stderr: capturedStderr,
          stdoutTruncated,
          stderrTruncated,
          stdoutText: () => capturedStdout.toString('utf8'),
          stderrText: () => capturedStderr.toString('utf8'),
        });
      });

      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.kind === 'query' && request.signal?.aborted) {
        onAbort();
        return;
      }
      if (request.stdin === undefined) child.stdin.end();
      else child.stdin.end(request.stdin);
    });
  }
}
