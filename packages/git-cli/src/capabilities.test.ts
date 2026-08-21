import { describe, expect, it } from 'vitest';
import type { GitRunRequest, GitRunResult } from './process.js';
import { decideRepositoryMode, probeGit, type GitProbeRunner } from './capabilities.js';

function result(stdout: string, exitCode = 0): GitRunResult {
  const bytes = Buffer.from(stdout);
  return {
    exitCode,
    stdout: bytes,
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutText: () => stdout,
    stderrText: () => '',
  };
}

function runnerFor(responses: ReadonlyMap<string, GitRunResult | Error>): GitProbeRunner & { readonly calls: GitRunRequest[] } {
  const calls: GitRunRequest[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      const response = responses.get(request.args.join('\0')) ?? result('', 1);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

const completeCapabilities = {
  supportedBaseline: true,
  porcelainV2: true,
  nulPaths: true,
  updateRefTransaction: true,
  explicitForceLease: true,
  noLazyFetch: false,
} as const;

describe('decideRepositoryMode', () => {
  it('requires all write capabilities but not no-lazy-fetch', () => {
    expect(decideRepositoryMode(completeCapabilities)).toBe('readWrite');
    for (const missing of ['supportedBaseline', 'porcelainV2', 'nulPaths', 'updateRefTransaction', 'explicitForceLease'] as const) {
      expect(decideRepositoryMode({ ...completeCapabilities, [missing]: false })).toBe('compatibilityReadOnly');
    }
  });
});

describe('probeGit', () => {
  it('probes every write prerequisite in a trusted workspace', async () => {
    const runner = runnerFor(new Map([
      ['--version', result('git version 2.35.3 (Apple Git-137)\n')],
      ['rev-parse\0--show-object-format', result('sha256\n')],
      ['--no-lazy-fetch\0--version', result('git version 2.35.3\n')],
      ['-c\0core.fsmonitor=false\0status\0--porcelain=v2\0-z\0--branch\0--untracked-files=no', result('')],
      ['update-ref\0--stdin', result('')],
    ]));

    const capabilities = await probeGit(runner, '/repo', { trusted: true });

    expect(capabilities).toEqual({
      version: '2.35.3 (Apple Git-137)',
      objectFormat: 'sha256',
      porcelainV2: true,
      nulPaths: true,
      updateRefTransaction: true,
      explicitForceLease: true,
      noLazyFetch: true,
      supportedBaseline: true,
    });
    expect(runner.calls.map((call) => call.kind)).toEqual(['query', 'query', 'query', 'query', 'query']);
    expect(runner.calls[4]).toMatchObject({ args: ['update-ref', '--stdin'], stdin: Buffer.from('start\nabort\n') });
  });

  it('treats the baseline boundary and supported Git suffixes correctly', async () => {
    for (const [stdout, supportedBaseline] of [
      ['git version 2.35.3.windows.1\n', true],
      ['git version 2.35.2\n', false],
      ['Git version unknown\n', false],
    ] as const) {
      const runner = runnerFor(new Map([
        ['--version', result(stdout)],
        ['rev-parse\0--show-object-format', result('sha1\n')],
        ['--no-lazy-fetch\0--version', result('git version 2.35.3\n')],
      ]));

      expect((await probeGit(runner, '/repo', { trusted: false })).supportedBaseline).toBe(supportedBaseline);
    }
  });

  it('does not probe status or update-ref in an untrusted workspace', async () => {
    const runner = runnerFor(new Map([
      ['--version', result('git version 2.46.0\n')],
      ['rev-parse\0--show-object-format', result('sha1\n')],
      ['--no-lazy-fetch\0--version', result('', 1)],
    ]));

    const capabilities = await probeGit(runner, '/repo', { trusted: false });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['rev-parse', '--show-object-format'],
      ['--no-lazy-fetch', '--version'],
    ]);
    expect(capabilities).toMatchObject({ porcelainV2: false, nulPaths: false, updateRefTransaction: false, noLazyFetch: false });
    expect(decideRepositoryMode(capabilities)).toBe('compatibilityReadOnly');
  });

  it('defaults unknown object formats to sha1 and degrades when a trusted probe fails', async () => {
    const runner = runnerFor(new Map([
      ['--version', result('git version 2.46.0\n')],
      ['rev-parse\0--show-object-format', result('sha512\n')],
      ['--no-lazy-fetch\0--version', result('git version 2.46.0\n')],
      ['-c\0core.fsmonitor=false\0status\0--porcelain=v2\0-z\0--branch\0--untracked-files=no', result('', 1)],
      ['update-ref\0--stdin', result('')],
    ]));

    const capabilities = await probeGit(runner, '/repo', { trusted: true });

    expect(capabilities.objectFormat).toBe('sha1');
    expect(decideRepositoryMode(capabilities)).toBe('compatibilityReadOnly');
  });

  it.each([
    ['version', '--version', { supportedBaseline: false }, 'compatibilityReadOnly'],
    ['object format', 'rev-parse\0--show-object-format', { objectFormat: 'sha1', supportedBaseline: true }, 'readWrite'],
    ['no-lazy-fetch', '--no-lazy-fetch\0--version', { noLazyFetch: false }, 'readWrite'],
  ] as const)('uses the controlled fallback when the %s probe rejects', async (_name, failingCommand, expected, mode) => {
    const responses = new Map<string, GitRunResult | Error>([
      ['--version', result('git version 2.46.0\n')],
      ['rev-parse\0--show-object-format', result('sha256\n')],
      ['--no-lazy-fetch\0--version', result('git version 2.46.0\n')],
      ['-c\0core.fsmonitor=false\0status\0--porcelain=v2\0-z\0--branch\0--untracked-files=no', result('')],
      ['update-ref\0--stdin', result('')],
    ]);
    responses.set(failingCommand, new Error('TOO_LARGE'));

    const capabilities = await probeGit(runnerFor(responses), '/repo', { trusted: true });

    expect(capabilities).toMatchObject(expected);
    expect(decideRepositoryMode(capabilities)).toBe(mode);
  });

  it.each([
    ['status', '-c\0core.fsmonitor=false\0status\0--porcelain=v2\0-z\0--branch\0--untracked-files=no', 'porcelainV2'],
    ['update-ref', 'update-ref\0--stdin', 'updateRefTransaction'],
  ] as const)('fails closed when the trusted %s probe rejects', async (_name, failingCommand, missingCapability) => {
    const tooLarge = new Error('TOO_LARGE');
    const responses = runnerFor(new Map<string, GitRunResult | Error>([
      ['--version', result('git version 2.46.0\n')],
      ['rev-parse\0--show-object-format', result('sha1\n')],
      ['--no-lazy-fetch\0--version', result('git version 2.46.0\n')],
      ['-c\0core.fsmonitor=false\0status\0--porcelain=v2\0-z\0--branch\0--untracked-files=no', result('')],
      ['update-ref\0--stdin', result('')],
      [failingCommand, tooLarge],
    ]));

    const capabilities = await probeGit(responses, '/repo', { trusted: true });

    expect(capabilities[missingCapability]).toBe(false);
    expect(decideRepositoryMode(capabilities)).toBe('compatibilityReadOnly');
  });
});
