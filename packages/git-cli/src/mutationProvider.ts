import type { GitProcessRunner } from './process.js';
import type { GitFailureClass, MutationGitProvider, QueryGitProvider } from './ports.js';

const failurePatterns: readonly { readonly pattern: RegExp; readonly failureClass: GitFailureClass }[] = [
  { pattern: /Authentication failed|could not read Username|terminal prompts disabled|credential/i, failureClass: 'authCancelled' },
  { pattern: /Could not resolve host|Connection (?:reset|refused|timed out)|network unreachable|Failed to connect/i, failureClass: 'offline' },
];

/**
 * Adapts the bounded process runner to the guarded provider ports used by all
 * Phase 2 mutation implementations. `mutate` classifies transport-style
 * failures structurally instead of guessing from localized stderr.
 */
export function createCliMutationProvider(runner: GitProcessRunner, cwd: string): MutationGitProvider {
  const base: QueryGitProvider = {
    cwd,
    query: (args, stdin, signal) => runner.run({
      args,
      cwd,
      kind: 'query',
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    }),
  };
  return {
    ...base,
    mutate: async (args, stdin, profile) => {
      const result = await runner.run({
        args,
        cwd,
        kind: 'mutation',
        ...(stdin === undefined ? {} : { stdin }),
        ...(profile === undefined ? {} : { profile }),
        maxStdoutBytes: 16 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      });
      const stderr = result.stderrText();
      const failureClass = failurePatterns.find((entry) => entry.pattern.test(stderr))?.failureClass;
      const killed = result.exitCode === 130 || result.exitCode === 143;
      return { ...result, outcome: killed ? 'unknown' : 'known', ...(failureClass ? { failureClass } : {}) };
    },
    resolve: async (ref) => {
      const result = await runner.run({ args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
      if (result.exitCode !== 0) throw new Error(`unresolvable ref: ${ref}`);
      return result.stdoutText().trim();
    },
  };
}
