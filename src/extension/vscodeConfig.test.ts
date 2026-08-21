import { describe, expect, it } from 'vitest';

import { createVscodeConfigSnapshot, readEffectiveSafetySettings, type SafetyWorkspaceConfiguration, type VscodeConfigurationSource } from './vscodeConfig.js';

interface StoredValues {
  readonly global?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly folder?: Record<string, unknown>;
}

function configurationSource(values: StoredValues): VscodeConfigurationSource {
  return {
    getConfiguration: () => ({
      get<T>(section: string, defaultValue: T): T {
        const value = values.folder?.[section] ?? values.workspace?.[section] ?? values.global?.[section];
        return (value === undefined ? defaultValue : value) as T;
      },
      inspect<T>(section: string) {
        const globalValue = values.global?.[section] as T | undefined;
        const workspaceValue = values.workspace?.[section] as T | undefined;
        const workspaceFolderValue = values.folder?.[section] as T | undefined;
        return globalValue === undefined && workspaceValue === undefined && workspaceFolderValue === undefined
          ? undefined
          : {
              ...(globalValue === undefined ? {} : { globalValue }),
              ...(workspaceValue === undefined ? {} : { workspaceValue }),
              ...(workspaceFolderValue === undefined ? {} : { workspaceFolderValue }),
            };
      },
    } satisfies SafetyWorkspaceConfiguration & { get<T>(section: string, defaultValue: T): T }),
  };
}

describe('createVscodeConfigSnapshot git executable selection', () => {
  it('prefers gitWorkbench.git.path over git.path in trusted workspaces', () => {
    const snapshot = createVscodeConfigSnapshot(true, configurationSource({
      global: { 'git.path': '/usr/global/bin/git' },
      workspace: { 'gitWorkbench.git.path': '/usr/workspace/bin/git' },
    }));
    expect(snapshot.gitPath).toBe('/usr/workspace/bin/git');
  });

  it('falls back to git.path and then the system Git in trusted workspaces', () => {
    expect(createVscodeConfigSnapshot(true, configurationSource({
      workspace: { 'git.path': '/usr/workspace/bin/git' },
    })).gitPath).toBe('/usr/workspace/bin/git');
    expect(createVscodeConfigSnapshot(true, configurationSource({})).gitPath).toBe('git');
  });

  it('uses the first usable path when the Git path is configured as an array', () => {
    const snapshot = createVscodeConfigSnapshot(true, configurationSource({
      workspace: { 'gitWorkbench.git.path': ['', '/usr/workspace/bin/git'] },
    }));
    expect(snapshot.gitPath).toBe('/usr/workspace/bin/git');
  });

  it('ignores workspace-provided Git paths in untrusted workspaces', () => {
    const snapshot = createVscodeConfigSnapshot(false, configurationSource({
      global: { 'git.path': '/usr/global/bin/git' },
      workspace: { 'gitWorkbench.git.path': '/usr/workspace/bin/git', 'git.path': '/usr/workspace/bin/git' },
      folder: { 'gitWorkbench.git.path': '/usr/folder/bin/git' },
    }));
    expect(snapshot.gitPath).toBe('/usr/global/bin/git');
  });

  it('uses the system Git when an untrusted workspace is the only place a path is set', () => {
    const snapshot = createVscodeConfigSnapshot(false, configurationSource({
      workspace: { 'gitWorkbench.git.path': '/usr/workspace/bin/git', 'git.path': '/usr/workspace/bin/git' },
    }));
    expect(snapshot.gitPath).toBe('git');
  });

  it('keeps user-level Git path configuration in untrusted workspaces', () => {
    const snapshot = createVscodeConfigSnapshot(false, configurationSource({
      global: { 'gitWorkbench.git.path': '/usr/global/bin/git-workbench' },
    }));
    expect(snapshot.gitPath).toBe('/usr/global/bin/git-workbench');
  });
});

describe('readEffectiveSafetySettings trust handling', () => {
  it('ignores workspace and folder safety layers while untrusted', () => {
    const configuration = configurationSource({
      global: { 'gitWorkbench.safety.mode': 'balanced' },
      workspace: { 'gitWorkbench.safety.mode': 'off', 'gitWorkbench.safety.publishedRewrite': 'allow' },
      folder: { 'gitWorkbench.safety.protectedBranches': ['workspace-only/*'] },
    }).getConfiguration('');
    const safety = readEffectiveSafetySettings(configuration as SafetyWorkspaceConfiguration, false);
    expect(safety.mode).toBe('balanced');
    expect(safety.protectedBranches).toEqual(['main', 'master', 'release/*']);
  });

  it('honours the strictest layer across scopes in trusted workspaces', () => {
    const configuration = configurationSource({
      global: { 'gitWorkbench.safety.mode': 'balanced' },
      workspace: { 'gitWorkbench.safety.mode': 'strict' },
    }).getConfiguration('');
    const safety = readEffectiveSafetySettings(configuration as SafetyWorkspaceConfiguration, true);
    expect(safety.mode).toBe('strict');
  });
});
