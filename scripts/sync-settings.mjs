import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.GIT_WORKBENCH_SETTINGS_ROOT
  ?? fileURLToPath(new URL('..', import.meta.url));
const schemaPath = join(root, 'config/settings.schema.json');
const manifestPath = join(root, 'package.json');
const englishPath = join(root, 'package.nls.json');
const chinesePath = join(root, 'package.nls.zh-cn.json');
const generatedSettingsPath = join(root, 'packages/config/src/settings.ts');
const safetyModeValues = ['balanced', 'strict'];
const publishedRewriteValues = ['deny', 'confirm'];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readOptionalJson(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function validateSetting(setting) {
  const validTypes = new Set(['string', 'number', 'boolean', 'array']);
  const validScopes = new Set(['application', 'machine', 'window', 'resource']);
  for (const field of ['key', 'type', 'default', 'scope', 'descriptionKey', 'descriptions']) {
    if (!(field in setting)) throw new Error(`Setting is missing ${field}`);
  }
  if (!validTypes.has(setting.type)) throw new Error(`Unsupported setting type: ${setting.key}`);
  if (!validScopes.has(setting.scope)) throw new Error(`Unsupported setting scope: ${setting.key}`);
  if (!setting.key.startsWith('gitWorkbench.')) throw new Error(`Setting key must start with gitWorkbench.: ${setting.key}`);
  if (setting.descriptionKey !== `config.${setting.key}`) throw new Error(`Description key does not match setting key: ${setting.key}`);
  if (!setting.descriptions.en?.trim() || !setting.descriptions.zhCN?.trim()) throw new Error(`Descriptions must be non-empty: ${setting.key}`);
  if (setting.type === 'string' && typeof setting.default !== 'string') throw new Error(`String setting must have a string default: ${setting.key}`);
  if (setting.type === 'boolean' && typeof setting.default !== 'boolean') throw new Error(`Boolean setting must have a boolean default: ${setting.key}`);
  if (setting.type === 'array') {
    if (!Array.isArray(setting.default) || setting.items?.type !== 'string') throw new Error(`Array setting must have string items and an array default: ${setting.key}`);
    if (!setting.default.every((value) => typeof value === 'string')) throw new Error(`Array default must contain strings: ${setting.key}`);
    if (setting.maxItems !== undefined && (!Number.isInteger(setting.maxItems) || setting.maxItems < setting.default.length)) throw new Error(`Array maxItems is invalid: ${setting.key}`);
    if (setting.uniqueItems && new Set(setting.default).size !== setting.default.length) throw new Error(`Array default must be unique: ${setting.key}`);
    if ((setting.items.minLength !== undefined && (!Number.isInteger(setting.items.minLength) || setting.items.minLength < 0))
      || (setting.items.maxLength !== undefined && (!Number.isInteger(setting.items.maxLength) || setting.items.maxLength < setting.items.minLength))) {
      throw new Error(`Array item length constraints are invalid: ${setting.key}`);
    }
  }
  if (setting.type === 'number') {
    if (typeof setting.default !== 'number' || !Number.isFinite(setting.default)) throw new Error(`Number setting must have a finite numeric default: ${setting.key}`);
    if (setting.integer && !Number.isInteger(setting.default)) throw new Error(`Integer setting must have an integer default: ${setting.key}`);
    if (setting.integer && ((setting.minimum !== undefined && !Number.isInteger(setting.minimum)) || (setting.maximum !== undefined && !Number.isInteger(setting.maximum)))) throw new Error(`Integer range must have integer bounds: ${setting.key}`);
    if ((setting.minimum !== undefined && typeof setting.minimum !== 'number') || (setting.maximum !== undefined && typeof setting.maximum !== 'number') || setting.minimum > setting.maximum || (setting.minimum !== undefined && setting.default < setting.minimum) || (setting.maximum !== undefined && setting.default > setting.maximum)) {
      throw new Error(`Number range is invalid: ${setting.key}`);
    }
  } else if (setting.minimum !== undefined || setting.maximum !== undefined || setting.integer) {
    throw new Error(`Numeric constraints require a number setting: ${setting.key}`);
  }
  if (setting.type !== 'array' && (setting.maxItems !== undefined || setting.uniqueItems !== undefined || setting.items !== undefined)) throw new Error(`Array constraints require an array setting: ${setting.key}`);
  if (setting.enum) {
    if (!Array.isArray(setting.enum) || !setting.enum.includes(setting.default)
      || setting.enumDescriptionKeys?.length !== setting.enum.length
      || setting.enumDescriptions?.en?.length !== setting.enum.length
      || setting.enumDescriptions?.zhCN?.length !== setting.enum.length) {
      throw new Error(`Enum descriptions must match enum length and include the default: ${setting.key}`);
    }
    for (const [index, value] of setting.enum.entries()) {
      if (typeof value !== 'string' || setting.enumDescriptionKeys[index] !== `enum.${setting.key}.${value}` || !setting.enumDescriptions.en[index]?.trim() || !setting.enumDescriptions.zhCN[index]?.trim()) {
        throw new Error(`Enum localization is invalid: ${setting.key}`);
      }
    }
  } else if (setting.enumDescriptionKeys || setting.enumDescriptions) {
    throw new Error(`Enum localizations require an enum: ${setting.key}`);
  }
}

function validateSafetyEnums(settings) {
  const enumFor = (key) => settings.find((setting) => setting.key === key)?.enum;
  const equal = (actual, expected) => Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
  if (!equal(enumFor('gitWorkbench.safety.mode'), safetyModeValues)) {
    throw new Error('gitWorkbench.safety.mode enum drift');
  }
  if (!equal(enumFor('gitWorkbench.safety.publishedRewrite'), publishedRewriteValues)) {
    throw new Error('gitWorkbench.safety.publishedRewrite enum drift');
  }
}

function manifestProperty(setting) {
  const property = { type: setting.type, default: setting.default, scope: setting.scope, markdownDescription: `%${setting.descriptionKey}%` };
  if (setting.minimum !== undefined) property.minimum = setting.minimum;
  if (setting.maximum !== undefined) property.maximum = setting.maximum;
  if (setting.integer) property.multipleOf = 1;
  if (setting.maxItems !== undefined) property.maxItems = setting.maxItems;
  if (setting.uniqueItems !== undefined) property.uniqueItems = setting.uniqueItems;
  if (setting.enum) {
    property.enum = setting.enum;
    property.markdownEnumDescriptions = setting.enumDescriptionKeys.map((key) => `%${key}%`);
  }
  if (setting.items) property.items = setting.items;
  return property;
}

function renderSettingsModule(settings) {
  const defaults = Object.fromEntries(settings.map((setting) => [setting.key, setting.default]));
  const typeUnion = (values) => values.map((value) => JSON.stringify(value)).join(' | ');
  const typeForSetting = (setting) => {
    if (setting.enum) return typeUnion(setting.enum);
    if (setting.type === 'array') return `readonly ${setting.items?.type ?? 'unknown'}[]`;
    return setting.type;
  };
  const settingsValues = settings.map((setting) => `  readonly ${JSON.stringify(setting.key)}: ${typeForSetting(setting)};`).join('\n');
  return `// This file is generated by scripts/sync-settings.mjs. Do not edit manually.\n\nexport interface SettingsValues {\n${settingsValues}\n}\n\nexport type SettingKey = keyof SettingsValues;\nexport type ConfigSnapshot = Readonly<SettingsValues>;\n\nexport const SETTING_DEFAULTS: ConfigSnapshot = ${JSON.stringify(defaults, null, 2)};\n\nexport type SafetyMode = SettingsValues['gitWorkbench.safety.mode'];\nexport type PublishedRewritePolicy = SettingsValues['gitWorkbench.safety.publishedRewrite'];\n\nexport interface SafetyLayer {\n  readonly mode?: SafetyMode;\n  readonly protectedBranches?: readonly string[];\n  readonly publishedRewrite?: PublishedRewritePolicy;\n}\n\nexport interface SafetyLayers {\n  readonly global?: SafetyLayer;\n  readonly workspace?: SafetyLayer;\n  readonly folder?: SafetyLayer;\n}\n\nexport interface EffectiveSafetySettings {\n  readonly mode: SafetyMode;\n  readonly protectedBranches: readonly string[];\n  readonly publishedRewrite: PublishedRewritePolicy;\n}\n\nconst minimumProtectedBranches: readonly string[] = [\n  'main',\n  'master',\n  'release/*',\n];\n\n/**\n * Combines values inspected from Extension Host Global, Workspace, and Folder.\n * Safety values are monotonic: lower layers can only add protections.\n */\nexport function mergeSafetyLayers(layers: SafetyLayers): EffectiveSafetySettings {\n  let mode: SafetyMode = SETTING_DEFAULTS['gitWorkbench.safety.mode'];\n  let publishedRewrite: PublishedRewritePolicy = SETTING_DEFAULTS['gitWorkbench.safety.publishedRewrite'];\n  const protectedBranches: string[] = [...minimumProtectedBranches];\n\n  for (const layer of [layers.global, layers.workspace, layers.folder]) {\n    if (!layer) continue;\n    if (layer.mode === 'strict') mode = 'strict';\n    if (layer.publishedRewrite === 'deny') publishedRewrite = 'deny';\n    for (const branch of layer.protectedBranches ?? []) {\n      if (branch.trim() && !protectedBranches.includes(branch)) protectedBranches.push(branch);\n    }\n  }\n\n  return { mode, protectedBranches, publishedRewrite };\n}\n`;
}

function renderSettingsModuleWithSafetyInvariants(settings) {
  const validation = Object.fromEntries(settings.map((setting) => [setting.key, {
    type: setting.type, integer: Boolean(setting.integer), minimum: setting.minimum,
    maximum: setting.maximum, enum: setting.enum, maxItems: setting.maxItems,
    uniqueItems: setting.uniqueItems, items: setting.items,
  }]));
  const source = renderSettingsModule(settings)
    .replace(
      "export type SafetyMode = SettingsValues['gitWorkbench.safety.mode'];",
      `export type SafetyMode = ${safetyModeValues.map((value) => JSON.stringify(value)).join(' | ')};`,
    )
    .replace(
      "export type PublishedRewritePolicy = SettingsValues['gitWorkbench.safety.publishedRewrite'];",
      `export type PublishedRewritePolicy = ${publishedRewriteValues.map((value) => JSON.stringify(value)).join(' | ')};`,
    )
    .replace(
      "if (layer.mode === 'strict') mode = 'strict';",
      "if (layer.mode === 'strict') { mode = 'strict'; publishedRewrite = 'deny'; }",
    )
    .replace(
      "for (const branch of layer.protectedBranches ?? []) {\n      if (branch.trim() && !protectedBranches.includes(branch)) protectedBranches.push(branch);\n    }",
      "if (!Array.isArray(layer.protectedBranches)) continue;\n    for (const branch of layer.protectedBranches) {\n      if (typeof branch !== 'string') continue;\n      const normalizedBranch = branch.trim();\n      if (normalizedBranch && !protectedBranches.includes(normalizedBranch)) protectedBranches.push(normalizedBranch);\n    }",
    );

  return [
    source,
    '',
    `const SETTING_VALIDATION = ${JSON.stringify(validation, null, 2)} as const;`,
    '',
    '/** Validates schema-derived runtime metadata and fills missing defaults. */',
    'export function validateConfigSnapshot(snapshot: Partial<ConfigSnapshot>): ConfigSnapshot {',
    '  const normalized = { ...SETTING_DEFAULTS, ...snapshot } as ConfigSnapshot;',
    '  for (const [key, constraint] of Object.entries(SETTING_VALIDATION)) {',
    '    const value = normalized[key as SettingKey];',
    "    const invalidNumber = constraint.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || (constraint.integer && !Number.isInteger(value)) || (constraint.minimum !== undefined && value < constraint.minimum) || (constraint.maximum !== undefined && value > constraint.maximum));",
    "    const invalidEnum = 'enum' in constraint && constraint.enum !== undefined && !constraint.enum.includes(value as never);",
    "    const invalidArray = constraint.type === 'array' && (!Array.isArray(value) || (constraint.maxItems !== undefined && value.length > constraint.maxItems) || (constraint.uniqueItems && new Set(value).size !== value.length) || !value.every((item) => typeof item === constraint.items?.type && item.length >= (constraint.items.minLength ?? 0) && (constraint.items.maxLength === undefined || item.length <= constraint.items.maxLength)));",
    "    if ((constraint.type === 'string' && typeof value !== 'string') || (constraint.type === 'boolean' && typeof value !== 'boolean') || invalidNumber || invalidEnum || invalidArray) {",
    '      throw new Error(`Invalid setting: ${key}`);',
    '    }',
    '  }',
    '  return normalized;',
    '}',
    '',
  ].join('\n');
}

async function writeFilesAtomically(outputs) {
  const entries = [];
  try {
    for (const [index, { path, contents }] of outputs.entries()) {
      let original;
      try {
        original = await readFile(path);
      } catch (error) {
        if (error && typeof error === 'object' && error.code !== 'ENOENT') throw error;
      }
      const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${index}.tmp`);
      await writeFile(temporaryPath, contents);
      entries.push({ path, temporaryPath, original });
    }
  } catch (error) {
    await Promise.all(entries.map(({ temporaryPath }) => rm(temporaryPath, { force: true })));
    throw error;
  }
  const replaced = [];
  try {
    for (const entry of entries) {
      await rename(entry.temporaryPath, entry.path);
      replaced.push(entry);
      if (Number(process.env.GIT_WORKBENCH_SETTINGS_FAIL_AFTER_REPLACEMENTS) === replaced.length) {
        throw new Error('simulated settings replacement failure');
      }
    }
  } catch (error) {
    await Promise.all(replaced.map(async (entry) => {
      if (entry.original === undefined) await rm(entry.path, { force: true });
      else await writeFile(entry.path, entry.original);
    }));
    throw error;
  } finally {
    await Promise.all(entries.map(({ temporaryPath }) => rm(temporaryPath, { force: true })));
  }
}

const schema = await readJson(schemaPath);
if (!Array.isArray(schema.settings)) throw new Error('settings schema must contain a settings array');
schema.settings.forEach(validateSetting);
validateSafetyEnums(schema.settings);
if (new Set(schema.settings.map((setting) => setting.key)).size !== schema.settings.length) throw new Error('settings schema contains duplicate keys');

const [manifest, english, chinese] = await Promise.all([readJson(manifestPath), readOptionalJson(englishPath), readOptionalJson(chinesePath)]);
const properties = Object.fromEntries(schema.settings.map((setting) => [setting.key, manifestProperty(setting)]));
const restrictedConfigurations = [
  'gitWorkbench.repositories.autoDetect',
  'gitWorkbench.repositories.scanDepth',
  'gitWorkbench.safety.protectedBranches',
];
manifest.contributes ??= {};
manifest.contributes.configuration = { title: 'Git Workbench', properties };
manifest.capabilities = {
  ...manifest.capabilities,
  untrustedWorkspaces: {
    ...manifest.capabilities?.untrustedWorkspaces,
    supported: 'limited',
    restrictedConfigurations,
  },
};

for (const nls of [english, chinese]) {
  for (const key of Object.keys(nls)) {
    if (/^(config|enum)\.gitWorkbench\./.test(key)) delete nls[key];
  }
}
for (const setting of schema.settings) {
  english[setting.descriptionKey] = setting.descriptions.en;
  chinese[setting.descriptionKey] = setting.descriptions.zhCN;
  for (const [index, key] of (setting.enumDescriptionKeys ?? []).entries()) {
    english[key] = setting.enumDescriptions.en[index];
    chinese[key] = setting.enumDescriptions.zhCN[index];
  }
}

await writeFilesAtomically([
  { path: manifestPath, contents: json(manifest) },
  { path: englishPath, contents: json(english) },
  { path: chinesePath, contents: json(chinese) },
  { path: generatedSettingsPath, contents: renderSettingsModuleWithSafetyInvariants(schema.settings) },
]);
console.log(`synchronized ${schema.settings.length} Git Workbench settings`);
