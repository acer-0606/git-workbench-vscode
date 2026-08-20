# Git Workbench Paused Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Merge、Rebase、Cherry-pick、Revert、Pull 与 Stash Apply 的冲突统一为可检测、可继续、可跳过、可中止、可崩溃恢复的 PausedOperation 工作流。

**Architecture:** Git 实际状态始终是权威；每次刷新通过 `rev-parse --git-path` 与 `ls-files --unmerged -z` 重建 PausedOperation，不依赖 UI 缓存。文本冲突优先调用可用的 VS Code Merge Editor，特殊冲突使用专用决策器；Continue/Skip/Abort 仍通过 MutationCoordinator 和原 Operation Journal。

**Tech Stack:** 前四阶段技术栈、Git sequencer commands、VS Code TextDocument/Merge Editor commands、VirtualDocumentProvider、Webview/Native conflict views、真实冲突 fixtures

---

**Authoritative spec:** `docs/superpowers/specs/2026-08-20-git-workbench-vscode-extension-design.md`

## 前置条件与阶段出口

- Patch Transaction 的 Checkpoint、Journal、Reconcile 和 Recovery Center 已通过强杀测试。
- 所有 Paused 状态都能在关闭并重开 VS Code 后重建。
- Continue 前无未合并 Index stages；Skip 只对 Git 支持的操作显示；Abort 后验证实际状态。
- Stash Apply 冲突不删除 Stash；Binary/Delete-Modify/Submodule 均有明确交互。
- Merge Editor 命令不可用时降级为打开冲突文件和三份只读内容，不阻塞恢复。

## 文件结构

```text
packages/domain/src/pausedOperation.ts           暂停状态与动作矩阵
packages/domain/src/conflict.ts                  Conflict 类型与 Stage 模型
packages/git-cli/src/pausedOperation.ts          Git 状态探测
packages/git-cli/src/conflicts.ts                ls-files -u -z 解析、内容读取
packages/git-cli/src/sequencer.ts                Continue/Skip/Abort Provider
packages/transactions/src/pausedCoordinator.ts   原 Journal 续接
src/extension/conflicts/conflictService.ts       检测、选择、解决
src/extension/conflicts/mergeEditorAdapter.ts    原生 Merge Editor 可选适配
src/extension/conflicts/conflictView.ts          Native Tree View
webview/workbench/src/conflicts/banner.tsx       固定状态横幅
webview/workbench/src/conflicts/special.tsx      Binary/Delete/Submodule UI
tests/integration/conflicts/*.test.ts             操作矩阵
tests/integration/conflicts/support/index.ts      七类真实冲突夹具
tests/e2e/conflict-workflow.test.ts               重启/继续/中止 E2E
```

### Task 1: 定义 PausedOperation 与 Conflict 合同

**Files:**
- Create: `packages/domain/src/pausedOperation.ts`
- Create: `packages/domain/src/conflict.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/validate.ts`
- Test: `packages/domain/src/pausedOperation.test.ts`

- [ ] **Step 1: 写动作矩阵失败测试**

```ts
// packages/domain/src/pausedOperation.test.ts
import { expect, it } from 'vitest';
import { allowedPausedActions } from './pausedOperation.js';

it('offers only actions supported by the active operation', () => {
  const capabilities = { revertSkip: true };
  expect(allowedPausedActions('rebase', capabilities)).toEqual(['continue', 'skip', 'abort']);
  expect(allowedPausedActions('merge', capabilities)).toEqual(['continue', 'abort']);
  expect(allowedPausedActions('stashApply', capabilities)).toEqual(['markResolved', 'abortToCheckpoint']);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/domain/src/pausedOperation.test.ts`

Expected: FAIL with missing contracts。

- [ ] **Step 3: 实现状态和动作模型**

```ts
// packages/domain/src/pausedOperation.ts
export type PausedOperationKind = 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply';
export type PausedAction = 'continue' | 'skip' | 'abort' | 'markResolved' | 'abortToCheckpoint';

const actions: Readonly<Record<PausedOperationKind, readonly PausedAction[]>> = {
  merge: ['continue', 'abort'],
  rebase: ['continue', 'skip', 'abort'],
  cherryPick: ['continue', 'skip', 'abort'],
  revert: ['continue', 'skip', 'abort'],
  pullMerge: ['continue', 'abort'],
  pullRebase: ['continue', 'skip', 'abort'],
  stashApply: ['markResolved', 'abortToCheckpoint'],
};

export interface PausedCapabilities { readonly revertSkip: boolean }
export const allowedPausedActions = (kind: PausedOperationKind, capabilities: PausedCapabilities): readonly PausedAction[] => kind === 'revert' && !capabilities.revertSkip ? actions[kind].filter((action) => action !== 'skip') : actions[kind];

export interface PausedOperation {
  readonly operationId: string;
  readonly kind: PausedOperationKind;
  readonly currentStep: number;
  readonly totalSteps?: number;
  readonly currentCommitOid?: string;
  readonly originalHeadOid?: string;
  readonly conflicts: readonly string[];
  readonly actions: readonly PausedAction[];
}
```

```ts
// packages/domain/src/conflict.ts
export type ConflictKind = 'text' | 'binary' | 'deleteModify' | 'submodule';
export interface ConflictStage { readonly stage: 1 | 2 | 3; readonly oid: string; readonly mode: string }
export interface ConflictEntry { readonly path: string; readonly kind: ConflictKind; readonly stages: readonly ConflictStage[]; readonly workingTreeExists: boolean }
```

协议只接受 `conflict.resolve` 和 `paused.action` 判别消息；Action 必须属于 Host 当前状态返回的 actions，Webview 不能声明操作类型。

- [ ] **Step 4: 运行合同测试并提交**

Run: `npx vitest run packages/domain/src packages/protocol/src`

Expected: PASS；Merge 的 Skip 请求在边界被拒绝。

```bash
git add packages/domain packages/protocol
git commit -m "feat: define paused Git operation contracts"
```

### Task 2: 从 Git 实际状态重建 PausedOperation

**Files:**
- Create: `packages/git-cli/src/pausedOperation.ts`
- Test: `packages/git-cli/src/pausedOperation.test.ts`
- Test: `tests/integration/conflicts/detection.test.ts`
- Create: `tests/integration/conflicts/support/index.ts`

- [ ] **Step 1: 写七类操作检测失败测试**

```ts
import { expect, it } from 'vitest';
import { detectPausedOperation } from '../../../packages/git-cli/src/pausedOperation.js';
import { createCherryPickConflict, createMergeConflict, createPullMergeConflict, createPullRebaseConflict, createRebaseConflict, createRevertConflict, createStashConflict, reopenProvider } from './support/index.js';

it.each([
  ['merge', createMergeConflict],
  ['rebase', createRebaseConflict],
  ['cherryPick', createCherryPickConflict],
  ['revert', createRevertConflict],
  ['pullMerge', createPullMergeConflict],
  ['pullRebase', createPullRebaseConflict],
  ['stashApply', createStashConflict],
] as const)('detects %s after reopening the repository', async (kind, createConflict) => {
  const fixture = await createConflict();
  try {
    const reopened = await reopenProvider(fixture.path);
    expect((await detectPausedOperation(reopened, fixture.operationId))?.kind).toBe(kind);
  } finally {
    await fixture.dispose();
  }
});
```

`create*Conflict` 和 `reopenProvider` 均在 `tests/integration/conflicts/support/index.ts` 中有完整真实 Git 实现；每个夹具创建独立临时仓库、原 Operation Journal 与冲突，不使用 mock `.git` 文件，并在 `finally` 释放。

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/conflicts/detection.test.ts`

Expected: FAIL with missing detector。

- [ ] **Step 3: 实现基于 `rev-parse --git-path` 的探测**

```ts
// packages/git-cli/src/pausedOperation.ts
import { allowedPausedActions, type PausedCapabilities, type PausedOperation, type PausedOperationKind } from '@git-workbench/domain';

export interface PausedSnapshot {
  readonly mergeHead?: string;
  readonly cherryPickHead?: string;
  readonly revertHead?: string;
  readonly rebase?: { readonly current: number; readonly total?: number; readonly stoppedOid?: string };
  readonly journalKind?: PausedOperationKind;
  readonly originalHeadOid?: string;
  readonly conflicts: readonly string[];
  readonly capabilities: PausedCapabilities;
}

export function reconstructPausedOperation(snapshot: PausedSnapshot, operationId: string): PausedOperation | undefined {
  let kind: PausedOperationKind | undefined;
  if (snapshot.rebase) kind = snapshot.journalKind === 'pullRebase' ? 'pullRebase' : 'rebase';
  else if (snapshot.cherryPickHead) kind = 'cherryPick';
  else if (snapshot.revertHead) kind = 'revert';
  else if (snapshot.mergeHead) kind = snapshot.journalKind === 'pullMerge' ? 'pullMerge' : 'merge';
  else if (snapshot.journalKind === 'stashApply' && snapshot.conflicts.length) kind = 'stashApply';
  if (!kind) return undefined;
  return {
    operationId,
    kind,
    currentStep: snapshot.rebase?.current ?? 1,
    ...(snapshot.rebase?.total === undefined ? {} : { totalSteps: snapshot.rebase.total }),
    ...(snapshot.rebase?.stoppedOid === undefined ? {} : { currentCommitOid: snapshot.rebase.stoppedOid }),
    ...(snapshot.originalHeadOid === undefined ? {} : { originalHeadOid: snapshot.originalHeadOid }),
    conflicts: snapshot.conflicts,
    actions: allowedPausedActions(kind, snapshot.capabilities),
  };
}
```

`readPausedSnapshot()` 逐个运行 `git rev-parse --git-path MERGE_HEAD|rebase-merge|rebase-apply|CHERRY_PICK_HEAD|REVERT_HEAD` 得到仓库内路径，再用 `workspace.fs.stat`/Node stat 读取存在性；不假设 `.git` 是目录。它把验证后的 marker OID、Rebase metadata、Journal kind 和 `listConflicts()` 结果组装为上述 `PausedSnapshot`。Pull/Stash 类型由原 Journal Intent 与实际状态组合判定，不能仅看 marker 猜测。

- [ ] **Step 4: 解析 Rebase 当前/总步骤**

通过 Git 返回的 rebase state path 读取 `msgnum/end/head-name/onto/stopped-sha`，每个文件有 64 KiB 上限和严格整数/OID校验；未知格式返回兼容诊断和 `currentStep=0`，仍允许 Abort，不猜造步骤。

- [ ] **Step 5: 运行重开检测测试并提交**

Run: `npm run test:integration -- tests/integration/conflicts/detection.test.ts`

Expected: PASS；Linked Worktree 与 Packed Refs 场景不读取错误 Git dir。

```bash
git add packages/git-cli/src/pausedOperation.ts packages/git-cli/src/pausedOperation.test.ts tests/integration/conflicts/detection.test.ts tests/integration/conflicts/support
git commit -m "feat: reconstruct paused Git operations"
```

### Task 3: 解析 Index Stages 并分类特殊冲突

**Files:**
- Create: `packages/git-cli/src/conflicts.ts`
- Test: `packages/git-cli/src/conflicts.test.ts`
- Test: `tests/integration/conflicts/classification.test.ts`

- [ ] **Step 1: 写换行路径、Delete/Modify、Binary、Submodule 失败测试**

```ts
import { expect, it } from 'vitest';
import { parseUnmerged } from './conflicts.js';

it('groups stage 1/2/3 entries by NUL path', () => {
  const entries = parseUnmerged(Buffer.from(`100644 ${'a'.repeat(40)} 1\tline\nname\0` + `100644 ${'b'.repeat(40)} 2\tline\nname\0` + `100644 ${'c'.repeat(40)} 3\tline\nname\0`));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.path).toBe('line\nname');
  expect(entries[0]?.stages.map((stage) => stage.stage)).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/conflicts.test.ts`

Expected: FAIL with missing parser。

- [ ] **Step 3: 实现 NUL Stage Parser 与分类**

```ts
// packages/git-cli/src/conflicts.ts
import type { ConflictStage } from '@git-workbench/domain';

export interface UnmergedPath { readonly path: string; readonly stages: readonly ConflictStage[] }

export function parseUnmerged(bytes: Uint8Array): UnmergedPath[] {
  const grouped = new Map<string, ConflictStage[]>();
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const record of decoded.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('invalid unmerged record');
    const metadata = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    const mode = metadata[0];
    const oid = metadata[1];
    const stage = Number(metadata[2]);
    if (!/^[0-7]{6}$/.test(mode ?? '') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid ?? '') || (stage !== 1 && stage !== 2 && stage !== 3) || !path) throw new Error('invalid unmerged stage');
    const stages = grouped.get(path) ?? [];
    if (stages.some((entry) => entry.stage === stage)) throw new Error('duplicate unmerged stage');
    stages.push({ mode, oid, stage });
    grouped.set(path, stages);
  }
  return [...grouped].map(([path, stages]) => ({ path, stages: stages.sort((a, b) => a.stage - b.stage) }));
}
```

命令固定为 `git ls-files --unmerged -z --stage`。Parser 按第一个 TAB 拆 metadata/path，按 path 分组：

- mode `160000` → `submodule`。
- 缺 Stage 2 或 3 → `deleteModify`。
- 读取 Stage 2/3 blob 前 8 KiB，含 NUL 或无法按配置 encoding 解码 → `binary`。
- 其余 → `text`。

Blob 内容通过 `git cat-file blob <oid>`，OID 必须来自 Parser，不接受 UI 值。

- [ ] **Step 4: 运行分类矩阵并提交**

Run: `npx vitest run packages/git-cli/src/conflicts.test.ts tests/integration/conflicts/classification.test.ts --pool=forks --maxWorkers=1`

Expected: PASS；换行文件名不被拆成两个 Conflict。

```bash
git add packages/git-cli/src/conflicts.ts packages/git-cli/src/conflicts.test.ts tests/integration/conflicts/classification.test.ts
git commit -m "feat: classify Git conflict stages"
```

### Task 4: 文本 Merge Editor 与安全 Stage Resolution

**Files:**
- Create: `src/extension/conflicts/mergeEditorAdapter.ts`
- Create: `src/extension/conflicts/conflictService.ts`
- Create: `src/extension/conflicts/conflictView.ts`
- Test: `tests/vscode/suite/conflictEditor.test.ts`
- Test: `tests/integration/conflicts/text-resolution.test.ts`

- [ ] **Step 1: 写可选 Merge Editor 降级测试**

```ts
test('falls back to opening the file when the merge command is unavailable', async () => {
  commandRegistry.setAvailable([]);
  await adapter.open(conflict);
  assert.deepStrictEqual(openedUris, [conflict.workingTreeUri]);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:vscode -- --grep "Merge Editor"`

Expected: FAIL with missing adapter。

- [ ] **Step 3: 实现命令能力探测与虚拟三方内容**

启动时 `vscode.commands.getCommands(true)` 检测 `git.openMergeEditor`；存在时调用并捕获失败，不把它作为核心接口。否则注册 `git-workbench-conflict:` URI，提供 Base(Stage1)、Current(Stage2)、Incoming(Stage3) 只读内容并打开 Working Tree 文件。

- [ ] **Step 4: 实现解决结果校验**

用户点击“标记已解决”时：

1. 重验 TextDocument.version/Dirty 状态、文件 hash 与 Conflict generation；Dirty 文档必须先由用户显式 Save，插件不代替用户保存，也绝不把旧磁盘版本标记为已解决。
2. 文件存在时立即读取并冻结已确认 bytes/mode，计算 hash；Trusted Workspace 用单参数 `--path=<validatedRepoRelativePath>` 的 `git hash-object -w --stdin` 对冻结 bytes 应用该路径应有的 Clean/EOL 属性并写入对象库，再以 NUL `git update-index -z --index-info` 在单个 Index Lock 中把该精确 OID/mode/path 写入 Stage 0。用户选择删除时用同一 NUL `index-info` 的 zero-OID 删除记录；不再通过验证后重新读取文件的 `git add <path>`/`git rm <path>` 路径。
3. 再读 `ls-files -u`，确认该 path 不含 stage 1/2/3，并验证 Stage 0 OID 等于冻结 OID；随后重新读取 Working Tree hash。若外部程序在执行窗口改了文件，精确解决内容仍留在 Index，新内容只作为可见的 Unstaged Change，不能被意外 Stage 或覆盖。
4. 增加 generation；失败不移除 Conflict UI。Index 更新结果未知时走原 Journal 的 Reconcile，不重复写对象或盲目重试 Index 命令。

扫描 `<<<<<<<`/`=======`/`>>>>>>>` 只生成确认警告，因为源码可能合法包含这些字符串，不能作为绝对阻断。

- [ ] **Step 5: 运行 Dirty Editor/外部保存测试并提交**

Run: `npm run test:vscode -- --grep Conflict && npm run test:integration -- tests/integration/conflicts/text-resolution.test.ts`

Expected: PASS；未保存 Dirty 文档不能被磁盘版本误 Stage。

```bash
git add src/extension/conflicts tests/vscode/suite/conflictEditor.test.ts tests/integration/conflicts/text-resolution.test.ts
git commit -m "feat: integrate text conflict resolution"
```

### Task 5: Binary、Delete/Modify 与 Submodule 专用决策

**Files:**
- Create: `webview/workbench/src/conflicts/special.tsx`
- Create: `src/extension/conflicts/specialResolution.ts`
- Test: `webview/workbench/src/conflicts/special.test.tsx`
- Test: `tests/integration/conflicts/special-resolution.test.ts`

- [ ] **Step 1: 写按钮语义与保存两份失败测试**

Binary UI 必须显示 Current/Incoming 的 OID、大小与可用动作“使用当前”“使用传入”“两份都保留”；Delete/Modify 显示“保留修改内容”“确认删除”；Submodule 显示 Base/Current/Incoming OID 与可达关系。

- [ ] **Step 2: 实现受 OID 锁定的特殊解决**

- Binary 选择：从 Stage 2/3 OID 重新 `cat-file`，写入前重验 Conflict stages；“两份都保留”使用显式新路径并检查不存在。
- Delete/Modify：保留时写对应 blob 并 Stage；删除时 `git --literal-pathspecs rm -- <path>`。
- Submodule：先验证目标 OID 存在于 Submodule repository；更新 gitlink Index，不自动 checkout 或 fetch 未知对象。

任何动作都先建立文件 Checkpoint；写入后 `ls-files -u` 必须清除该 path。

- [ ] **Step 3: 运行特殊冲突矩阵并提交**

Run: `npx vitest run webview/workbench/src/conflicts/special.test.tsx --environment jsdom && npm run test:integration -- tests/integration/conflicts/special-resolution.test.ts`

Expected: PASS；Binary 从不进入文本 Merge Editor。

```bash
git add webview/workbench/src/conflicts src/extension/conflicts/specialResolution.ts tests/integration/conflicts/special-resolution.test.ts
git commit -m "feat: resolve special Git conflicts"
```

### Task 6: Continue、Skip、Abort 与 Stash 完成语义

**Files:**
- Create: `packages/git-cli/src/sequencer.ts`
- Create: `packages/transactions/src/pausedCoordinator.ts`
- Test: `tests/integration/conflicts/sequencer.test.ts`
- Test: `tests/fault-injection/paused-operation.test.ts`

- [ ] **Step 1: 写动作命令矩阵失败测试**

```ts
import { commandForPausedAction } from '../../../packages/git-cli/src/sequencer.js';

it('maps only supported operation actions', () => {
  expect(commandForPausedAction('rebase', 'continue')).toEqual(['rebase', '--continue']);
  expect(commandForPausedAction('merge', 'abort')).toEqual(['merge', '--abort']);
  expect(() => commandForPausedAction('merge', 'skip')).toThrow('unsupported paused action');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/conflicts/sequencer.test.ts`

Expected: FAIL with missing sequencer。

- [ ] **Step 3: 实现静态命令矩阵**

```ts
// packages/git-cli/src/sequencer.ts
import type { PausedAction, PausedOperationKind } from '@git-workbench/domain';

const commands: Partial<Record<`${PausedOperationKind}:${PausedAction}`, readonly string[]>> = {
  'merge:continue': ['merge', '--continue'],
  'merge:abort': ['merge', '--abort'],
  'pullMerge:continue': ['merge', '--continue'],
  'pullMerge:abort': ['merge', '--abort'],
  'rebase:continue': ['rebase', '--continue'],
  'rebase:skip': ['rebase', '--skip'],
  'rebase:abort': ['rebase', '--abort'],
  'pullRebase:continue': ['rebase', '--continue'],
  'pullRebase:skip': ['rebase', '--skip'],
  'pullRebase:abort': ['rebase', '--abort'],
  'cherryPick:continue': ['cherry-pick', '--continue'],
  'cherryPick:skip': ['cherry-pick', '--skip'],
  'cherryPick:abort': ['cherry-pick', '--abort'],
  'revert:continue': ['revert', '--continue'],
  'revert:skip': ['revert', '--skip'],
  'revert:abort': ['revert', '--abort'],
};

export function commandForPausedAction(kind: PausedOperationKind, action: PausedAction): readonly string[] {
  const command = commands[`${kind}:${action}`];
  if (!command) throw new Error('unsupported paused action');
  return command;
}
```

启动 Capability Probe 对每个命令运行无副作用 help/临时仓库场景；若正式支持基线中的某个 Git 构建不支持 `revert --skip`，对应 actions 不包含 Skip，而不是执行后才发现。

- [ ] **Step 4: 实现 Paused Journal 续接**

Continue 前要求 `ls-files -u` 为空、所有用户选择的解决文件已 Stage、Plan/Operation ID 与当前 Journal 匹配。命令结束后重新 detect：仍有 marker → 保持 Paused 并更新步骤；无 marker且 Postcondition 成立 → Committed。Abort 后验证 HEAD/Ref 与 Checkpoint 预期；不一致为 NeedsAttention。

Continue 可能请求 Commit/Sequence Editor；PausedCoordinator 必须注入与 History Task 相同安全边界的 Extension-owned Helper。非交互 Merge/Cherry-pick/Revert/Pull 只保留 Git 已生成且在 UI 可预览的 Message，Interactive Rebase 只接受原 Operation JSON 中的 Message；不得启动 Workspace `core.editor`/`sequence.editor`，不得把任意命令字符串传给 Helper。Hooks 与 Signing 继续生效。

Stash Apply 没有 Sequencer Continue：所有 conflict stages 清除后，`markResolved` 验证 Working Tree/Index，Journal 终结为 Committed；原 Stash 始终保留。`abortToCheckpoint` 使用 Phase 3 CAS 恢复。

- [ ] **Step 5: 强杀 Continue/Abort 每个状态点并提交**

Run: `npx vitest run tests/fault-injection/paused-operation.test.ts --pool=forks --maxWorkers=1`

Expected: 重启后可继续或中止；不出现第二次重复 Commit。

```bash
git add packages/git-cli/src/sequencer.ts packages/transactions/src/pausedCoordinator.ts tests/integration/conflicts/sequencer.test.ts tests/fault-injection/paused-operation.test.ts
git commit -m "feat: continue and abort paused Git operations"
```

### Task 7: 固定横幅、重启 E2E 与 Phase 4 门槛

**Files:**
- Create: `webview/workbench/src/conflicts/banner.tsx`
- Modify: `webview/workbench/src/app.tsx`
- Modify: `src/extension/activate.ts`
- Create: `tests/e2e/conflict-workflow.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 写横幅信息与操作按钮测试**

```tsx
it('shows operation progress, conflict count and only allowed actions', () => {
  render(<PausedBanner operation={{ kind: 'rebase', currentStep: 2, totalSteps: 5, conflicts: ['a.ts'], actions: ['continue', 'skip', 'abort'] }} />);
  expect(screen.getByText('Rebase：第 2/5 步')).toBeVisible();
  expect(screen.getByText('1 个冲突')).toBeVisible();
  expect(screen.queryByRole('button', { name: '强制完成' })).toBeNull();
});
```

- [ ] **Step 2: 实现工作台与侧栏固定状态**

Paused 时侧栏顶部和工作台顶部都显示同一 DTO；关闭面板不清除状态。Continue 在 Conflict count 非零时禁用；按钮发 `paused.action`，不执行本地乐观状态切换，等待 Host 新 generation。

`conflict.autoOpen=prompt/first/never` 分别询问、仅打开首个安全文本冲突、只显示横幅；Binary/Delete-Modify/Submodule 永不因 `first` 自动执行选择，设置也不能跳过固定 Paused 横幅。

- [ ] **Step 3: 运行关闭/重开/Reload Window E2E**

Run: `npx vitest run tests/e2e/conflict-workflow.test.ts --pool=forks --maxWorkers=1 && npm run test:vscode -- --grep Paused`

Expected: 六类操作在 Reload 后状态、步骤、冲突和允许动作一致；Abort 验证通过。

- [ ] **Step 4: 运行 Phase 4 全量门槛**

Run: `npm run check && npm run test:integration && npm run test:vscode && npx vitest run tests/fault-injection tests/e2e/conflict-workflow.test.ts --pool=forks --maxWorkers=1 && npm run package`

Expected: 全部 exit 0；三平台真实 Merge Editor 可用性有记录，Fallback 全部通过。

- [ ] **Step 5: 提交 Phase 4 收尾**

```bash
git add webview/workbench/src/conflicts/banner.tsx webview/workbench/src/app.tsx src/extension/activate.ts tests/e2e/conflict-workflow.test.ts .github/workflows/ci.yml
git commit -m "test: enforce paused operation recovery gates"
```
