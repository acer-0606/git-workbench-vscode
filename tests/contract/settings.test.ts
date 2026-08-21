import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

type ExpectedSetting = {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  default: unknown;
  scope: 'application' | 'machine' | 'window' | 'resource';
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
};

const expectedSettings: readonly ExpectedSetting[] = [
  { key: 'gitWorkbench.git.path', type: 'string', default: '', scope: 'machine' },
  { key: 'gitWorkbench.repositories.autoDetect', type: 'string', default: 'openFolders', scope: 'window', enum: ['openFolders', 'subFolders', 'off'] },
  { key: 'gitWorkbench.repositories.scanDepth', type: 'number', default: 2, scope: 'window', minimum: 1, maximum: 5 },
  { key: 'gitWorkbench.ui.followActiveRepository', type: 'boolean', default: true, scope: 'window' },
  { key: 'gitWorkbench.ui.compactMode', type: 'string', default: 'auto', scope: 'window', enum: ['auto', 'compact', 'comfortable'] },
  { key: 'gitWorkbench.graph.pageSize', type: 'number', default: 200, scope: 'resource', minimum: 50, maximum: 1000 },
  { key: 'gitWorkbench.graph.maxLanes', type: 'number', default: 50, scope: 'resource', minimum: 8, maximum: 200 },
  { key: 'gitWorkbench.graph.order', type: 'string', default: 'topo', scope: 'resource', enum: ['topo', 'date', 'authorDate'] },
  { key: 'gitWorkbench.graph.showWorkingTree', type: 'boolean', default: true, scope: 'resource' },
  { key: 'gitWorkbench.graph.showRemoteBranches', type: 'boolean', default: true, scope: 'resource' },
  { key: 'gitWorkbench.graph.showTags', type: 'boolean', default: true, scope: 'resource' },
  { key: 'gitWorkbench.graph.showStashes', type: 'boolean', default: true, scope: 'resource' },
  { key: 'gitWorkbench.graph.showWorktrees', type: 'boolean', default: true, scope: 'resource' },
  { key: 'gitWorkbench.compare.defaultMode', type: 'string', default: 'auto', scope: 'resource', enum: ['auto', 'direct', 'mergeBase'] },
  { key: 'gitWorkbench.compare.ignoreWhitespace', type: 'string', default: 'none', scope: 'resource', enum: ['none', 'eol', 'all'] },
  { key: 'gitWorkbench.compare.renameDetection', type: 'string', default: 'auto', scope: 'resource', enum: ['auto', 'on', 'off'] },
  { key: 'gitWorkbench.compare.maxFileSizeMB', type: 'number', default: 10, scope: 'machine', minimum: 1, maximum: 1024 },
  { key: 'gitWorkbench.compare.maxDiffLines', type: 'number', default: 20000, scope: 'machine', minimum: 1000, maximum: 200000 },
  { key: 'gitWorkbench.apply.defaultTarget', type: 'string', default: 'prompt', scope: 'resource', enum: ['prompt', 'worktree', 'index', 'newWorktree'] },
  { key: 'gitWorkbench.commit.smartCommit', type: 'boolean', default: false, scope: 'resource' },
  { key: 'gitWorkbench.pull.strategy', type: 'string', default: 'inherit', scope: 'resource', enum: ['inherit', 'prompt', 'ffOnly', 'merge', 'rebase'] },
  { key: 'gitWorkbench.fetch.prune', type: 'string', default: 'inherit', scope: 'resource', enum: ['inherit', 'on', 'off'] },
  { key: 'gitWorkbench.remote.autoFetch', type: 'boolean', default: false, scope: 'resource' },
  { key: 'gitWorkbench.remote.autoFetchIntervalMinutes', type: 'number', default: 10, scope: 'resource', minimum: 5, maximum: 1440 },
  { key: 'gitWorkbench.branch.dirtyWorktreeStrategy', type: 'string', default: 'prompt', scope: 'resource', enum: ['prompt', 'keep', 'stash', 'newWorktree'] },
  { key: 'gitWorkbench.stash.includeUntracked', type: 'boolean', default: false, scope: 'resource' },
  { key: 'gitWorkbench.conflict.autoOpen', type: 'string', default: 'prompt', scope: 'resource', enum: ['prompt', 'first', 'never'] },
  { key: 'gitWorkbench.safety.mode', type: 'string', default: 'balanced', scope: 'resource', enum: ['balanced', 'strict'] },
  { key: 'gitWorkbench.safety.protectedBranches', type: 'array', default: ['main', 'master', 'release/*'], scope: 'resource' },
  { key: 'gitWorkbench.safety.publishedRewrite', type: 'string', default: 'confirm', scope: 'resource', enum: ['deny', 'confirm'] },
  { key: 'gitWorkbench.safety.checkpointRetentionDays', type: 'number', default: 30, scope: 'machine', minimum: 1, maximum: 365 },
  { key: 'gitWorkbench.safety.checkpointMaxCount', type: 'number', default: 50, scope: 'machine', minimum: 5, maximum: 500 },
  { key: 'gitWorkbench.safety.checkpointMaxDiskMB', type: 'number', default: 2048, scope: 'machine', minimum: 256, maximum: 102400 },
  { key: 'gitWorkbench.performance.profile', type: 'string', default: 'auto', scope: 'machine', enum: ['auto', 'balanced', 'largeRepository'] },
  { key: 'gitWorkbench.performance.maxCacheMB', type: 'number', default: 150, scope: 'machine', minimum: 50, maximum: 2048 },
  { key: 'gitWorkbench.performance.maxConcurrentReads', type: 'number', default: 4, scope: 'machine', minimum: 1, maximum: 8 },
  { key: 'gitWorkbench.logging.level', type: 'string', default: 'error', scope: 'application', enum: ['off', 'error', 'warn', 'info', 'debug', 'trace'] },
  { key: 'gitWorkbench.diagnostics.redactPaths', type: 'boolean', default: true, scope: 'application' },
];

const root = process.cwd();
const execFileAsync = promisify(execFile);

async function createSyncFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'git-workbench-settings-'));
  await mkdir(join(fixture, 'config'), { recursive: true });
  await mkdir(join(fixture, 'packages/config/src'), { recursive: true });
  await Promise.all([
    readFile(join(root, 'config/settings.schema.json'), 'utf8').then((contents) => writeFile(join(fixture, 'config/settings.schema.json'), contents)),
    writeFile(join(fixture, 'package.json'), '{"name":"settings-fixture"}\n'),
    writeFile(join(fixture, 'package.nls.json'), '{"legacy":"keep"}\n'),
    writeFile(join(fixture, 'package.nls.zh-cn.json'), '{"legacy":"保留"}\n'),
  ]);
  return fixture;
}

async function runSyncFixture(fixture: string, env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, ['scripts/sync-settings.mjs'], {
    cwd: root,
    env: { ...process.env, ...env, GIT_WORKBENCH_SETTINGS_ROOT: fixture },
  });
}

describe('Git Workbench settings contract', () => {
  it('keeps the 38 approved settings schema, manifest, defaults, and localizations in lockstep', async () => {
    const schema = JSON.parse(await readFile(join(root, 'config/settings.schema.json'), 'utf8')) as {
      settings: Array<ExpectedSetting & {
        integer?: boolean;
        maxItems?: number;
        uniqueItems?: boolean;
        items?: { type: string; minLength?: number; maxLength?: number };
        descriptionKey: string;
        descriptions: { en: string; zhCN: string };
        enumDescriptionKeys?: string[];
        enumDescriptions?: { en: string[]; zhCN: string[] };
      }>;
    };
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
      capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations: string[] } };
    };
    const [english, chinese] = await Promise.all([
      readFile(join(root, 'package.nls.json'), 'utf8').then(JSON.parse) as Promise<Record<string, string>>,
      readFile(join(root, 'package.nls.zh-cn.json'), 'utf8').then(JSON.parse) as Promise<Record<string, string>>,
    ]);
    const generated = await import(new URL('../../packages/config/src/settings.ts', import.meta.url).href);

    expect(schema.settings).toHaveLength(38);
    expect(new Set(schema.settings.map((setting) => setting.key)).size).toBe(38);
    expect(schema.settings.map(({ key, type, default: value, scope, minimum, maximum, enum: choices }) => ({ key, type, default: value, scope, minimum, maximum, enum: choices }))).toEqual(expectedSettings);
    expect(Object.keys(manifest.contributes.configuration.properties)).toEqual(expectedSettings.map(({ key }) => key));
    expect(generated.SETTING_DEFAULTS).toEqual(Object.fromEntries(expectedSettings.map(({ key, default: value }) => [key, value])));

    for (const setting of schema.settings) {
      const property = manifest.contributes.configuration.properties[setting.key]!;
      expect(setting.descriptionKey).toBe(`config.${setting.key}`);
      expect(setting.descriptions.en.trim()).not.toBe('');
      expect(setting.descriptions.zhCN.trim()).not.toBe('');
      expect(english[setting.descriptionKey]).toBe(setting.descriptions.en);
      expect(chinese[setting.descriptionKey]).toBe(setting.descriptions.zhCN);
      expect(property.type).toBe(setting.type);
      expect(property.default).toEqual(setting.default);
      expect(property.scope).toBe(setting.scope);
      expect(property.minimum).toBe(setting.minimum);
      expect(property.maximum).toBe(setting.maximum);
      expect(property.markdownDescription).toBe(`%${setting.descriptionKey}%`);

      if (setting.enum) {
        expect(property.enum).toEqual(setting.enum);
        expect(setting.enumDescriptionKeys).toHaveLength(setting.enum.length);
        expect(setting.enumDescriptions?.en).toHaveLength(setting.enum.length);
        expect(setting.enumDescriptions?.zhCN).toHaveLength(setting.enum.length);
        expect(property.markdownEnumDescriptions).toEqual(setting.enumDescriptionKeys!.map((key) => `%${key}%`));
        for (const [index, key] of setting.enumDescriptionKeys!.entries()) {
          expect(english[key]).toBe(setting.enumDescriptions!.en[index]);
          expect(chinese[key]).toBe(setting.enumDescriptions!.zhCN[index]);
        }
      } else {
        expect(setting.enumDescriptionKeys).toBeUndefined();
        expect(setting.enumDescriptions).toBeUndefined();
        expect(property.enum).toBeUndefined();
      }
    }

    expect(chinese['config.gitWorkbench.compare.ignoreWhitespace']).toContain('只影响查看，不改变实际 Patch。工作台可会话级快捷覆盖');
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toEqual([
      'gitWorkbench.repositories.autoDetect',
      'gitWorkbench.repositories.scanDepth',
      'gitWorkbench.safety.protectedBranches',
    ]);
    expect(manifest.contributes.configuration).not.toHaveProperty('restrictedConfigurations');
    expect(manifest.contributes.configuration).toMatchObject({
      title: 'Git Workbench',
      properties: expect.any(Object),
    });
    expect(manifest.contributes.configuration.properties['gitWorkbench.safety.mode']).toBeDefined();
    expect((manifest.contributes as { configuration: { properties: unknown; restrictedConfigurations: unknown; } }).configuration).toBeDefined();
    expect((manifest as { capabilities?: { untrustedWorkspaces?: { supported?: string } } }).capabilities?.untrustedWorkspaces?.supported).toBe('limited');
    expect(schema.settings.find((setting) => setting.key === 'gitWorkbench.safety.protectedBranches')).toMatchObject({
      type: 'array',
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    });
    expect(manifest.contributes.configuration.properties['gitWorkbench.safety.protectedBranches']).toMatchObject({
      type: 'array',
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    });
    for (const setting of schema.settings.filter((setting) => setting.integer)) {
      const property = manifest.contributes.configuration.properties[setting.key]!;
      expect(property.multipleOf).toBe(1);
      expect(Number.isInteger(setting.default)).toBe(true);
    }
  });

  it('merges safety layers without allowing lower-strictness values to weaken them', async () => {
    const { mergeSafetyLayers } = await import(new URL('../../packages/config/src/settings.ts', import.meta.url).href);

    expect(mergeSafetyLayers({ global: { mode: 'strict', publishedRewrite: 'deny', protectedBranches: ['stable/*'] }, workspace: { mode: 'balanced', publishedRewrite: 'confirm', protectedBranches: ['develop'] }, folder: { protectedBranches: ['feature/*'] } })).toEqual({
      mode: 'strict',
      publishedRewrite: 'deny',
      protectedBranches: ['main', 'master', 'release/*', 'stable/*', 'develop', 'feature/*'],
    });
    expect(mergeSafetyLayers({ folder: { protectedBranches: [] } }).protectedBranches).toEqual(['main', 'master', 'release/*']);
    expect(mergeSafetyLayers({ workspace: { mode: 'strict' } }).publishedRewrite).toBe('deny');
    expect(mergeSafetyLayers({ folder: { protectedBranches: [' feature/* ', 42, '  ', 'main '] as unknown as string[] } }).protectedBranches).toEqual(['main', 'master', 'release/*', 'feature/*']);
    expect(mergeSafetyLayers({ folder: { protectedBranches: 'feature/*' as unknown as string[] } }).protectedBranches).toEqual(['main', 'master', 'release/*']);
  });

  it('rejects fractional values for every integer setting at runtime', async () => {
    const { SETTING_DEFAULTS, validateConfigSnapshot } = await import(new URL('../../packages/config/src/settings.ts', import.meta.url).href);
    const schema = JSON.parse(await readFile(join(root, 'config/settings.schema.json'), 'utf8')) as { settings: Array<ExpectedSetting & { integer?: boolean }> };

    for (const setting of schema.settings.filter((entry) => entry.integer)) {
      expect(() => validateConfigSnapshot({ ...SETTING_DEFAULTS, [setting.key]: 1.5 })).toThrow(setting.key);
    }
    expect(() => validateConfigSnapshot({ ...SETTING_DEFAULTS, 'gitWorkbench.repositories.scanDepth': 99 })).toThrow('gitWorkbench.repositories.scanDepth');
    expect(() => validateConfigSnapshot({ ...SETTING_DEFAULTS, 'gitWorkbench.safety.mode': 'permissive' })).toThrow('gitWorkbench.safety.mode');
    expect(validateConfigSnapshot({} as typeof SETTING_DEFAULTS)).toEqual(SETTING_DEFAULTS);
  });

  it('fails closed for safety-enum drift and missing schemas', async () => {
    const fixture = await createSyncFixture();
    try {
      const schemaPath = join(fixture, 'config/settings.schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
        settings: Array<{
          key: string;
          enum?: string[];
          enumDescriptionKeys?: string[];
          enumDescriptions?: { en: string[]; zhCN: string[] };
        }>;
      };
      const safetyMode = schema.settings.find((setting) => setting.key === 'gitWorkbench.safety.mode')!;
      safetyMode.enum!.push('permissive');
      safetyMode.enumDescriptionKeys!.push('enum.gitWorkbench.safety.mode.permissive');
      safetyMode.enumDescriptions!.en.push('Allow weak safety.');
      safetyMode.enumDescriptions!.zhCN.push('允许弱安全。');
      await writeFile(schemaPath, `${JSON.stringify(schema)}\n`);

      await expect(runSyncFixture(fixture)).rejects.toMatchObject({ stderr: expect.stringContaining('safety.mode enum drift') });
      await rm(schemaPath);
      await expect(runSyncFixture(fixture)).rejects.toMatchObject({ stderr: expect.stringContaining('ENOENT') });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('leaves generated files untouched when staged synchronization fails', async () => {
    const fixture = await createSyncFixture();
    try {
      await runSyncFixture(fixture);
      const outputPaths = [
        'package.json',
        'package.nls.json',
        'package.nls.zh-cn.json',
        'packages/config/src/settings.ts',
      ];
      const before = await Promise.all(outputPaths.map((path) => readFile(join(fixture, path), 'utf8')));
      const schemaPath = join(fixture, 'config/settings.schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as { settings: Array<{ key: string; default: unknown }> };
      schema.settings.find((setting) => setting.key === 'gitWorkbench.graph.pageSize')!.default = 201;
      await writeFile(schemaPath, `${JSON.stringify(schema)}\n`);

      await expect(runSyncFixture(fixture, { GIT_WORKBENCH_SETTINGS_FAIL_AFTER_REPLACEMENTS: '1' })).rejects.toThrow('simulated settings replacement failure');

      await expect(Promise.all(outputPaths.map((path) => readFile(join(fixture, path), 'utf8')))).resolves.toEqual(before);
      await expect(Promise.all([readdir(fixture), readdir(join(fixture, 'packages/config/src'))])).resolves.toEqual([
        expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]),
        expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]),
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
