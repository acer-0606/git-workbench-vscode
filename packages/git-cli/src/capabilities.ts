import type { RepositoryMode } from '@git-workbench/domain';
import type { GitRunRequest, GitRunResult } from './process.js';

export interface GitCapabilities {
  readonly version: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly porcelainV2: boolean;
  readonly nulPaths: boolean;
  readonly updateRefTransaction: boolean;
  readonly explicitForceLease: boolean;
  readonly noLazyFetch: boolean;
  readonly supportedBaseline: boolean;
}

export interface GitProbeRunner {
  run(request: GitRunRequest): Promise<GitRunResult>;
}

function withSignal(request: GitRunRequest, signal: AbortSignal | undefined): GitRunRequest {
  return signal === undefined ? request : { ...request, signal };
}

export function decideRepositoryMode(capabilities: Omit<GitCapabilities, 'version' | 'objectFormat'>): RepositoryMode {
  return capabilities.supportedBaseline
    && capabilities.porcelainV2
    && capabilities.nulPaths
    && capabilities.updateRefTransaction
    && capabilities.explicitForceLease
    ? 'readWrite'
    : 'compatibilityReadOnly';
}

function isSupportedBaseline(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 2 || (major === 2 && (minor > 35 || (minor === 35 && patch >= 3)));
}

async function runProbe(runner: GitProbeRunner, request: GitRunRequest): Promise<GitRunResult | undefined> {
  if (request.signal?.aborted) return undefined;
  try {
    return await runner.run(request);
  } catch {
    // A probe error must not block repository discovery or enable a fallback command.
    return undefined;
  }
}

export async function probeGit(
  runner: GitProbeRunner,
  cwd: string,
  options: { readonly trusted: boolean; readonly signal?: AbortSignal },
): Promise<GitCapabilities> {
  const versionResult = await runProbe(runner, withSignal({
    args: ['--version'], cwd, kind: 'query', maxStdoutBytes: 4096, maxStderrBytes: 4096,
  }, options.signal));
  const objectFormatResult = await runProbe(runner, withSignal({
    args: ['rev-parse', '--show-object-format'], cwd, kind: 'query', maxStdoutBytes: 128, maxStderrBytes: 4096,
  }, options.signal));
  const noLazyFetchResult = await runProbe(runner, withSignal({
    args: ['--no-lazy-fetch', '--version'], cwd, kind: 'query', maxStdoutBytes: 4096, maxStderrBytes: 4096,
  }, options.signal));
  const statusResult = options.trusted
    ? await runProbe(runner, withSignal({
      args: ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no'],
      cwd,
      kind: 'query',
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 4096,
    }, options.signal))
    : undefined;
  const updateRefResult = options.trusted
    ? await runProbe(runner, withSignal({
      args: ['update-ref', '--stdin'],
      cwd,
      kind: 'query',
      stdin: Buffer.from('start\nabort\n'),
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
    }, options.signal))
    : undefined;

  const version = versionResult?.exitCode === 0
    ? versionResult.stdoutText().trim().replace(/^git version\s+/, '')
    : '';
  const porcelainV2 = statusResult?.exitCode === 0;
  return {
    version,
    objectFormat: objectFormatResult?.exitCode === 0 && objectFormatResult.stdoutText().trim() === 'sha256' ? 'sha256' : 'sha1',
    porcelainV2,
    nulPaths: porcelainV2,
    updateRefTransaction: updateRefResult?.exitCode === 0,
    explicitForceLease: true,
    noLazyFetch: noLazyFetchResult?.exitCode === 0,
    supportedBaseline: isSupportedBaseline(version),
  };
}
