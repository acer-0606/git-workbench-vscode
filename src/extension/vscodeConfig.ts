import {
  mergeSafetyLayers,
  type EffectiveSafetySettings,
  type PublishedRewritePolicy,
  type SafetyLayer,
  type SafetyLayers,
  type SafetyMode,
} from '@git-workbench/config';
import type { RepositoryAutoDetectMode } from './repositoryDiscovery.js';

interface InspectedSetting<T> {
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
}

/** Minimal VS Code configuration seam, kept structural so it is unit-testable. */
export interface SafetyWorkspaceConfiguration {
  inspect?<T>(section: string): InspectedSetting<T> | undefined;
}

interface ConfigurationReader extends SafetyWorkspaceConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

/** Structural Workspace seam avoids importing the VS Code runtime in tests. */
export interface VscodeConfigurationSource {
  getConfiguration(section?: string, resource?: unknown): ConfigurationReader;
}

export interface VscodeConfigSnapshot {
  readonly gitPath: string;
  readonly autoDetect: RepositoryAutoDetectMode;
  readonly scanDepth: number;
  readonly safety: EffectiveSafetySettings;
}

function configuredGitPath(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value)) return value.find((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')?.trim();
  return undefined;
}

/** Creates the Foundation-owned, immutable configuration view for one run. */
export function createVscodeConfigSnapshot(
  trusted: boolean,
  workspace: VscodeConfigurationSource,
  resource?: unknown,
): VscodeConfigSnapshot {
  // An empty section plus a folder URI is the only form where inspect() can
  // faithfully expose Global, Workspace and WorkspaceFolder values together.
  const configuration = workspace.getConfiguration('', resource);
  // An untrusted workspace must never choose the Git executable: `git.path`
  // is not machine-scoped, so its workspace value survives VS Code's own
  // restricted-configuration blanking. Only user-configured paths count.
  const configuredPath = trusted
    ? configuredGitPath(configuration.get<unknown>('gitWorkbench.git.path', ''))
      ?? configuredGitPath(configuration.get<unknown>('git.path', ''))
    : configuredGitPath(configuration.inspect?.<unknown>('gitWorkbench.git.path')?.globalValue)
      ?? configuredGitPath(configuration.inspect?.<unknown>('git.path')?.globalValue);
  const gitPath = configuredPath ?? 'git';
  const autoDetect = configuration.get<unknown>('gitWorkbench.repositories.autoDetect', 'openFolders');
  const scanDepth = configuration.get<unknown>('gitWorkbench.repositories.scanDepth', 2);
  return Object.freeze({
    gitPath,
    autoDetect: autoDetect === 'openFolders' || autoDetect === 'subFolders' || autoDetect === 'off' ? autoDetect : 'openFolders',
    scanDepth: typeof scanDepth === 'number' && Number.isInteger(scanDepth) && scanDepth >= 1 && scanDepth <= 5 ? scanDepth : 2,
    safety: readEffectiveSafetySettings(configuration, trusted),
  });
}

function layerAt<T extends SafetyMode | PublishedRewritePolicy | readonly string[]>(
  configuration: SafetyWorkspaceConfiguration,
  property: string,
  scope: keyof InspectedSetting<T>,
): T | undefined {
  return configuration.inspect?.<T>(property)?.[scope];
}

function layer(configuration: SafetyWorkspaceConfiguration, scope: keyof InspectedSetting<never>): SafetyLayer {
  const mode = layerAt<SafetyMode>(configuration, 'gitWorkbench.safety.mode', scope);
  const protectedBranches = layerAt<readonly string[]>(configuration, 'gitWorkbench.safety.protectedBranches', scope);
  const publishedRewrite = layerAt<PublishedRewritePolicy>(configuration, 'gitWorkbench.safety.publishedRewrite', scope);
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(protectedBranches === undefined ? {} : { protectedBranches }),
    ...(publishedRewrite === undefined ? {} : { publishedRewrite }),
  };
}

/**
 * Reads each configuration scope with inspect(), then applies the monotonic
 * safety merge.  An untrusted workspace is intentionally limited to Global.
 */
export function readEffectiveSafetySettings(
  configuration: SafetyWorkspaceConfiguration,
  trusted: boolean,
): EffectiveSafetySettings {
  const layers: SafetyLayers = trusted
    ? {
      global: layer(configuration, 'globalValue'),
      workspace: layer(configuration, 'workspaceValue'),
      folder: layer(configuration, 'workspaceFolderValue'),
    }
    : { global: layer(configuration, 'globalValue') };
  return mergeSafetyLayers(layers);
}
