# Git Workbench Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可在 macOS、Windows、Linux 与 VS Code Remote Extension Host 中运行的 Git Workbench 基础工程，并以测试锁定领域模型、38 项 Settings、系统 Git CLI、仓库发现和只读状态解析。

**Architecture:** 使用 npm workspaces 管理纯 TypeScript 包，`packages/domain` 保持无 Node/VS Code 依赖，`packages/git-cli` 通过参数数组启动系统 Git，`src/extension` 只做 VS Code 适配。配置与 IPC 都有单一 Schema 来源；读写能力通过 Capability Probe 决定，低于正式支持能力时只读降级。

**Tech Stack:** TypeScript、Node.js Extension Host、VS Code API `>=1.96.0`、npm workspaces、esbuild、Vitest、Ajv/JSON Schema、`@vscode/test-electron`、Git `>=2.35.3`（写操作支持基线）

---

**Authoritative spec:** `docs/superpowers/specs/2026-08-20-git-workbench-vscode-extension-design.md`

## 边界与阶段出口

本计划是六份计划中的第 1 份，只交付规格第 18 节的 Phase 0。完成后必须满足：

- 三平台能够发现打开目录中的普通仓库、Worktree 与嵌套仓库。
- 能安全运行只读 Git 命令，并解析 `status --porcelain=v2 -z --branch`。
- 38 项 Settings 的 Manifest、运行时默认值、作用域和中英文描述一致。
- 未信任工作区不读取工作区提供的危险配置，也不暴露写/网络入口。
- 其余五个计划只能依赖这里公开的接口，不能直接调用 `child_process`。

## 文件结构

```text
package.json                         VS Code Manifest、workspaces 与统一 scripts
package-lock.json                    全平台一致的依赖锁
tsconfig.base.json                   共享 TypeScript 规则
tsconfig.json                        Project references
tsconfig.extension.json              Extension 与测试适配层 TypeScript 项目
esbuild.mjs                          Extension bundle
.vscodeignore                        VSIX 内容白名单
README.md                            Marketplace/VSIX 使用说明
CHANGELOG.md                         Preview 版本变更记录
config/settings.schema.json          38 项 Settings 的机器可读单一来源
package.nls.json                     英文 Settings/Command 文案
package.nls.zh-cn.json               中文 Settings/Command 文案
scripts/sync-settings.mjs            将 Schema 同步到 package.json
scripts/scaffold-workspaces.mjs      一次性创建六个固定内部包
packages/domain/src/ids.ts           Branded IDs
packages/domain/src/errors.ts        稳定错误码与错误载荷
packages/domain/src/repository.ts    仓库、状态和能力模型
packages/domain/src/index.ts         领域公开 API
packages/protocol/src/envelope.ts    Host/Webview 消息信封
packages/protocol/src/validate.ts    Ajv 边界校验
packages/config/src/settings.ts      默认值和安全合并
packages/config/src/index.ts         配置公开 API
packages/git-cli/src/process.ts      可取消、有限输出的 Git 进程
packages/git-cli/src/ports.ts        后续阶段共用 Query/Mutation Provider 类型
packages/git-cli/src/capabilities.ts 能力探测和只读降级
packages/git-cli/src/status.ts       Porcelain v2 NUL 流解析
packages/git-cli/src/locator.ts      仓库定位
packages/git-cli/src/index.ts        CLI 公开 API
packages/transactions/src/ports.ts   后续 Mutation 所需端口，不含写实现
packages/testkit/src/repository.ts   真实临时 Git 仓库夹具
src/extension/activate.ts            懒激活组合根
src/extension/repositoryDiscovery.ts 有界 Workspace 仓库发现
src/extension/repositoryRegistry.ts  多根仓库注册表
src/extension/vscodeConfig.ts        VS Code Settings 适配
src/extension.ts                     Extension entrypoint
tests/contract/settings.test.ts      Settings 漂移测试
tests/integration/repository.test.ts 真实 Git 集成测试
tests/vscode/suite/activation.test.ts VS Code Host 测试
tests/vscode/suite/index.ts           Mocha suite loader
tests/vscode/tsconfig.json            CommonJS Extension Test 编译
.github/workflows/ci.yml              三平台 CI
```

### Task 1: 初始化可构建的 Workspace

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `tsconfig.extension.json`
- Create: `esbuild.mjs`
- Create: `.vscodeignore`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `src/extension.ts`
- Test: `tests/smoke/workspace.test.ts`

- [ ] **Step 1: 写失败的工程结构测试**

```ts
// tests/smoke/workspace.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workspace contract', () => {
  it('targets the workspace extension host and VS Code 1.96+', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    expect(manifest.engines.vscode).toBe('^1.96.0');
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(manifest.main).toBe('./dist/extension.cjs');
  });
});
```

- [ ] **Step 2: 运行测试并确认因缺少工程而失败**

Run: `npm test -- --run tests/smoke/workspace.test.ts`

Expected: FAIL；若 `package.json` 尚不存在，先运行 `npm init -y` 后应因缺少 `vitest` 或 Manifest 字段失败。

- [ ] **Step 3: 安装固定到 lockfile 的基础依赖**

```bash
npm install --save-dev typescript esbuild vitest eslint @eslint/js typescript-eslint @types/node @types/vscode @vscode/test-electron @vscode/vsce
npm install ajv
npm pkg set name=git-workbench displayName="Git Workbench" publisher=git-workbench-project version=0.0.1 engines.vscode="^1.96.0" main="./dist/extension.cjs" type=module license=UNLICENSED
npm pkg set private=true --json
npm pkg set 'extensionKind[0]=workspace'
npm pkg set 'workspaces[0]=packages/*'
npm pkg set 'workspaces[1]=webview/*'
```

提交 `package-lock.json`；以后只使用 `npm ci`，不手改 lockfile。

- [ ] **Step 4: 写最小构建配置与入口**

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

```jsonc
// tsconfig.json
{
  "files": [],
  "references": [
    { "path": "packages/domain" },
    { "path": "packages/protocol" },
    { "path": "packages/config" },
    { "path": "packages/git-cli" },
    { "path": "packages/transactions" },
    { "path": "packages/testkit" },
    { "path": "tsconfig.extension.json" }
  ]
}
```

```jsonc
// tsconfig.extension.json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist-types",
    "types": ["node", "vscode"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

```js
// esbuild.mjs
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
});
```

```ts
// src/extension.ts
import type { ExtensionContext } from 'vscode';
import { activateExtension } from './extension/activate.js';

export function activate(context: ExtensionContext): Promise<void> {
  return activateExtension(context);
}

export function deactivate(): void {}
```

每个 `packages/<name>/package.json` 使用实际包名 `@git-workbench/<name>`、`type: "module"`、`main: "./dist/index.js"`、`types: "./dist/index.d.ts"`；每个包的 `tsconfig.json` 都 `extends ../../tsconfig.base.json`，设置 `composite/rootDir=src/outDir=dist`，并把直接依赖包加入 `references`。例如 Domain：

```json
{
  "name": "@git-workbench/domain",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
}
```

在首次运行 `tsc -b` 前执行下列固定脚本，创建全部六个内部包；列表、依赖和 project references 都显式写死，脚本不接受用户参数：

```js
// scripts/scaffold-workspaces.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packages = {
  domain: { dependencies: {}, references: [] },
  protocol: { dependencies: { ajv: root.dependencies.ajv }, references: [] },
  config: { dependencies: {}, references: [] },
  'git-cli': { dependencies: { '@git-workbench/domain': '0.0.1' }, references: ['domain'] },
  transactions: { dependencies: { '@git-workbench/domain': '0.0.1', '@git-workbench/git-cli': '0.0.1' }, references: ['domain', 'git-cli'] },
  testkit: { dependencies: { '@git-workbench/git-cli': '0.0.1' }, references: ['git-cli'] },
};

for (const [name, definition] of Object.entries(packages)) {
  const directory = new URL(`../packages/${name}/`, import.meta.url);
  await mkdir(new URL('src/', directory), { recursive: true });
  const manifest = {
    name: `@git-workbench/${name}`,
    version: '0.0.1',
    private: true,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: definition.dependencies,
  };
  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist' },
    include: ['src/**/*.ts'],
    references: definition.references.map((dependency) => ({ path: `../${dependency}` })),
  };
  await writeFile(new URL('package.json', directory), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(new URL('tsconfig.json', directory), `${JSON.stringify(tsconfig, null, 2)}\n`);
  await writeFile(new URL('src/index.ts', directory), 'export {};\n');
}
```

Run: `node scripts/scaffold-workspaces.mjs && npm install --package-lock-only`

Expected: 六个固定 Workspace 都能被 npm/TypeScript 解析，lockfile 记录内部包链接。

创建最小发布文档，避免 VSIX 打包时依赖尚未决定的开源许可证：

```md
<!-- README.md -->
# Git Workbench

Git Workbench 是一个面向 VS Code 的安全 Git 可视化工作台。当前版本为开发预览，支持范围以 CHANGELOG 和扩展内诊断页为准。
```

```md
<!-- CHANGELOG.md -->
# Change Log

## 0.0.1

- 建立跨平台 Extension Host、Settings 和系统 Git 基础工程。
```

```text
# .vscodeignore
.git/**
.github/**
.superpowers/**
docs/**
tests/**
packages/**
src/**
webview/**/src/**
webview/**/package.json
webview/**/tsconfig.json
scripts/**
config/**
coverage/**
dist-types/**
node_modules/**
package-lock.json
tsconfig*.json
esbuild.mjs
*.tsbuildinfo
*.vsix
```

在 `package.json` 设置以下 scripts：

```json
{
  "scripts": {
    "build": "node esbuild.mjs",
    "check": "npm run typecheck && npm run test:unit",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest",
    "test:unit": "vitest run tests packages src --exclude tests/integration/** --exclude tests/vscode/**",
    "test:integration": "vitest run tests/integration --pool=forks --maxWorkers=1",
    "build:vscode-tests": "tsc -p tests/vscode/tsconfig.json",
    "test:vscode": "npm run build:vscode-tests && node tests/vscode/out/run.js",
    "sync:settings": "node scripts/sync-settings.mjs",
    "package": "npm run sync:settings && npm run check && npm run build && vsce package --no-dependencies"
  }
}
```

- [ ] **Step 5: 运行测试、类型检查和构建**

Run: `npm run check && npm run build`

Expected: PASS；生成 `dist/extension.cjs`，且无 TypeScript 错误。

- [ ] **Step 6: 提交工程骨架**

```bash
git add package.json package-lock.json tsconfig.base.json tsconfig.json tsconfig.extension.json esbuild.mjs .vscodeignore README.md CHANGELOG.md scripts/scaffold-workspaces.mjs src/extension.ts packages tests/smoke/workspace.test.ts
git commit -m "chore: scaffold Git Workbench workspace"
```

### Task 2: 固定领域 ID、错误和仓库状态合同

**Files:**
- Modify: `packages/domain/package.json`
- Modify: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/ids.ts`
- Create: `packages/domain/src/errors.ts`
- Create: `packages/domain/src/repository.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/errors.test.ts`

- [ ] **Step 1: 写错误载荷失败测试**

```ts
// packages/domain/src/errors.test.ts
import { describe, expect, it } from 'vitest';
import { GitWorkbenchError, toPresentedError } from './errors.js';

describe('GitWorkbenchError', () => {
  it('keeps a stable code and never exposes raw command output', () => {
    const error = new GitWorkbenchError({
      code: 'STALE_PLAN',
      operationId: 'op-1',
      message: '预览已过期',
      repositoryChanged: true,
      retry: 'refresh',
    });
    expect(error.toJSON()).toEqual({
      code: 'STALE_PLAN',
      operationId: 'op-1',
      message: '预览已过期',
      repositoryChanged: true,
      retry: 'refresh',
    });
    expect(JSON.stringify(error)).not.toContain('stderr');
    expect(toPresentedError(error, 'diag-1').suggestedActions).toEqual(['refresh', 'openDiagnostics']);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/domain/src/errors.test.ts`

Expected: FAIL with `Cannot find module './errors.js'`。

- [ ] **Step 3: 实现稳定领域合同**

```ts
// packages/domain/src/ids.ts
declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
export type RepositoryId = Brand<string, 'RepositoryId'>;
export type CommonRepositoryId = Brand<string, 'CommonRepositoryId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type ObjectId = Brand<string, 'ObjectId'>;
export type RepoRelativePath = Brand<string, 'RepoRelativePath'>;

export const asRepositoryId = (value: string): RepositoryId => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError('invalid repository id');
  return value as RepositoryId;
};
export const asCommonRepositoryId = (value: string): CommonRepositoryId => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError('invalid common repository id');
  return value as CommonRepositoryId;
};
export const asOperationId = (value: string): OperationId => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError('invalid operation id');
  return value as OperationId;
};
export const asObjectId = (value: string): ObjectId => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new TypeError('invalid object id');
  return value as ObjectId;
};
export const asRepoRelativePath = (value: string): RepoRelativePath => {
  if (!value || value.includes('\0') || value.startsWith('/') || value.split('/').some((part) => part === '..')) throw new TypeError('invalid repository-relative path');
  return value as RepoRelativePath;
};
```

```ts
// packages/domain/src/errors.ts
export type GitWorkbenchErrorCode =
  | 'INVALID_INPUT'
  | 'STALE_PLAN'
  | 'REPOSITORY_LOCKED'
  | 'WORKSPACE_UNTRUSTED'
  | 'CONFLICT_PAUSED'
  | 'POSTCONDITION_FAILED'
  | 'AUTH_REQUIRED'
  | 'LEASE_REJECTED'
  | 'UNSUPPORTED_GIT_CAPABILITY'
  | 'PARSER_UNSUPPORTED'
  | 'MISSING_LOCAL_OBJECT'
  | 'UNSAFE_LINE_SELECTION'
  | 'TOO_LARGE'
  | 'CORRUPT_REPOSITORY'
  | 'CANCELLED';

export type RetryAdvice = 'none' | 'retry' | 'refresh' | 'reconcile' | 'authenticate';
export type SuggestedAction = 'retry' | 'refresh' | 'reconcile' | 'authenticate' | 'fetchMissingObjects' | 'openRecovery' | 'openDiagnostics';

export interface GitWorkbenchErrorPayload {
  readonly code: GitWorkbenchErrorCode;
  readonly operationId?: string;
  readonly message: string;
  readonly repositoryChanged: boolean;
  readonly retry: RetryAdvice;
}

export class GitWorkbenchError extends Error {
  constructor(readonly payload: GitWorkbenchErrorPayload) {
    super(payload.message);
    this.name = 'GitWorkbenchError';
  }

  toJSON(): GitWorkbenchErrorPayload {
    return { ...this.payload };
  }
}

export interface PresentedError extends GitWorkbenchErrorPayload {
  readonly diagnosticsId: string;
  readonly suggestedActions: readonly SuggestedAction[];
}

export function toPresentedError(error: GitWorkbenchError, diagnosticsId: string): PresentedError {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(diagnosticsId)) throw new TypeError('invalid diagnostics id');
  const primary: SuggestedAction[] = error.payload.code === 'MISSING_LOCAL_OBJECT'
    ? ['fetchMissingObjects']
    : error.payload.retry === 'retry' ? ['retry']
    : error.payload.retry === 'refresh' ? ['refresh']
    : error.payload.retry === 'reconcile' ? ['reconcile', 'openRecovery']
    : error.payload.retry === 'authenticate' ? ['authenticate']
    : [];
  return { ...error.toJSON(), diagnosticsId, suggestedActions: [...primary, 'openDiagnostics'] };
}
```

`GitWorkbenchError` 是不含 raw stderr 的内部合同；任何 Host→UI/IPC 边界都必须先由 Diagnostics Registry 分配随机短期 `diagnosticsId`，保存结构化脱敏记录，再调用 `toPresentedError`。协议不接受 Webview 自行构造 diagnostics ID 或 Suggested Action；每个动作仍回到原 Command/Query Bus 做 Trust、Capability 和 Plan 校验。

```ts
// packages/domain/src/repository.ts
import type { CommonRepositoryId, ObjectId, RepoRelativePath, RepositoryId } from './ids.js';

export type RepositoryMode = 'readWrite' | 'compatibilityReadOnly';
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored';

export interface RepositoryDescriptor {
  readonly id: RepositoryId;
  readonly commonRepositoryId: CommonRepositoryId;
  readonly worktreeUri: string;
  readonly commonDirUri: string;
  readonly mode: RepositoryMode;
  readonly objectFormat: 'sha1' | 'sha256';
}

export interface BranchState {
  readonly headName?: string;
  readonly headOid?: ObjectId;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface WorkingTreeChange {
  readonly path: RepoRelativePath;
  readonly originalPath?: RepoRelativePath;
  readonly index: ChangeKind | 'unchanged';
  readonly worktree: ChangeKind | 'unchanged';
  readonly submodule: boolean;
}

export interface RepositoryStatus {
  readonly branch: BranchState;
  readonly changes: readonly WorkingTreeChange[];
  readonly generation: number;
}
```

```ts
// packages/domain/src/index.ts
export * from './errors.js';
export * from './ids.js';
export * from './repository.js';
```

- [ ] **Step 4: 运行领域测试**

Run: `npx vitest run packages/domain/src`

Expected: PASS。

- [ ] **Step 5: 提交领域合同**

```bash
git add packages/domain
git commit -m "feat: define Git Workbench domain contracts"
```

### Task 3: 建立严格 IPC 信封和边界校验

**Files:**
- Modify: `packages/protocol/package.json`
- Modify: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/envelope.ts`
- Create: `packages/protocol/src/validate.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/validate.test.ts`

- [ ] **Step 1: 写拒绝任意 Git 参数的失败测试**

```ts
// packages/protocol/src/validate.test.ts
import { describe, expect, it } from 'vitest';
import { parseHostRequest } from './validate.js';

describe('parseHostRequest', () => {
  it('accepts typed queries and rejects arbitrary command payloads', () => {
    expect(parseHostRequest({ protocol: 1, requestId: 'r1', type: 'repository.status', repositoryId: 'repo1' }).ok).toBe(true);
    expect(parseHostRequest({ protocol: 1, requestId: 'r2', type: 'git.exec', args: ['reset', '--hard'] }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/protocol/src/validate.test.ts`

Expected: FAIL with missing `parseHostRequest`。

- [ ] **Step 3: 实现版本化信封和白名单 Schema**

```ts
// packages/protocol/src/envelope.ts
import type { PresentedError } from '@git-workbench/domain';

export interface RepositoryStatusRequest {
  readonly protocol: 1;
  readonly requestId: string;
  readonly type: 'repository.status';
  readonly repositoryId: string;
}

export interface RepositoryListRequest {
  readonly protocol: 1;
  readonly requestId: string;
  readonly type: 'repository.list';
}

export type HostRequest = RepositoryStatusRequest | RepositoryListRequest;

export type HostResponse<T = unknown> =
  | { readonly protocol: 1; readonly requestId: string; readonly ok: true; readonly data: T }
  | { readonly protocol: 1; readonly requestId: string; readonly ok: false; readonly error: PresentedError };
```

```ts
// packages/protocol/src/validate.ts
import Ajv from 'ajv';
import type { HostRequest } from './envelope.js';

const schema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type'],
      properties: {
        protocol: { const: 1 },
        requestId: { type: 'string', minLength: 1, maxLength: 128 },
        type: { const: 'repository.list' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId'],
      properties: {
        protocol: { const: 1 },
        requestId: { type: 'string', minLength: 1, maxLength: 128 },
        type: { const: 'repository.status' },
        repositoryId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  ],
} as const;

const validate = new Ajv({ allErrors: true }).compile(schema);

export type ParseResult = { readonly ok: true; readonly value: HostRequest } | { readonly ok: false; readonly message: string };

export function parseHostRequest(input: unknown): ParseResult {
  return validate(input)
    ? { ok: true, value: input as HostRequest }
    : { ok: false, message: validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join('; ') ?? 'invalid request' };
}
```

Host Response 也有生成式 JSON Schema/合同测试：错误分支必须是 `toPresentedError()` 产出的完整 DTO（稳定 code、Operation ID、仓库是否变化、retry、Host 生成的短期 diagnostics ID 和 allowlisted Suggested Actions），拒绝 `stderr/stack/cause/command/env` 等额外字段。Webview 只渲染这些字段，动作仍发新的领域 Intent，不能把 Suggested Action 当作任意命令名执行。

```ts
// packages/protocol/src/index.ts
export * from './envelope.js';
export * from './validate.js';
```

- [ ] **Step 4: 运行协议测试并提交**

Run: `npx vitest run packages/protocol/src`

Expected: PASS。

```bash
git add packages/protocol
git commit -m "feat: add typed extension protocol boundary"
```

### Task 4: 将 38 项 Settings 建成单一合同

**Files:**
- Create: `config/settings.schema.json`
- Create: `package.nls.json`
- Create: `package.nls.zh-cn.json`
- Create: `scripts/sync-settings.mjs`
- Modify: `packages/config/package.json`
- Modify: `packages/config/tsconfig.json`
- Create: `packages/config/src/settings.generated.ts`
- Create: `packages/config/src/settings.ts`
- Create: `packages/config/src/index.ts`
- Test: `tests/contract/settings.test.ts`

- [ ] **Step 1: 写 Manifest 漂移失败测试**

```ts
// tests/contract/settings.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS } from '../../packages/config/src/settings.generated.js';

interface LocalizedCopy { readonly en: string; readonly zhCN: string }
interface SettingDefinition extends Record<string, unknown> { readonly default: unknown; readonly descriptionKey: string; readonly descriptions: LocalizedCopy; readonly enumDescriptionKeys?: readonly string[]; readonly enumDescriptions?: readonly LocalizedCopy[] }

describe('settings contract', () => {
  it('keeps all 38 schema entries synchronized with the manifest', async () => {
    const source = JSON.parse(await readFile('config/settings.schema.json', 'utf8'));
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    const en = JSON.parse(await readFile('package.nls.json', 'utf8'));
    const zh = JSON.parse(await readFile('package.nls.zh-cn.json', 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    expect(Object.keys(source.properties)).toHaveLength(38);
    expect(Object.keys(SETTING_DEFAULTS)).toEqual(Object.keys(source.properties));
    for (const [key, value] of Object.entries(source.properties as Record<string, SettingDefinition>)) {
      const { descriptionKey, descriptions, enumDescriptionKeys, enumDescriptions, ...manifestShape } = value;
      expect(properties[key]).toEqual({
        ...manifestShape,
        markdownDescription: `%${descriptionKey}%`,
        ...(enumDescriptionKeys ? { markdownEnumDescriptions: enumDescriptionKeys.map((entry) => `%${entry}%`) } : {}),
      });
      expect(en[descriptionKey]).toBe(descriptions.en);
      expect(zh[descriptionKey]).toBe(descriptions.zhCN);
      for (let index = 0; index < (enumDescriptionKeys?.length ?? 0); index += 1) {
        expect(en[enumDescriptionKeys![index]!]).toBe(enumDescriptions![index]!.en);
        expect(zh[enumDescriptionKeys![index]!]).toBe(enumDescriptions![index]!.zhCN);
      }
      expect(SETTING_DEFAULTS[key as keyof typeof SETTING_DEFAULTS]).toEqual(value.default);
      expect(key.startsWith('gitWorkbench.')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行并确认因 Schema 不存在而失败**

Run: `npx vitest run tests/contract/settings.test.ts`

Expected: FAIL because `config/settings.schema.json` 或生成的 `settings.generated.ts` 尚不存在。

- [ ] **Step 3: 写完整 Settings Schema**

`config/settings.schema.json` 必须包含下列 38 个键；每项同时保存 `descriptions.en/zhCN`，枚举保存与 enum 等长的 `enumDescriptions`，它们是 VS Code Settings 文案的机器可读单一来源。`descriptionKey` 由同步脚本转换为 `%config.<key>%`，枚举项同时生成 `markdownEnumDescriptions`。数值范围直接转换为 `minimum`/`maximum`。

| Key | Type / constraints | Default | Scope |
|---|---|---:|---|
| `gitWorkbench.git.path` | string | `""` | `machine` |
| `gitWorkbench.repositories.autoDetect` | enum `openFolders/subFolders/off` | `openFolders` | `window` |
| `gitWorkbench.repositories.scanDepth` | integer 1–5 | `2` | `window` |
| `gitWorkbench.ui.followActiveRepository` | boolean | `true` | `window` |
| `gitWorkbench.ui.compactMode` | enum `auto/compact/comfortable` | `auto` | `window` |
| `gitWorkbench.graph.pageSize` | integer 50–1000 | `200` | `resource` |
| `gitWorkbench.graph.maxLanes` | integer 8–200 | `50` | `resource` |
| `gitWorkbench.graph.order` | enum `topo/date/authorDate` | `topo` | `resource` |
| `gitWorkbench.graph.showWorkingTree` | boolean | `true` | `resource` |
| `gitWorkbench.graph.showRemoteBranches` | boolean | `true` | `resource` |
| `gitWorkbench.graph.showTags` | boolean | `true` | `resource` |
| `gitWorkbench.graph.showStashes` | boolean | `true` | `resource` |
| `gitWorkbench.graph.showWorktrees` | boolean | `true` | `resource` |
| `gitWorkbench.compare.defaultMode` | enum `auto/direct/mergeBase` | `auto` | `resource` |
| `gitWorkbench.compare.ignoreWhitespace` | enum `none/eol/all` | `none` | `resource` |
| `gitWorkbench.compare.renameDetection` | enum `auto/on/off` | `auto` | `resource` |
| `gitWorkbench.compare.maxFileSizeMB` | integer 1–1024 | `10` | `machine` |
| `gitWorkbench.compare.maxDiffLines` | integer 1000–200000 | `20000` | `machine` |
| `gitWorkbench.apply.defaultTarget` | enum `prompt/worktree/index/newWorktree` | `prompt` | `resource` |
| `gitWorkbench.commit.smartCommit` | boolean | `false` | `resource` |
| `gitWorkbench.pull.strategy` | enum `inherit/prompt/ffOnly/merge/rebase` | `inherit` | `resource` |
| `gitWorkbench.fetch.prune` | enum `inherit/on/off` | `inherit` | `resource` |
| `gitWorkbench.remote.autoFetch` | boolean | `false` | `resource` |
| `gitWorkbench.remote.autoFetchIntervalMinutes` | integer 5–1440 | `10` | `resource` |
| `gitWorkbench.branch.dirtyWorktreeStrategy` | enum `prompt/keep/stash/newWorktree` | `prompt` | `resource` |
| `gitWorkbench.stash.includeUntracked` | boolean | `false` | `resource` |
| `gitWorkbench.conflict.autoOpen` | enum `prompt/first/never` | `prompt` | `resource` |
| `gitWorkbench.safety.mode` | enum `balanced/strict` | `balanced` | `resource` |
| `gitWorkbench.safety.protectedBranches` | array max 100; unique strings 1–128 chars | `["main","master","release/*"]` | `resource` |
| `gitWorkbench.safety.publishedRewrite` | enum `deny/confirm` | `confirm` | `resource` |
| `gitWorkbench.safety.checkpointRetentionDays` | integer 1–365 | `30` | `machine` |
| `gitWorkbench.safety.checkpointMaxCount` | integer 5–500 | `50` | `machine` |
| `gitWorkbench.safety.checkpointMaxDiskMB` | integer 256–102400 | `2048` | `machine` |
| `gitWorkbench.performance.profile` | enum `auto/balanced/largeRepository` | `auto` | `machine` |
| `gitWorkbench.performance.maxCacheMB` | integer 50–2048 | `150` | `machine` |
| `gitWorkbench.performance.maxConcurrentReads` | integer 1–8 | `4` | `machine` |
| `gitWorkbench.logging.level` | enum `off/error/warn/info/debug/trace` | `error` | `application` |
| `gitWorkbench.diagnostics.redactPaths` | boolean | `true` | `application` |

每项中文 `markdownDescription` 逐字采用已批准规格第 8 节，英文提供经复审的等义文本；枚举项的说明拆到 `%enum.<key>.<value>%`。不得缩写掉“只影响查看、不改变实际 Patch”“凭据始终删除”等安全语义。同步后 `package.nls.json/package.nls.zh-cn.json` 中的 Settings 键不再手工编辑，合同测试逐值比较而不只是检查非空。

运行时只允许 `vscodeConfig.ts` 读取 VS Code Configuration，并生成带 revision 的不可变 `ConfigSnapshot`；业务层不得散落 `getConfiguration()`。消费归属固定为：Foundation=`git.path/repositories.*`，Read Model=`ui.*/graph.*/compare.*/performance.*`，Daily Mutations=`commit.*/pull.*/fetch.*/remote.*/branch.*/stash.*`，Patch Transactions=`apply.*` 与三个 `safety.checkpoint*`，Paused Operations=`conflict.*`，History/GA=其余 `safety.*`、`logging.*`、`diagnostics.*`。跨阶段设置（Safety/Performance）由 ConfigSnapshot 同一版本共享，Patch/History 复用 Read Model 已计算的 Effective Performance Profile；执行中的 Plan 不热切换。

- [ ] **Step 4: 实现确定性同步脚本**

```js
// scripts/sync-settings.mjs
import { readFile, writeFile } from 'node:fs/promises';

const schemaPath = new URL('../config/settings.schema.json', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const generatedPath = new URL('../packages/config/src/settings.generated.ts', import.meta.url);
const enPath = new URL('../package.nls.json', import.meta.url);
const zhPath = new URL('../package.nls.zh-cn.json', import.meta.url);
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
const en = JSON.parse(await readFile(enPath, 'utf8'));
const zh = JSON.parse(await readFile(zhPath, 'utf8'));
for (const copy of [en, zh]) {
  for (const key of Object.keys(copy)) if (key.startsWith('config.gitWorkbench.') || key.startsWith('enum.gitWorkbench.')) delete copy[key];
}

const manifestProperties = Object.fromEntries(Object.entries(schema.properties).map(([key, definition]) => {
  const { descriptionKey, descriptions, enumDescriptionKeys, enumDescriptions, ...property } = definition;
  if (descriptionKey !== `config.${key}`) throw new Error(`invalid descriptionKey: ${key}`);
  if (!descriptions?.en?.trim() || !descriptions?.zhCN?.trim()) throw new Error(`missing descriptions: ${key}`);
  if (definition.enum && (!Array.isArray(enumDescriptionKeys) || enumDescriptionKeys.length !== definition.enum.length || !Array.isArray(enumDescriptions) || enumDescriptions.length !== definition.enum.length)) throw new Error(`invalid enum descriptions: ${key}`);
  en[descriptionKey] = descriptions.en;
  zh[descriptionKey] = descriptions.zhCN;
  enumDescriptionKeys?.forEach((entry, index) => {
    if (!enumDescriptions[index]?.en?.trim() || !enumDescriptions[index]?.zhCN?.trim()) throw new Error(`missing enum copy: ${key}:${index}`);
    en[entry] = enumDescriptions[index].en;
    zh[entry] = enumDescriptions[index].zhCN;
  });
  return [key, {
    ...property,
    markdownDescription: `%${descriptionKey}%`,
    ...(enumDescriptionKeys ? { markdownEnumDescriptions: enumDescriptionKeys.map((entry) => `%${entry}%`) } : {}),
  }];
}));

manifest.contributes ??= {};
manifest.contributes.configuration = {
  title: '%configuration.title%',
  properties: manifestProperties,
};
manifest.capabilities = {
  untrustedWorkspaces: {
    supported: 'limited',
    description: '%workspaceTrust.description%',
    restrictedConfigurations: [
      'gitWorkbench.repositories.autoDetect',
      'gitWorkbench.repositories.scanDepth',
      'gitWorkbench.safety.protectedBranches',
    ],
  },
};

const typeFor = (definition) => {
  if (Array.isArray(definition.enum)) return definition.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (definition.type === 'string') return 'string';
  if (definition.type === 'integer' || definition.type === 'number') return 'number';
  if (definition.type === 'boolean') return 'boolean';
  if (definition.type === 'array' && definition.items?.type === 'string') return 'readonly string[]';
  throw new Error(`unsupported setting type: ${JSON.stringify(definition)}`);
};
const defaults = Object.fromEntries(Object.entries(schema.properties).map(([key, definition]) => [key, definition.default]));
const fields = Object.entries(schema.properties).map(([key, definition]) => `  readonly ${JSON.stringify(key)}: ${typeFor(definition)};`).join('\n');
const generated = `// Generated by scripts/sync-settings.mjs. Do not edit.\nexport interface SettingsValues {\n${fields}\n}\n\nexport const SETTING_DEFAULTS = ${JSON.stringify(defaults, null, 2)} as const satisfies SettingsValues;\nexport type SettingKey = keyof SettingsValues;\n`;

await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(generatedPath, generated);
await writeFile(enPath, `${JSON.stringify(en, null, 2)}\n`);
await writeFile(zhPath, `${JSON.stringify(zh, null, 2)}\n`);
```

- [ ] **Step 5: 实现运行时默认值与安全合并**

```ts
// packages/config/src/settings.ts
import type { SettingsValues } from './settings.generated.js';

export interface ConfigSnapshot {
  readonly revision: string;
  readonly values: Readonly<SettingsValues>;
}

export type SafetyMode = 'balanced' | 'strict';
export type PublishedRewrite = 'deny' | 'confirm';

export interface SafetyLayers {
  readonly modes: readonly (SafetyMode | undefined)[];
  readonly publishedRewrite: readonly (PublishedRewrite | undefined)[];
  readonly protectedBranches: readonly (readonly string[] | undefined)[];
}

export interface EffectiveSafetySettings {
  readonly mode: SafetyMode;
  readonly publishedRewrite: PublishedRewrite;
  readonly protectedBranches: readonly string[];
}

const minimumProtectedBranches = ['main', 'master', 'release/*'] as const;

export function mergeSafetyLayers(layers: SafetyLayers): EffectiveSafetySettings {
  const mode = layers.modes.includes('strict') ? 'strict' : 'balanced';
  const publishedRewrite = mode === 'strict' || layers.publishedRewrite.includes('deny') ? 'deny' : 'confirm';
  const protectedBranches = [...new Set([...minimumProtectedBranches, ...layers.protectedBranches.flatMap((value) => value ?? [])])].sort();
  return { mode, publishedRewrite, protectedBranches };
}
```

同时为 `mergeSafetyLayers` 增加单元测试：Workspace 的 `balanced` 不能降低 Global 的 `strict`，Folder 的空数组不能移除 Global 保护分支，所有层显式空数组也不能移除 `main/master/release/*` 最低规则。
`packages/config/src/index.ts` 公开导出 `settings.generated.ts` 与 `settings.ts`；`vscodeConfig.ts` 必须遍历 `SettingKey`，对缺失值使用 `SETTING_DEFAULTS`，并对范围/枚举再次做运行时校验后生成 `ConfigSnapshot.revision`。

- [ ] **Step 6: 同步并运行合同测试**

Run: `npm run sync:settings && npx vitest run tests/contract/settings.test.ts packages/config/src`

Expected: PASS；`package.json` 恰好含 38 个 `gitWorkbench.*` 属性。

- [ ] **Step 7: 提交 Settings 合同**

```bash
git add config package.json package.nls.json package.nls.zh-cn.json scripts/sync-settings.mjs packages/config tests/contract/settings.test.ts
git commit -m "feat: define Git Workbench settings contract"
```

### Task 5: 实现安全、可取消、有限输出的 Git Process

**Files:**
- Modify: `packages/git-cli/package.json`
- Modify: `packages/git-cli/tsconfig.json`
- Create: `packages/git-cli/src/process.ts`
- Create: `packages/git-cli/src/ports.ts`
- Test: `packages/git-cli/src/process.test.ts`

- [ ] **Step 1: 写参数隔离与输出上限失败测试**

```ts
// packages/git-cli/src/process.test.ts
import { describe, expect, it } from 'vitest';
import { GitProcessRunner } from './process.js';

describe('GitProcessRunner', () => {
  it('passes arguments without a shell', async () => {
    const runner = new GitProcessRunner(process.execPath);
    const result = await runner.run({
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '$(touch injected)'],
      cwd: process.cwd(),
      kind: 'query',
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    });
    expect(JSON.parse(result.stdoutText())).toEqual(['$(touch injected)']);
  });

  it('fails closed when stdout exceeds the limit', async () => {
    const runner = new GitProcessRunner(process.execPath);
    await expect(runner.run({
      args: ['-e', 'process.stdout.write("x".repeat(2048))'],
      cwd: process.cwd(),
      kind: 'query',
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    })).rejects.toMatchObject({ payload: { code: 'TOO_LARGE' } });
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/process.test.ts`

Expected: FAIL with missing `GitProcessRunner`。

- [ ] **Step 3: 实现无 Shell Runner**

```ts
// packages/git-cli/src/process.ts
import { spawn } from 'node:child_process';
import { GitWorkbenchError } from '@git-workbench/domain';

export interface GitRunRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly kind: 'query' | 'mutation';
  readonly stdin?: Uint8Array;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly stdoutSink?: { push(chunk: Uint8Array): void; finish(): void };
  readonly env?: Readonly<GitControlledEnvironment>;
  readonly signal?: AbortSignal;
}

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

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  stdoutText(): string;
  stderrText(): string;
}

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'GPG_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number, limit: number): { readonly size: number; readonly truncated: boolean } {
  const remaining = Math.max(0, limit - current);
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return { size: current + Math.min(remaining, chunk.byteLength), truncated: chunk.byteLength > remaining };
}

export class GitProcessRunner {
  constructor(private readonly executable: string) {}

  run(request: GitRunRequest): Promise<GitRunResult> {
    if (request.kind === 'mutation' && request.stdoutSink) return Promise.reject(new TypeError('streaming sink is query-only'));
    if (request.kind === 'query' && request.signal?.aborted) return Promise.reject(new GitWorkbenchError({ code: 'CANCELLED', message: 'Git 查询已取消', repositoryChanged: false, retry: 'none' }));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--no-pager', ...request.args], {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...inheritedEnvironment(),
          ...request.env,
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: request.kind === 'query' ? '0' : '1',
          GIT_NO_LAZY_FETCH: request.kind === 'query' ? '1' : '0',
          GIT_TERMINAL_PROMPT: '0',
          ...(request.kind === 'query' ? { GIT_ALLOW_PROTOCOL: '' } : {}),
        },
        stdio: 'pipe',
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      const onAbort = (): void => {
        if (request.kind !== 'query') return;
        child.kill();
        fail(new GitWorkbenchError({ code: 'CANCELLED', message: 'Git 查询已取消', repositoryChanged: false, retry: 'none' }));
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        child.kill();
        reject(error);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (request.stdoutSink) {
          const remaining = Math.max(0, request.maxStdoutBytes - stdoutSize);
          try { if (remaining > 0) request.stdoutSink.push(chunk.subarray(0, remaining)); }
          catch (error) { fail(error); return; }
          stdoutSize += Math.min(remaining, chunk.byteLength);
          stdoutTruncated ||= chunk.byteLength > remaining;
        } else {
          const appended = appendBounded(stdout, chunk, stdoutSize, request.maxStdoutBytes);
          stdoutSize = appended.size;
          stdoutTruncated ||= appended.truncated;
        }
        if (stdoutTruncated && request.kind === 'query') fail(new GitWorkbenchError({ code: 'TOO_LARGE', message: 'Git 输出超过安全上限', repositoryChanged: false, retry: 'none' }));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const appended = appendBounded(stderr, chunk, stderrSize, request.maxStderrBytes);
        stderrSize = appended.size;
        stderrTruncated ||= appended.truncated;
        if (stderrTruncated && request.kind === 'query') fail(new GitWorkbenchError({ code: 'TOO_LARGE', message: 'Git 输出超过安全上限', repositoryChanged: false, retry: 'none' }));
      });
      child.on('error', fail);
      child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') fail(error); });
      child.on('close', (exitCode) => {
        if (settled) return;
        try { request.stdoutSink?.finish(); }
        catch (error) { fail(error); return; }
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        const out = Buffer.concat(stdout);
        const err = Buffer.concat(stderr);
        resolve({ exitCode: exitCode ?? -1, stdout: out, stderr: err, stdoutTruncated, stderrTruncated, stdoutText: () => out.toString('utf8'), stderrText: () => err.toString('utf8') });
      });
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.stdin) child.stdin.end(request.stdin); else child.stdin.end();
    });
  }
}
```

Extension Host 启动的 Git 永远不允许回退到隐藏终端提示，避免进程无期限等待，也避免认证输入与 Commit Message/Pathspec 共用 stdin。`request.env` 先合并，随后由 Runner 覆盖安全不变量，因此调用方不能把 `GIT_TERMINAL_PROMPT` 改回 `1`。所有 Query 额外设置空的 `GIT_ALLOW_PROTOCOL`，等价于拒绝全部 Git Transport；即使最低支持 Git 不认识 `GIT_NO_LAZY_FETCH` 且在对象预检后发生缺对象竞态，内部 Lazy Fetch 也只能失败，不能连接 HTTP/SSH/Git/File 或自定义 Remote Helper。用户主动的网络 Mutation 不带该 Query 隔离变量，由 Phase 2 注入一次性 `GIT_ASKPASS`/`SSH_ASKPASS` 桥并继续保持 `GIT_TERMINAL_PROMPT=0`；后台网络操作使用独立的强制非交互 Profile。Hooks/Signing 保持启用，但需要交互且没有可用系统 Helper/Agent/Pinentry 时返回 `AUTH_REQUIRED`，不能挂起或偷偷关闭验证。

Runner 无条件在 Git 全局选项位置注入 `--no-pager`。会触发 Commit/Sequence Editor 的 Use Case 只能注入 Extension 安装目录中的受控 Helper：它要么写入用户在 VS Code 已确认的文本，要么保留 Git 已生成内容并立即退出；不得继承 Workspace 提供的 editor 命令。该限制不关闭 Hooks/Signing，二者的失败仍按 Typed Error/Paused/Reconcile 处理。

Runner 测试必须让恶意调用方在 `request.env` 中尝试覆盖 `GIT_TERMINAL_PROMPT=1`，并在受控 child 中断言实际仍为 `0`；Partial Clone 集成测试为 HTTP、SSH、本地路径和伪造 Remote Helper 分别计数，证明 Query 的 Transport 调用均为 0。Mutation profile 测试则证明只有明确的 `userInitiatedNetwork/materializeMissingObjects` 能联网。

后续所有 Git Use Case 只依赖下列端口，禁止再次发明 `QueryGitProvider`/`MutationGitProvider` 签名：

```ts
// packages/git-cli/src/ports.ts
import type { GitRunResult } from './process.js';

export interface QueryGitProvider {
  readonly cwd: string;
  query(args: readonly string[], stdin?: Uint8Array, signal?: AbortSignal): Promise<GitRunResult>;
}

export interface MutationGitProvider extends QueryGitProvider {
  mutate(args: readonly string[], stdin?: Uint8Array, profile?: 'default' | 'userInitiatedNetwork' | 'materializeMissingObjects'): Promise<GitRunResult & { readonly outcome: 'known' | 'unknown'; readonly failureClass?: 'authCancelled' | 'offline' | 'timeout' | 'remoteRejected' }>;
  resolve(ref: string): Promise<string>;
}

export class GitCommandFailure extends Error {
  constructor(readonly exitCode: number, readonly stderr: Uint8Array) {
    super(`Git command failed with exit code ${exitCode}`);
    this.name = 'GitCommandFailure';
  }
}
```

Runner 不接收 Shell 字符串，也不继承任意 `GIT_*`/`NODE_OPTIONS` 环境变量；仅保留跨平台启动、系统配置、SSH Agent、GPG/AskPass 所需的明确变量。所有把仓库路径交给 Git pathspec parser 的 Provider 必须使用全局 `git --literal-pathspecs <command>`（批量路径优先 NUL `--pathspec-from-file=- --pathspec-file-nul`）；单独的 `--` 只能终止选项，不能关闭 `:(exclude)` 等 pathspec magic。Query 超限可以 Kill 并返回 `TOO_LARGE`；Mutation 超限只停止保留更多输出而继续 Drain，结果标记 `stdoutTruncated/stderrTruncated`，由 MutationCoordinator 按 Postcondition 对账，绝不因日志过大中断未知 Git 写入。Mutation 的取消策略在后续计划由状态机决定，Foundation 不允许直接 Kill Mutation。

生产实现支持互斥的“有界 capture”与同步 `stdoutSink`：存在 Sink 时 Runner 不保留 stdout chunks，只累计总输入 bytes，在 data 事件中把原始 chunk 交给增量 NUL/状态机 Parser，并在正常 EOF 调用 `finish()`；Sink 抛错按 Query 受控失败处理。总字节预算对两种模式同样生效，Sink 不能绕过 `maxStdoutBytes`。OID、Capability 等小输出使用 capture；Status、Refs、Untracked、Raw Diff 和大 Log 使用 Sink/分页。测试向 child 写入超过内存预算的百万条 NUL record，断言峰值内存有界、记录不截断、取消能解除所有 listener，且 Mutation 大 stderr 只保留明确标记截断的有界诊断片段并继续 Drain。

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run packages/git-cli/src/process.test.ts`

Expected: PASS，且仓库根目录不存在名为 `injected` 的文件。

```bash
git add packages/git-cli
git commit -m "feat: add bounded Git process runner"
```

### Task 6: 能力探测与只读降级

**Files:**
- Create: `packages/git-cli/src/capabilities.ts`
- Test: `packages/git-cli/src/capabilities.test.ts`

- [ ] **Step 1: 写能力决策失败测试**

```ts
// packages/git-cli/src/capabilities.test.ts
import { describe, expect, it } from 'vitest';
import { decideRepositoryMode } from './capabilities.js';

describe('decideRepositoryMode', () => {
  it('requires all write capabilities instead of trusting a version string', () => {
    expect(decideRepositoryMode({ supportedBaseline: true, porcelainV2: true, nulPaths: true, updateRefTransaction: true, explicitForceLease: true, noLazyFetch: true })).toBe('readWrite');
    expect(decideRepositoryMode({ supportedBaseline: true, porcelainV2: true, nulPaths: true, updateRefTransaction: false, explicitForceLease: true, noLazyFetch: true })).toBe('compatibilityReadOnly');
    expect(decideRepositoryMode({ supportedBaseline: false, porcelainV2: true, nulPaths: true, updateRefTransaction: true, explicitForceLease: true, noLazyFetch: false })).toBe('compatibilityReadOnly');
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/capabilities.test.ts`

Expected: FAIL with missing module。

- [ ] **Step 3: 实现显式 Capability Probe**

```ts
// packages/git-cli/src/capabilities.ts
import type { RepositoryMode } from '@git-workbench/domain';
import type { GitProcessRunner } from './process.js';

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

export function decideRepositoryMode(capabilities: Omit<GitCapabilities, 'version' | 'objectFormat'>): RepositoryMode {
  return capabilities.supportedBaseline && capabilities.porcelainV2 && capabilities.nulPaths && capabilities.updateRefTransaction && capabilities.explicitForceLease
    ? 'readWrite'
    : 'compatibilityReadOnly';
}

const atLeast2353 = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]!);
  const minor = Number(match[2]!);
  const patch = Number(match[3]!);
  return major > 2 || (major === 2 && (minor > 35 || (minor === 35 && patch >= 3)));
};

export async function probeGit(runner: GitProcessRunner, cwd: string, options: { readonly trusted: boolean }): Promise<GitCapabilities> {
  const version = await runner.run({ args: ['--version'], cwd, kind: 'query', maxStdoutBytes: 4096, maxStderrBytes: 4096 });
  const objectFormat = await runner.run({ args: ['rev-parse', '--show-object-format'], cwd, kind: 'query', maxStdoutBytes: 128, maxStderrBytes: 4096 });
  const noLazyFetch = await runner.run({ args: ['--no-lazy-fetch', '--version'], cwd, kind: 'query', maxStdoutBytes: 4096, maxStderrBytes: 4096 });
  const status = options.trusted
    ? await runner.run({ args: ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no'], cwd, kind: 'query', maxStdoutBytes: 1024 * 1024, maxStderrBytes: 4096 })
    : undefined;
  const updateRef = options.trusted
    ? await runner.run({ args: ['update-ref', '--stdin'], cwd, kind: 'query', stdin: Buffer.from('start\nabort\n'), maxStdoutBytes: 4096, maxStderrBytes: 4096 })
    : undefined;
  const porcelainV2 = status?.exitCode === 0;
  const parsedVersion = version.stdoutText().trim().replace(/^git version\s+/, '');
  return {
    version: parsedVersion,
    objectFormat: objectFormat.stdoutText().trim() === 'sha256' ? 'sha256' : 'sha1',
    porcelainV2,
    nulPaths: porcelainV2,
    updateRefTransaction: updateRef?.exitCode === 0,
    explicitForceLease: true,
    noLazyFetch: noLazyFetch.exitCode === 0,
    supportedBaseline: atLeast2353(parsedVersion),
  };
}
```

`explicitForceLease` 是正式支持基线内的固定命令能力；Phase 2 仍必须用临时 bare remote 验证服务端行为。版本 parser 接受 Apple/Git-for-Windows 等后缀但拒绝无法解析的字符串；版本只决定“正式支持基线”，具体功能仍由独立命令探测决定。`noLazyFetch` 不参与写能力判定，而是决定 Partial Clone 只读查询走原生禁止 Lazy Fetch，还是走 Phase 1 定义的旧版对象完整性预检；不能因为该能力缺失而静默放宽“查询不联网”约束。

`options.trusted=false` 时禁止运行 `status` 和 `update-ref` Probe，只探测版本、对象格式和进程级 no-lazy-fetch，Repository 保持 `compatibilityReadOnly`。Workspace 获得信任后重新 Probe 并重建 Descriptor；失去信任则立即撤销 Mutation/Status capability、取消相关后台任务并降回受限 DTO。Trust E2E 的 Git Spy 必须覆盖激活阶段，不能只检查 UI 命令。

- [ ] **Step 4: 运行单元与本机 Git 集成测试**

Run: `npx vitest run packages/git-cli/src/capabilities.test.ts && git --version`

Expected: 单元测试 PASS；本机 Git 版本被记录到 CI 日志。

- [ ] **Step 5: 提交能力探测**

```bash
git add packages/git-cli/src/capabilities.ts packages/git-cli/src/capabilities.test.ts
git commit -m "feat: probe Git capabilities safely"
```

### Task 7: 流式解析 Porcelain v2 NUL 状态

**Files:**
- Create: `packages/git-cli/src/status.ts`
- Create: `packages/git-cli/testdata/status-v2.bin`
- Test: `packages/git-cli/src/status.test.ts`

- [ ] **Step 1: 写中文、换行文件名与 rename 失败测试**

```ts
// packages/git-cli/src/status.test.ts
import { describe, expect, it } from 'vitest';
import { parseStatusV2 } from './status.js';

describe('parseStatusV2', () => {
  it('parses NUL-delimited paths without C-style guessing', () => {
    const oid = 'a'.repeat(40);
    const input = Buffer.from([`# branch.oid ${oid}`, '# branch.head main', `1 .M N... 100644 100644 100644 ${oid} ${oid} src/中文.ts`, `2 R. N... 100644 100644 100644 ${oid} ${'b'.repeat(40)} R100 new\nname.ts`, 'old name.ts', '? untracked file', ''].join('\0'));
    const status = parseStatusV2(input, 7);
    expect(status.branch.headName).toBe('main');
    expect(status.changes.map((change) => String(change.path))).toEqual(['src/中文.ts', 'new\nname.ts', 'untracked file']);
    expect(String(status.changes[1]?.originalPath)).toBe('old name.ts');
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/status.test.ts`

Expected: FAIL with missing parser。

- [ ] **Step 3: 实现严格记录解析器**

```ts
// packages/git-cli/src/status.ts
import { asObjectId, asRepoRelativePath, type ChangeKind, type RepositoryStatus, type WorkingTreeChange } from '@git-workbench/domain';

const statusKinds: Readonly<Record<string, ChangeKind | 'unchanged'>> = {
  '.': 'unchanged', M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', '?': 'untracked', '!': 'ignored',
};
const kind = (code: string): ChangeKind | 'unchanged' => {
  const value = statusKinds[code];
  if (!value) throw new Error(`unsupported status code: ${code}`);
  return value;
};

export function parseStatusV2(bytes: Uint8Array, generation: number): RepositoryStatus {
  const records = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
  const changes: WorkingTreeChange[] = [];
  let headName: string | undefined;
  let headOid: ReturnType<typeof asObjectId> | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      if (oid === '(initial)') headOid = undefined;
      else if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) headOid = asObjectId(oid);
      else throw new Error('invalid branch oid');
    }
    else if (record.startsWith('# branch.head ')) headName = record.slice(14) === '(detached)' ? undefined : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      changes.push({ path: asRepoRelativePath(fields.slice(8).join(' ')), index: kind(fields[1]?.[0] ?? '.'), worktree: kind(fields[1]?.[1] ?? '.'), submodule: fields[2] !== 'N...' });
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      const originalPath = records[index + 1];
      if (originalPath === undefined) throw new Error('rename record missing original path');
      index += 1;
      changes.push({ path: asRepoRelativePath(fields.slice(9).join(' ')), originalPath: asRepoRelativePath(originalPath), index: kind(fields[1]?.[0] ?? '.'), worktree: kind(fields[1]?.[1] ?? '.'), submodule: fields[2] !== 'N...' });
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ');
      changes.push({ path: asRepoRelativePath(fields.slice(10).join(' ')), index: 'unmerged', worktree: 'unmerged', submodule: fields[2] !== 'N...' });
    } else if (record.startsWith('? ') || record.startsWith('! ')) {
      const code = record[0] ?? '?';
      changes.push({ path: asRepoRelativePath(record.slice(2)), index: 'unchanged', worktree: kind(code), submodule: false });
    }
  }
  return { branch: { ...(headName === undefined ? {} : { headName }), ...(headOid === undefined ? {} : { headOid }), ...(upstream === undefined ? {} : { upstream }), ahead, behind }, changes, generation };
}
```

生产实现以 `StatusV2Decoder.push()/finish()` 增量处理跨 chunk 的 NUL records；上述 `parseStatusV2(bytes)` 只是单元测试便利包装。它必须把未知普通记录作为兼容诊断保留；未知关键 header 或 EOF 截断 rename 记录返回 `PARSER_UNSUPPORTED`，不能猜测。

- [ ] **Step 4: 运行解析器测试与 Fuzz smoke**

Run: `npx vitest run packages/git-cli/src/status.test.ts --coverage=false`

Expected: PASS；随机截断 `status-v2.bin` 不造成进程崩溃，只返回受控错误。

- [ ] **Step 5: 提交状态解析器**

```bash
git add packages/git-cli/src/status.ts packages/git-cli/src/status.test.ts packages/git-cli/testdata/status-v2.bin
git commit -m "feat: parse Git porcelain v2 status"
```

### Task 8: 仓库定位、注册表与懒激活

**Files:**
- Create: `packages/git-cli/src/locator.ts`
- Create: `packages/git-cli/src/index.ts`
- Create: `src/extension/repositoryDiscovery.ts`
- Create: `src/extension/repositoryRegistry.ts`
- Create: `src/extension/vscodeConfig.ts`
- Create: `src/extension/activate.ts`
- Test: `tests/integration/repository.test.ts`
- Test: `tests/integration/repository-discovery.test.ts`

- [ ] **Step 1: 写普通仓库和 Worktree 发现失败测试**

```ts
// tests/integration/repository.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositoryFixture } from '../../packages/testkit/src/repository.js';
import { locateRepository } from '../../packages/git-cli/src/locator.js';

describe('repository locator', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

  it('gives linked worktrees distinct IDs and a shared common dir', async () => {
    const fixture = await createRepositoryFixture();
    disposers.push(fixture.dispose);
    await fixture.write('README.md', 'initial\n');
    await fixture.commitAll('initial');
    const linked = await fixture.addWorktree('topic');
    const main = await locateRepository(fixture.path, fixture.runner, { trusted: true });
    const topic = await locateRepository(linked, fixture.runner, { trusted: true });
    expect(main.commonDirUri).toBe(topic.commonDirUri);
    expect(main.commonRepositoryId).toBe(topic.commonRepositoryId);
    expect(main.id).not.toBe(topic.id);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/repository.test.ts`

Expected: FAIL with missing fixture/locator。

- [ ] **Step 3: 实现基于 Git 命令的 Locator**

```ts
// packages/git-cli/src/locator.ts
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { asCommonRepositoryId, asRepositoryId, type RepositoryDescriptor } from '@git-workbench/domain';
import { decideRepositoryMode, probeGit } from './capabilities.js';
import type { GitProcessRunner } from './process.js';

async function revParse(runner: GitProcessRunner, cwd: string, flag: string): Promise<string> {
  const result = await runner.run({ args: ['rev-parse', '--path-format=absolute', flag], cwd, kind: 'query', maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(`not a repository: ${cwd}`);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  if (!decoded.endsWith('\n')) throw new Error('unterminated repository path');
  const terminatorBytes = process.platform === 'win32' && decoded.endsWith('\r\n') ? 2 : 1;
  return realpath(decoded.slice(0, -terminatorBytes));
}

export async function locateRepository(candidate: string, runner: GitProcessRunner, options: { readonly trusted: boolean }): Promise<RepositoryDescriptor> {
  const worktree = await revParse(runner, candidate, '--show-toplevel');
  const commonDir = await revParse(runner, candidate, '--git-common-dir');
  const capabilities = await probeGit(runner, worktree, options);
  const id = createHash('sha256').update(`${commonDir}\0${worktree}`).digest('hex');
  const commonRepositoryId = createHash('sha256').update(commonDir).digest('hex');
  return {
    id: asRepositoryId(id),
    commonRepositoryId: asCommonRepositoryId(commonRepositoryId),
    worktreeUri: pathToFileURL(worktree).toString(),
    commonDirUri: pathToFileURL(commonDir).toString(),
    mode: decideRepositoryMode(capabilities),
    objectFormat: capabilities.objectFormat,
  };
}
```

`RepositoryDescriptor.id` 绑定具体 Worktree，供 UI、Index、Working Tree generation 与 Cache 使用；`commonRepositoryId` 只绑定 canonical Common Git Dir，供写队列、共享 Ref/Object generation 与 Linked Worktree 失效广播使用。注册表必须建立 common→worktrees 索引；任何 Fetch/Commit/Branch/History 等共享状态变化都通知同组全部 Worktree，不能只刷新发起命令的 View。

- [ ] **Step 4: 实现去重注册表与配置适配**

```ts
// src/extension/repositoryRegistry.ts
import type { CommonRepositoryId, RepositoryDescriptor, RepositoryId } from '@git-workbench/domain';

export class RepositoryRegistry {
  private readonly repositories = new Map<RepositoryId, RepositoryDescriptor>();
  private readonly byCommon = new Map<CommonRepositoryId, RepositoryId[]>();

  replace(discovered: readonly RepositoryDescriptor[]): void {
    this.repositories.clear();
    this.byCommon.clear();
    for (const repository of discovered) {
      this.repositories.set(repository.id, repository);
      const members = this.byCommon.get(repository.commonRepositoryId) ?? [];
      members.push(repository.id);
      this.byCommon.set(repository.commonRepositoryId, members);
    }
  }

  list(): readonly RepositoryDescriptor[] {
    return [...this.repositories.values()].sort((a, b) => a.worktreeUri.localeCompare(b.worktreeUri));
  }

  get(id: RepositoryId): RepositoryDescriptor | undefined {
    return this.repositories.get(id);
  }

  worktreesForCommon(id: CommonRepositoryId): readonly RepositoryDescriptor[] {
    return (this.byCommon.get(id) ?? []).map((repositoryId) => this.repositories.get(repositoryId)).filter((value): value is RepositoryDescriptor => value !== undefined);
  }
}
```

`vscodeConfig.ts` 使用 `WorkspaceConfiguration.inspect()` 读取 Global/Workspace/Folder 层并调用 `mergeSafetyLayers`；未信任工作区只使用 Global 值。

`repositoryDiscovery.ts` 按 Setting 执行确定性策略：`openFolders` 只对每个 Workspace Folder 调用 Locator；`subFolders` 从各 Folder 做不跟随 Symlink/Junction 的 BFS，深度严格受 `scanDepth` 限制，只把含 `.git` 文件/目录的父目录交给 Locator；`off` 不自动扫描，仅保留“添加仓库”显式入口。每轮有 10,000 目录/2 秒软预算，超限返回可见的 Partial 诊断和“缩小范围/手动添加”，不继续扫磁盘。跳过 `.git` 内容本身，按 canonical Worktree ID 去重；Workspace Folder 变更 250 ms debounce 后增量重跑，绝不从文件系统根或父目录向外扩散。集成测试覆盖嵌套仓库、Worktree `.git` 文件、深度边界、Symlink cycle、权限错误和预算降级。

- [ ] **Step 5: 组合懒激活入口**

```ts
// src/extension/activate.ts
import * as vscode from 'vscode';
import { GitProcessRunner } from '@git-workbench/git-cli';
import { RepositoryRegistry } from './repositoryRegistry.js';
import { createVscodeConfigSnapshot } from './vscodeConfig.js';

export async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  const registry = new RepositoryRegistry();
  const output = vscode.window.createOutputChannel('Git Workbench', { log: true });
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('gitWorkbench.open', async () => {
    const configuration = createVscodeConfigSnapshot(vscode.workspace.isTrusted);
    const runner = new GitProcessRunner(configuration.gitPath);
    output.info(`Git Workbench activated in ${vscode.env.remoteName ?? 'local'} extension host`);
    void runner;
    void registry;
    await vscode.window.showInformationMessage('Git Workbench Foundation 已激活');
  }));
}
```

Manifest 只贡献 `gitWorkbench.open` 命令；不得使用启动即遍历整个磁盘的 activation event。

- [ ] **Step 6: 运行集成测试和构建并提交**

Run: `npm run test:integration -- tests/integration/repository.test.ts tests/integration/repository-discovery.test.ts && npm run typecheck && npm run build`

Expected: PASS。

```bash
git add packages/git-cli/src/locator.ts packages/git-cli/src/index.ts packages/testkit src/extension tests/integration/repository.test.ts tests/integration/repository-discovery.test.ts package.json package.nls.json package.nls.zh-cn.json
git commit -m "feat: discover and register Git repositories"
```

### Task 9: 建立真实 Git Testkit

**Files:**
- Modify: `packages/testkit/package.json`
- Modify: `packages/testkit/tsconfig.json`
- Create: `packages/testkit/src/repository.ts`
- Test: `packages/testkit/src/repository.test.ts`

- [ ] **Step 1: 写隔离与特殊文件名失败测试**

```ts
// packages/testkit/src/repository.test.ts
import { describe, expect, it } from 'vitest';
import { createRepositoryFixture } from './repository.js';

describe('repository fixture', () => {
  it('creates commits without reading user Git configuration', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('中文 空格\n文件.txt', '内容\n');
      const oid = await fixture.commitAll('初始提交');
      expect(oid).toMatch(/^[0-9a-f]{40,64}$/);
    } finally {
      await fixture.dispose();
    }
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/testkit/src/repository.test.ts`

Expected: FAIL with missing fixture。

- [ ] **Step 3: 实现完全隔离的临时仓库**

```ts
// packages/testkit/src/repository.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GitProcessRunner } from '@git-workbench/git-cli';

export interface RepositoryFixture {
  readonly path: string;
  readonly runner: GitProcessRunner;
  write(path: string, content: string | Uint8Array): Promise<void>;
  commitAll(message: string): Promise<string>;
  addWorktree(branch: string): Promise<string>;
  dispose(): Promise<void>;
}

export async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const path = await mkdtemp(join(tmpdir(), 'git-workbench-test-'));
  const runner = new GitProcessRunner('git');
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } as const;
  const run = async (args: string[]) => runner.run({ args, cwd: path, kind: 'mutation', maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024, env });
  const mustRun = async (args: string[]) => {
    const result = await run(args);
    if (result.exitCode !== 0) throw new Error(`fixture Git failed (${result.exitCode}): ${result.stderrText()}`);
    return result;
  };
  await mustRun(['init', '--initial-branch=main']);
  await mustRun(['config', 'user.name', 'Git Workbench Test']);
  await mustRun(['config', 'user.email', 'git-workbench@example.invalid']);
  const linkedPaths: string[] = [];
  return {
    path,
    runner,
    async write(relativePath, content) {
      const target = join(path, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async commitAll(message) {
      await mustRun(['add', '--all']);
      await mustRun(['commit', '-m', message, '--no-gpg-sign']);
      const result = await mustRun(['rev-parse', 'HEAD']);
      return result.stdoutText().trim();
    },
    async addWorktree(branch) {
      const target = `${path}-${branch}`;
      await mustRun(['worktree', 'add', '-b', branch, target]);
      linkedPaths.push(target);
      return target;
    },
    async dispose() {
      for (const linked of linkedPaths.reverse()) await rm(linked, { recursive: true, force: true });
      await rm(path, { recursive: true, force: true });
    },
  };
}
```

Testkit 可以在测试中使用 `--no-gpg-sign`，生产 Commit 流程不得复制该参数。

- [ ] **Step 4: 运行 Testkit 与 Locator 测试并提交**

Run: `npx vitest run packages/testkit/src tests/integration/repository.test.ts --pool=forks --maxWorkers=1`

Expected: PASS on macOS、Windows、Linux。

```bash
git add packages/testkit tests/integration/repository.test.ts
git commit -m "test: add isolated Git repository fixtures"
```

### Task 10: VS Code Trust 测试、三平台 CI 与 VSIX 检查

**Files:**
- Create: `tests/vscode/run.ts`
- Create: `tests/vscode/package.json`
- Create: `tests/vscode/tsconfig.json`
- Create: `tests/vscode/suite/index.ts`
- Create: `tests/vscode/suite/activation.test.ts`
- Create: `tests/vscode/suite/workspaceTrust.test.ts`
- Create: `tests/vscode/fixtures/trusted-workspace/README.md`
- Create: `tests/vscode/fixtures/untrusted-workspace/README.md`
- Create: `tests/contract/workflows.test.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.vscodeignore`

- [ ] **Step 1: 写 Extension Host 激活测试**

```ts
// tests/vscode/suite/activation.test.ts
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Git Workbench activation', () => {
  test('registers the open command without eager network activity', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gitWorkbench.open'));
  });
});
```

- [ ] **Step 2: 运行并确认测试入口尚未存在**

Run: `npm run test:vscode`

Expected: FAIL because `tests/vscode/out/run.js` 尚未生成。

- [ ] **Step 3: 实现 `@vscode/test-electron` Runner**

```ts
// tests/vscode/run.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

async function runCase(name: string, workspace: string, expectedTrust: boolean, grep?: string): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), `git-workbench-vscode-${name}-`));
  try {
    await runTests({
      extensionDevelopmentPath: resolve('.'),
      extensionTestsPath: resolve('tests/vscode/out/suite/index.js'),
      launchArgs: ['--disable-extensions', '--user-data-dir', userData, ...(expectedTrust ? ['--disable-workspace-trust'] : []), resolve(workspace)],
      extensionTestsEnv: { GIT_WORKBENCH_EXPECTED_TRUST: String(expectedTrust), ...(grep ? { GIT_WORKBENCH_TEST_GREP: grep } : {}) },
    });
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const grepIndex = process.argv.indexOf('--grep');
  const grep = grepIndex >= 0 ? process.argv[grepIndex + 1] : undefined;
  if (grepIndex >= 0 && !grep) throw new Error('--grep requires a value');
  await runCase('trusted', 'tests/vscode/fixtures/trusted-workspace', true, grep);
  await runCase('untrusted', 'tests/vscode/fixtures/untrusted-workspace', false, 'Workspace Trust');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

```json
// tests/vscode/package.json
{ "private": true, "type": "commonjs" }
```

```jsonc
// tests/vscode/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "rootDir": ".",
    "outDir": "out",
    "types": ["node", "vscode", "mocha"],
    "esModuleInterop": true,
    "verbatimModuleSyntax": false
  },
  "include": ["run.ts", "suite/**/*.ts"]
}
```

```ts
// tests/vscode/suite/index.ts
import { resolve } from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000, ...(process.env.GIT_WORKBENCH_TEST_GREP ? { grep: process.env.GIT_WORKBENCH_TEST_GREP } : {}) });
  const root = resolve(__dirname);
  for (const file of await glob('**/*.test.js', { cwd: root })) mocha.addFile(resolve(root, file));
  await new Promise<void>((resolveRun, reject) => mocha.run((failures) => failures ? reject(new Error(`${failures} VS Code tests failed`)) : resolveRun()));
}
```

Run: `npm install --save-dev mocha glob @types/mocha`

`workspaceTrust.test.ts` 断言两次独立 Extension Host 中的 `vscode.workspace.isTrusted` 与 `GIT_WORKBENCH_EXPECTED_TRUST` 一致；Untrusted Run 证明写/网络命令即使通过 `executeCommand` 直接调用也被 Host 拒绝，且 Workspace 值不能改 Git path/发现/最低 Safety。Git Process Spy 还断言 Untrusted 不运行 `status`、涉及 Index/Working Tree 的 `diff`、`check-ignore`、Untracked 扫描或任何 Filter/Hook/FSMonitor；只允许固定白名单的 `rev-parse/for-each-ref/log/cat-file/diff <oid> <oid>`，Partial Clone 缺对象时停止。Manifest 合同同时验证 `capabilities.untrustedWorkspaces=limited` 与 `restrictedConfigurations`。使用独立 `--user-data-dir` 防止历史信任决策污染测试，符合 [VS Code 官方 Workspace Trust 测试建议](https://code.visualstudio.com/api/working-with-extensions/testing-extension#testing-workspace-trust-behavior)。

- [ ] **Step 4: 写三平台 CI**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
  pull_request:
jobs:
  verify:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15, windows-2022]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run sync:settings
      - run: git diff --exit-code -- package.json packages/config/src/settings.generated.ts
      - run: npm run check
      - run: npm run test:integration
      - run: npm run build
      - run: xvfb-run -a npm run test:vscode
        if: runner.os == 'Linux'
      - run: npm run test:vscode
        if: runner.os != 'Linux'
      - run: npm run package
      - uses: actions/upload-artifact@v4
        if: matrix.os == 'ubuntu-24.04'
        with:
          name: git-workbench-vsix
          path: '*.vsix'
```

上面 YAML 为可读示意；提交到仓库时所有第三方/官方 Action 都固定到已核验的完整 40 位 Commit SHA，并用行尾注释保留版本名。合同测试拒绝 `uses: ...@v*|@main`，Dependabot 只通过审查 PR 更新 SHA，防止 tag 漂移供应链攻击。

CI 工具链使用仍受支持的 Node 24；`esbuild target=node20` 只表示 VS Code 1.96 Extension Host 的最低运行时语法合同。`@vscode/test-electron` 必须分别下载/运行最低版 1.96、当前 Stable 与 Insiders，不能用 CI 自身 Node 24 替代最低 Extension Host 兼容测试。

- [ ] **Step 5: 检查 VSIX 内容**

Run: `npm run package && npx vsce ls`

Expected: VSIX 只含 `dist/extension.cjs`、Source Map、Manifest、NLS、README、CHANGELOG；Manifest 明确为 `UNLICENSED`，不伪造尚未决定的许可证；包内不含测试仓库、恢复快照、`.git`、工作目录或未声明二进制。

- [ ] **Step 6: 运行 Phase 0 全量门槛**

Run: `npm ci && npm run sync:settings && git diff --exit-code -- package.json && npm run check && npm run test:integration && npm run build && npm run package`

Expected: 全部 exit 0；38 项 Settings 合同通过；三平台 CI 绿色。

- [ ] **Step 7: 提交 Phase 0 收尾**

```bash
git add .github .vscodeignore package.json package-lock.json tests/vscode tests/contract/workflows.test.ts
git commit -m "ci: verify Git Workbench foundation on three platforms"
```

## Phase 0 验收记录

执行者在进入 Read Model 计划前，把下列实测值写入 PR 描述，不写入源码：

- macOS、Windows、Linux 的 Git/Node/VS Code 版本。
- 普通仓库、Linked Worktree、中文及换行文件名测试结果。
- 38 项 Settings 合同测试结果。
- VSIX 文件列表与大小。
- 所有失败测试的修复提交；不得通过跳过测试进入下一阶段。
