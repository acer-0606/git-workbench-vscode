import { describe, expect, it, vi } from 'vitest';
import { createRepositoryFixture } from '@git-workbench/testkit';

import { locateRepository } from '@git-workbench/git-cli';
import { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';
import { createVscodeConfigSnapshot, readEffectiveSafetySettings } from '../../src/extension/vscodeConfig.js';

const vscodeState = vi.hoisted(() => {
  const commands = new Map<string, () => Promise<void>>();
  const configurationCalls: Array<{ section: string | undefined; resource: unknown }> = [];
  const state = {
    commands,
    configurationCalls,
    trustListener: undefined as (() => void) | undefined,
    workspace: {
      isTrusted: true,
      workspaceFolders: [] as Array<{ uri: { fsPath: string } }> | undefined,
      getConfiguration: (section?: string, resource?: unknown) => {
        configurationCalls.push({ section, resource });
        return {
          get: <T>(_key: string, fallback: T) => fallback,
          inspect: <T>(_key: string) => undefined as { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
        };
      },
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
      onDidGrantWorkspaceTrust: (listener: () => void) => { state.trustListener = listener; return { dispose: () => undefined }; },
    },
  };
  return state;
});

vi.mock('vscode', () => ({
  workspace: vscodeState.workspace,
  commands: { registerCommand: (id: string, callback: () => Promise<void>) => { vscodeState.commands.set(id, callback); return { dispose: () => undefined }; } },
  window: { createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }) },
}));

describe('repository locator and registry', () => {
  it('uses canonical paths and gives linked worktrees distinct IDs in one common group', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('README.md', 'fixture\n');
      await fixture.commitAll('initial');
      const linked = await fixture.addWorktree('linked');
      const main = await locateRepository(fixture.runner, fixture.path, { trusted: false });
      const worktree = await locateRepository(fixture.runner, linked, { trusted: false });

      expect(main).toBeDefined();
      expect(worktree).toBeDefined();
      expect(main!.id).not.toBe(worktree!.id);
      expect(main!.commonRepositoryId).toBe(worktree!.commonRepositoryId);
      expect(main!.worktreeUri).toMatch(/^file:/);
      expect(main!.commonDirUri).toMatch(/^file:/);

      const registry = new RepositoryRegistry();
      registry.replace([worktree!, main!]);
      expect(registry.list().map((repository) => repository.id)).toEqual([main!, worktree!]
        .sort((left, right) => left.worktreeUri.localeCompare(right.worktreeUri))
        .map((repository) => repository.id));
      expect(registry.listAssociated(main!.id).map((repository) => repository.id)).toEqual(expect.arrayContaining([main!.id, worktree!.id]));
      expect(() => registry.replace([main!, main!])).toThrow(/duplicate/i);
    } finally {
      await fixture.dispose();
    }
  });

  it('returns no descriptor for a non-repository and malformed Git output', async () => {
    const fixture = await createRepositoryFixture();
    try {
      expect(await locateRepository(fixture.runner, `${fixture.path}/missing`, { trusted: false })).toBeUndefined();
      const malformedRunner = {
        run: async () => ({
          exitCode: 0, stdout: Buffer.from(`${fixture.path}\n`), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
          stdoutText: () => `${fixture.path}\n`, stderrText: () => '',
        }),
      };
      expect(await locateRepository(malformedRunner, fixture.path, { trusted: false })).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('accepts exactly two complete CRLF-terminated Git path lines', async () => {
    const fixture = await createRepositoryFixture();
    try {
      const crlfRunner = {
        run: async (request: { args: readonly string[] }) => {
          const text = request.args[0] === 'rev-parse'
            ? `${fixture.path}\r\n${fixture.path}/.git\r\n`
            : request.args[0] === '--version' ? 'git version 2.46.0\n' : 'sha1\n';
          return {
            exitCode: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
            stdoutText: () => text, stderrText: () => '',
          };
        },
      };
      expect(await locateRepository(crlfRunner, fixture.path, { trusted: false })).toMatchObject({ worktreeUri: expect.stringContaining('file:') });
    } finally {
      await fixture.dispose();
    }
  });

  it('passes one cancellation signal through locator and all Git capability probes', async () => {
    const fixture = await createRepositoryFixture();
    try {
      const controller = new AbortController();
      const signals: AbortSignal[] = [];
      const runner = {
        run: async (request: { args: readonly string[]; signal?: AbortSignal }) => {
          if (request.signal !== undefined) signals.push(request.signal);
          const text = request.args[0] === 'rev-parse'
            ? `${fixture.path}\n${fixture.path}/.git\n`
            : request.args[0] === '--version' ? 'git version 2.46.0\n' : 'sha1\n';
          return { exitCode: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false, stdoutText: () => text, stderrText: () => '' };
        },
      };
      expect(await locateRepository(runner, fixture.path, { trusted: false, signal: controller.signal })).toBeDefined();
      expect(signals).not.toHaveLength(0);
      expect(signals.every((signal) => signal === controller.signal)).toBe(true);

      controller.abort();
      expect(await locateRepository(runner, fixture.path, { trusted: false, signal: controller.signal })).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('uses Global safety values only when the workspace is untrusted', () => {
    const values = new Map<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>([
      ['gitWorkbench.safety.mode', { globalValue: 'balanced', workspaceValue: 'strict' }],
      ['gitWorkbench.safety.publishedRewrite', { globalValue: 'confirm', workspaceValue: 'deny' }],
      ['gitWorkbench.safety.protectedBranches', { globalValue: ['stable/*'], workspaceFolderValue: ['release/next'] }],
    ]);
    const configuration = { inspect: <T>(key: string) => values.get(key) as { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined };

    expect(readEffectiveSafetySettings(configuration, false)).toEqual({
      mode: 'balanced', publishedRewrite: 'confirm', protectedBranches: ['main', 'master', 'release/*', 'stable/*'],
    });
    expect(readEffectiveSafetySettings(configuration, true)).toEqual({
      mode: 'strict', publishedRewrite: 'deny', protectedBranches: ['main', 'master', 'release/*', 'stable/*', 'release/next'],
    });
  });

  it('inherits VS Code git.path when the Git Workbench path is empty', () => {
    const folderUri = { scheme: 'file', path: '/workspace/project' };
    const inspected = new Map<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>([
      ['gitWorkbench.safety.mode', { globalValue: 'balanced', workspaceValue: 'balanced', workspaceFolderValue: 'strict' }],
      ['gitWorkbench.safety.publishedRewrite', { globalValue: 'confirm', workspaceValue: 'confirm', workspaceFolderValue: 'deny' }],
      ['gitWorkbench.safety.protectedBranches', { globalValue: ['stable/*'], workspaceValue: ['release/*'], workspaceFolderValue: ['folder/*'] }],
    ]);
    const calls: Array<{ section: string | undefined; resource: unknown }> = [];
    const configuration = {
      getConfiguration: (section?: string, resource?: unknown) => {
        calls.push({ section, resource });
        return {
        get: <T>(key: string, fallback: T) => {
          if (key === 'gitWorkbench.git.path') return '' as T;
          if (key === 'git.path') return '/custom/vscode-git' as T;
          return fallback;
        },
          inspect: <T>(key: string) => inspected.get(key) as { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
        };
      },
    };
    expect(createVscodeConfigSnapshot(true, configuration, folderUri)).toMatchObject({
      gitPath: '/custom/vscode-git',
      safety: {
        mode: 'strict', publishedRewrite: 'deny',
        protectedBranches: ['main', 'master', 'release/*', 'stable/*', 'folder/*'],
      },
    });
    expect(calls).toEqual([{ section: '', resource: folderUri }]);
    expect(createVscodeConfigSnapshot(false, configuration, folderUri).safety).toEqual({
      mode: 'balanced', publishedRewrite: 'confirm', protectedBranches: ['main', 'master', 'release/*', 'stable/*'],
    });
  });

  it('passes each workspace-folder URI through the activated discovery configuration chain', async () => {
    const folder = { uri: { fsPath: '/workspace/resource-aware-folder' } };
    vscodeState.configurationCalls.splice(0);
    vscodeState.commands.clear();
    vscodeState.workspace.workspaceFolders = [folder];
    const { activateExtension } = await import('../../src/extension/activate.js');
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    await activateExtension(context as never);
    await vscodeState.commands.get('gitWorkbench.open')!();

    expect(vscodeState.configurationCalls).toContainEqual({ section: '', resource: folder.uri });
  });

  it('re-discovers resource-scoped descriptors after workspace trust is granted', async () => {
    vi.useFakeTimers();
    try {
      const folder = { uri: { fsPath: '/workspace/trust-resource-folder' } };
      vscodeState.configurationCalls.splice(0);
      vscodeState.commands.clear();
      vscodeState.workspace.isTrusted = false;
      vscodeState.workspace.workspaceFolders = [folder];
      const { activateExtension } = await import('../../src/extension/activate.js');
      const context = { subscriptions: [] as Array<{ dispose(): void }> };
      await activateExtension(context as never);
      await vscodeState.commands.get('gitWorkbench.open')!();
      const beforeTrust = vscodeState.configurationCalls.length;

      vscodeState.workspace.isTrusted = true;
      vscodeState.trustListener!();
      await vi.advanceTimersByTimeAsync(250);

      expect(vscodeState.configurationCalls.length).toBeGreaterThan(beforeTrust);
      expect(vscodeState.configurationCalls.at(-1)).toEqual({ section: '', resource: folder.uri });
    } finally {
      vi.useRealTimers();
    }
  });
});
