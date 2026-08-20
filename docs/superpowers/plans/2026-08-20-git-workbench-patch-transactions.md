# Git Workbench Patch Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付类似 TortoiseGit 的文件/Hunk/行级应用能力，并通过 Raw Patch、执行前重验、内容快照、Durable Journal、CAS 补偿和恢复中心保护用户数据。

**Architecture:** Compare 会话同时持有 View Diff 与不可变 Raw Diff Token；用户选择映射回 Raw Diff 后生成有上下文的最小 Patch。Index 目标使用单次 `git apply --cached`，Working Tree 目标在纯文本 Dirty 文档上使用单次 `WorkspaceEdit`，其余使用 `git apply`；所有路径先 Checkpoint，外部并发导致不确定状态时只 Reconcile，不覆盖新内容。

**Tech Stack:** 前三阶段技术栈、Git binary patch、VS Code WorkspaceEdit、Node content-addressed storage、SHA-256、Webview Hunk/Line UI、故障注入进程

---

**Authoritative spec:** `docs/superpowers/specs/2026-08-20-git-workbench-vscode-extension-design.md`

## 前置条件与阶段出口

- Phase 2 的 MutationCoordinator、Journal 和 VersionVector 已通过故障门槛。
- 每个可写选择都来自当前 generation 的 Raw Diff Token；Whitespace 视图不能成为写入源。
- 不使用 `git apply --reject`、`--unidiff-zero` 或无上下文 Patch。
- 自动回滚只有在当前内容仍等于该操作 After Image 时允许；否则进入三方恢复。
- 完成后崩溃恢复、Index 原子 Patch、外部抢写和 Dirty Editor E2E 全部通过。

## 文件结构

```text
packages/domain/src/patch.ts                    Raw token、选择、目标、结果
packages/git-cli/src/rawDiff.ts                 完整原始 Diff/Blob 基线
packages/git-cli/src/patchBuilder.ts            行选择到最小 Patch
packages/git-cli/src/applyPatch.ts              Index/Working Tree Git Apply
packages/git-cli/src/ignore.ts                  精确 Ignore Pattern 编码
packages/transactions/src/contentStore.ts       内容寻址源码快照
packages/transactions/src/checkpoint.ts         Ref/Index/文件 Checkpoint
packages/transactions/src/safePath.ts           写路径/链接防逃逸
packages/transactions/src/reconcile.ts          启动/失败对账
packages/transactions/src/rollback.ts           After Image CAS 补偿
src/extension/patch/patchService.ts              Plan 与执行适配
src/extension/patch/workspaceEditAdapter.ts      Dirty 文档最小 Edit
src/extension/recovery/recoveryService.ts        恢复动作
src/extension/recovery/recoveryView.ts           恢复中心 Tree View
webview/workbench/src/compare/hunkSelection.ts   选择状态
webview/workbench/src/compare/diffFile.tsx       文件/Hunk/行交互
webview/workbench/src/recovery/recoveryPanel.tsx 三方恢复 UI
tests/fault-injection/patch-transaction.test.ts  崩溃点与外部抢写
```

### Task 1: 定义 Raw Diff Token、Patch Selection 与目标合同

**Files:**
- Create: `packages/domain/src/patch.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/validate.ts`
- Test: `packages/domain/src/patch.test.ts`

- [ ] **Step 1: 写 whitespace 切换使选择失效的失败测试**

```ts
// packages/domain/src/patch.test.ts
import { describe, expect, it } from 'vitest';
import { validatePatchSelection } from './patch.js';

it('rejects a selection from another generation or view mode', () => {
  const token = { id: 'raw-1', repositoryId: 'repo', generation: 8, leftIdentity: 'a', rightIdentity: 'worktree:h1', rawDigest: 'd1', viewDigest: 'v1' } as const;
  const items = [{ kind: 'file', path: 'a.ts' }] as const;
  expect(validatePatchSelection(token, { tokenId: 'raw-1', generation: 7, viewDigest: 'v1', items })).toEqual(['generation']);
  expect(validatePatchSelection(token, { tokenId: 'raw-2', generation: 8, viewDigest: 'v1', items })).toEqual(['token']);
  expect(validatePatchSelection(token, { tokenId: 'raw-1', generation: 8, viewDigest: 'old-view', items })).toEqual(['view']);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/domain/src/patch.test.ts`

Expected: FAIL with missing patch contract。

- [ ] **Step 3: 实现不可伪造的选择合同**

```ts
// packages/domain/src/patch.ts
export interface RawDiffToken {
  readonly id: string;
  readonly repositoryId: string;
  readonly generation: number;
  readonly leftIdentity: string;
  readonly rightIdentity: string;
  readonly rawDigest: string;
  readonly viewDigest: string;
}

export type PatchTarget =
  | { readonly kind: 'index' }
  | { readonly kind: 'workingTree' }
  | { readonly kind: 'newWorktree'; readonly branchOid: string; readonly directoryUri: string };

export type PatchSelectionItem =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'hunk'; readonly path: string; readonly rawHunkId: string }
  | { readonly kind: 'lines'; readonly path: string; readonly rawHunkId: string; readonly lineIds: readonly string[] };

export interface PatchSelection {
  readonly tokenId: string;
  readonly generation: number;
  readonly viewDigest: string;
  readonly items: readonly PatchSelectionItem[];
}

export function validatePatchSelection(token: RawDiffToken, selection: PatchSelection): string[] {
  const errors: string[] = [];
  if (token.id !== selection.tokenId) errors.push('token');
  if (token.generation !== selection.generation) errors.push('generation');
  if (token.viewDigest !== selection.viewDigest) errors.push('view');
  if (selection.items.length === 0) errors.push('empty');
  if (selection.items.length > 10_000) errors.push('selection-size');
  return errors;
}
```

Host 根据 `token.id` 从有界内存取 Raw Diff；Webview 不能回传 Patch 文本。只有超过内存预算时才可 Spill 到 Extension `globalStorageUri/session/<random-id>`，要求当前用户私有权限、内容 digest、会话关闭/TTL 清理，且永不进入 Workspace、日志、遥测或诊断包。权限无法证明时不 Spill，只按文件重新查询。协议拒绝路径越界、重复 line ID、空选择和未知 target。

“交换/反向应用”不是 Selection 中的布尔参数：用户交换 A/B 后 Host 销毁旧 Token 与选择，按新方向重新解析端点并生成新的 Raw Diff Token。这样 Patch 方向由 `leftIdentity → rightIdentity` 唯一决定，不能在执行消息里临时追加 `--reverse` 绕过预览。

- [ ] **Step 4: 运行合同测试并提交**

Run: `npx vitest run packages/domain/src packages/protocol/src`

Expected: PASS；消息中出现 `patchText` 或任意 Git args 时校验失败。

```bash
git add packages/domain packages/protocol
git commit -m "feat: define guarded patch selections"
```

### Task 2: 保存 Raw Diff 并从行选择构造有上下文 Patch

**Files:**
- Create: `packages/git-cli/src/rawDiff.ts`
- Create: `packages/git-cli/src/patchBuilder.ts`
- Test: `packages/git-cli/src/rawDiff.test.ts`
- Test: `packages/git-cli/src/patchBuilder.test.ts`
- Test: `tests/property/patchBuilder.property.test.ts`

- [ ] **Step 1: 写非连续行、No-newline 与 context 失败测试**

```ts
// packages/git-cli/src/patchBuilder.test.ts
import { expect, it } from 'vitest';
import { buildSelectedPatch, type RawUnifiedDiff } from './patchBuilder.js';

const raw: RawUnifiedDiff = {
  files: [{
    path: 'a.ts',
    header: ['diff --git a/a.ts b/a.ts', 'index 1111111..2222222 100644', '--- a/a.ts', '+++ b/a.ts'],
    fullPatchBytes: new Uint8Array(),
    lineSelectionAllowed: true,
    oldLineCount: 20,
    newLineCount: 22,
    hunks: [{
      id: 'h1', header: '@@ -8,8 +8,10 @@', oldStart: 8, oldLines: 8, newStart: 8, newLines: 10,
      lines: [
        { id: 'c8', marker: ' ', text: 'line8' }, { id: 'c9', marker: ' ', text: 'line9' }, { id: 'c10', marker: ' ', text: 'line10' },
        { id: 'add-a', marker: '+', text: 'selected A' },
        { id: 'c11', marker: ' ', text: 'line11' }, { id: 'c12', marker: ' ', text: 'line12' },
        { id: 'add-b', marker: '+', text: 'selected B' },
        { id: 'c13', marker: ' ', text: 'line13' }, { id: 'c14', marker: ' ', text: 'line14' }, { id: 'c15', marker: ' ', text: 'line15' },
      ],
    }],
  }],
};

it('expands selected lines into safe hunks with three context lines', () => {
  const patch = buildSelectedPatch(raw, [{ kind: 'lines', path: 'a.ts', rawHunkId: 'h1', lineIds: ['add-a', 'add-b'] }]);
  expect(patch.toString('utf8')).toContain('@@ -8,8 +8,10 @@');
  expect(patch.toString('utf8')).not.toContain('@@ -0,0 +0,0 @@');
  expect(patch.contextLines).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/patchBuilder.test.ts`

Expected: FAIL with missing builder。

- [ ] **Step 3: 实现 Raw Diff 身份与解析**

Raw Diff 命令固定为：

```text
git --literal-pathspecs -c core.safecrlf=false diff --binary --full-index --no-ext-diff --no-textconv --unified=3 <resolved endpoints> -- <validated paths>
```

不传任何 whitespace-ignore 参数。`rawDiff.ts` 用有界状态机解析 `diff --git`、完整 `index` OID、mode、rename/copy、`---/+++`、Hunk range、No-newline marker 与 binary payload；字段缺失、重复 header、越界 range 或截断输入返回 `PARSER_UNSUPPORTED`，不猜测。它同时保存原始 bytes、SHA-256、endpoint OID/Index fingerprint/Working Tree file hashes、generation；超出 session byte budget 时只允许按文件重新获取。`rawDiff.test.ts` 使用内联 UTF-8/CRLF/Binary/新建/删除/重命名 fixtures，不引用未声明全局。

- [ ] **Step 4: 实现选择算法**

```ts
// packages/git-cli/src/patchBuilder.ts
import { GitWorkbenchError, type PatchSelectionItem } from '@git-workbench/domain';

export interface RawLine { readonly id: string; readonly marker: ' ' | '+' | '-' | '\\'; readonly text: string; readonly oldLine?: number; readonly newLine?: number }
export interface RawHunk { readonly id: string; readonly header: string; readonly oldStart: number; readonly oldLines: number; readonly newStart: number; readonly newLines: number; readonly lines: readonly RawLine[] }
export interface RawFilePatch { readonly path: string; readonly header: readonly string[]; readonly fullPatchBytes: Uint8Array; readonly lineSelectionAllowed: boolean; readonly oldLineCount: number; readonly newLineCount: number; readonly hunks: readonly RawHunk[] }
export interface RawUnifiedDiff { readonly files: readonly RawFilePatch[] }
export interface BuiltPatch { readonly bytes: Uint8Array; readonly contextLines: number; toString(encoding: BufferEncoding): string }

interface HunkChoice { readonly all: boolean; readonly lineIds: ReadonlySet<string> }
interface FileChoice { all: boolean; readonly hunks: Map<string, HunkChoice> }

const selectionError = (message: string): GitWorkbenchError => new GitWorkbenchError({ code: 'INVALID_INPUT', message, repositoryChanged: false, retry: 'refresh' });
const unsafeLineSelection = (message: string): GitWorkbenchError => new GitWorkbenchError({ code: 'UNSAFE_LINE_SELECTION', message, repositoryChanged: false, retry: 'refresh' });

function indexSelection(selection: readonly PatchSelectionItem[]): Map<string, FileChoice> {
  const result = new Map<string, FileChoice>();
  for (const item of selection) {
    const file = result.get(item.path) ?? { all: false, hunks: new Map<string, HunkChoice>() };
    if (item.kind === 'file') file.all = true;
    else if (item.kind === 'hunk') file.hunks.set(item.rawHunkId, { all: true, lineIds: new Set() });
    else file.hunks.set(item.rawHunkId, { all: false, lineIds: new Set(item.lineIds) });
    result.set(item.path, file);
  }
  return result;
}

function selectAndRecount(file: RawFilePatch, hunk: RawHunk, choice: HunkChoice, selectedNewStart: number): { readonly header: string; readonly lines: readonly RawLine[]; readonly oldLines: number; readonly newLines: number; readonly contextLines: number } {
  if (!choice.all && !file.lineSelectionAllowed) throw unsafeLineSelection('该文件类型只能选择完整 Hunk 或文件');
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
  if (!range || Number(range[1]) !== hunk.oldStart || Number(range[2] ?? 1) !== hunk.oldLines || Number(range[3]) !== hunk.newStart || Number(range[4] ?? 1) !== hunk.newLines) throw selectionError('Raw Hunk 身份不一致');
  const availableChangeIds = new Set(hunk.lines.filter((line) => line.marker === '+' || line.marker === '-').map((line) => line.id));
  if ([...choice.lineIds].some((id) => !availableChangeIds.has(id))) throw selectionError('选择包含未知行');
  const lines: RawLine[] = [];
  let keptChange = false;
  let previousKept = false;
  for (const line of hunk.lines) {
    if (line.marker === '\\') {
      if (previousKept) lines.push(line);
      continue;
    }
    if (line.marker === ' ') {
      lines.push(line);
      previousKept = true;
      continue;
    }
    const selected = choice.all || choice.lineIds.has(line.id);
    if (line.marker === '+' && !selected) {
      previousKept = false;
      continue;
    }
    if (line.marker === '-' && !selected) {
      lines.push({ ...line, marker: ' ' });
      previousKept = true;
      continue;
    }
    lines.push(line);
    keptChange = true;
    previousKept = true;
  }
  if (!keptChange) throw selectionError('选择未产生任何变更');
  const oldLines = lines.filter((line) => line.marker === ' ' || line.marker === '-').length;
  const newLines = lines.filter((line) => line.marker === ' ' || line.marker === '+').length;
  const firstChange = lines.findIndex((line) => line.marker === '+' || line.marker === '-');
  let lastChange = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.marker === '+' || lines[index]?.marker === '-') { lastChange = index; break; }
  }
  const leadingContext = lines.slice(0, firstChange).filter((line) => line.marker === ' ').length;
  const trailingContext = lines.slice(lastChange + 1).filter((line) => line.marker === ' ').length;
  if (!choice.all) {
    const touchesStart = hunk.oldStart <= 1;
    const touchesEnd = hunk.oldStart + hunk.oldLines - 1 >= file.oldLineCount;
    if ((leadingContext < 3 && !touchesStart) || (trailingContext < 3 && !touchesEnd) || leadingContext + trailingContext === 0) {
      throw unsafeLineSelection('所选行无法形成有安全上下文的 Patch，请选择完整 Hunk');
    }
  }
  const contextLines = Math.min(leadingContext, trailingContext);
  const suffix = hunk.header.slice(range[0].length);
  return { header: `@@ -${hunk.oldStart},${oldLines} +${selectedNewStart},${newLines} @@${suffix}`, lines, oldLines, newLines, contextLines };
}

export function buildSelectedPatch(raw: RawUnifiedDiff, selection: readonly PatchSelectionItem[]): BuiltPatch {
  const selected = indexSelection(selection);
  const parts: Buffer[] = [];
  let minimumContext = Number.POSITIVE_INFINITY;
  for (const file of raw.files) {
    const fileSelection = selected.get(file.path);
    if (!fileSelection) continue;
    if (fileSelection.all) {
      if (!file.fullPatchBytes.byteLength) throw selectionError('完整文件 Patch 缺失');
      parts.push(Buffer.from(file.fullPatchBytes));
      selected.delete(file.path);
      continue;
    }
    const output: string[] = [...file.header];
    let selectedDelta = 0;
    let selectedHunks = 0;
    for (const hunk of file.hunks) {
      const choice = fileSelection.hunks.get(hunk.id);
      if (!choice) continue;
      const normalized = selectAndRecount(file, hunk, choice, hunk.oldStart + selectedDelta);
      minimumContext = Math.min(minimumContext, normalized.contextLines);
      output.push(normalized.header, ...normalized.lines.map((line) => `${line.marker}${line.text}`));
      selectedDelta += normalized.newLines - normalized.oldLines;
      selectedHunks += 1;
      fileSelection.hunks.delete(hunk.id);
    }
    if (fileSelection.hunks.size) throw selectionError('选择包含未知 Hunk');
    if (!selectedHunks) throw selectionError('选择未产生文件 Patch');
    parts.push(Buffer.from(`${output.join('\n')}\n`, 'utf8'));
    selected.delete(file.path);
  }
  if (selected.size) throw selectionError('选择包含未知文件');
  if (!parts.length) throw selectionError('选择未产生 Patch');
  const bytes = Buffer.concat(parts);
  return { bytes, contextLines: Number.isFinite(minimumContext) ? minimumContext : 0, toString: (encoding) => Buffer.from(bytes).toString(encoding) };
}
```

选择算法保留 Raw Hunk 已有上下文，并按“此前已选择变更的累计行差”重算后续 Hunk 的 new start，不能复用包含未选变更的 View/Target 行号。未选中的 addition 删除、未选中的 deletion 转为 context、range 重新计数、No-newline marker 只跟随保留行。普通文本修改支持 Hunk/行；新建、删除、Binary、Rename/Copy、Mode、Symlink、Submodule 或无法安全表达的选择只允许完整文件，直接使用经 digest 校验的 `fullPatchBytes`。

- [ ] **Step 5: Property Test 对照 Git Apply**

随机生成 Base/Target 文本和合法行选择，构造 Patch 后在临时仓库执行 `git apply --check`；若 builder 返回 Patch，则 check 必须成功且应用结果只包含选择的语义。固定 seed 输出到失败日志以便复现。

- [ ] **Step 6: 运行 parser/property tests 并提交**

Run: `npx vitest run packages/git-cli/src/rawDiff.test.ts packages/git-cli/src/patchBuilder.test.ts tests/property/patchBuilder.property.test.ts --pool=forks --maxWorkers=1`

Expected: PASS；没有使用 `--unidiff-zero`。

```bash
git add packages/git-cli/src/rawDiff.ts packages/git-cli/src/rawDiff.test.ts packages/git-cli/src/patchBuilder.ts packages/git-cli/src/patchBuilder.test.ts tests/property/patchBuilder.property.test.ts
git commit -m "feat: build safe selected patches"
```

### Task 3: 内容寻址快照与完整 Checkpoint

**Files:**
- Create: `packages/transactions/src/contentStore.ts`
- Create: `packages/transactions/src/checkpoint.ts`
- Create: `packages/transactions/src/safePath.ts`
- Modify: `packages/transactions/src/refCheckpoint.ts`
- Test: `packages/transactions/src/contentStore.test.ts`
- Test: `packages/transactions/src/checkpoint.test.ts`
- Test: `packages/transactions/src/safePath.test.ts`

- [ ] **Step 1: 写 binary、dedupe 与权限失败测试**

```ts
// packages/transactions/src/contentStore.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ContentStore } from './contentStore.js';

it('deduplicates binary content and verifies every read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-workbench-store-'));
  try {
    const store = new ContentStore(root);
    const bytes = Uint8Array.from([0, 255, 1, 2]);
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    expect(first.digest).toBe(second.digest);
    expect(await store.get(first)).toEqual(bytes);
    await writeFile(join(root, 'objects', first.digest.slice(0, 2), first.digest.slice(2)), Uint8Array.from([9]));
    await expect(store.get(first)).rejects.toMatchObject({ payload: { code: 'CORRUPT_REPOSITORY' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/transactions/src/contentStore.test.ts`

Expected: FAIL with missing store。

- [ ] **Step 3: 实现只创建不覆盖的 Content Store**

```ts
// packages/transactions/src/contentStore.ts
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { GitWorkbenchError } from '@git-workbench/domain';

export interface ContentRef { readonly digest: string; readonly bytes: number }

export class ContentStore {
  constructor(private readonly root: string) {}
  async put(content: Uint8Array): Promise<ContentRef> {
    const digest = createHash('sha256').update(content).digest('hex');
    const directory = join(this.root, 'objects', digest.slice(0, 2));
    const target = join(directory, digest.slice(2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(target);
        if (!Buffer.from(existing).equals(Buffer.from(content))) throw new GitWorkbenchError({ code: 'CORRUPT_REPOSITORY', message: '内容寻址对象冲突或损坏', repositoryChanged: false, retry: 'none' });
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    return { digest, bytes: content.byteLength };
  }
  async get(ref: ContentRef): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(ref.digest) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new GitWorkbenchError({ code: 'CORRUPT_REPOSITORY', message: '恢复快照引用无效', repositoryChanged: false, retry: 'none' });
    const content = await readFile(join(this.root, 'objects', ref.digest.slice(0, 2), ref.digest.slice(2)));
    if (content.byteLength !== ref.bytes || createHash('sha256').update(content).digest('hex') !== ref.digest) throw new GitWorkbenchError({ code: 'CORRUPT_REPOSITORY', message: '恢复快照校验失败', repositoryChanged: false, retry: 'none' });
    return content;
  }
}
```

初始化时先探测同目录 hard-link、原子 rename、file Flush 与目录 Flush 能力；Content Store 只通过已 Flush 的临时文件 + 同目录 hard-link 发布不可覆盖对象，永不让半写对象占用最终 digest。Windows 安装时验证 Storage 根目录 ACL 仅当前用户；无法证明发布/权限语义时禁用依赖源码恢复的危险写操作并显示诊断，不静默降级权限。

- [ ] **Step 4: 实现 Checkpoint Manifest**

Checkpoint 对每个受影响路径记录 Base/Before bytes ContentRef、mode、symlink target、exists、Working Tree hash、Index stages；Ref 使用 recovery namespace。`safePath.ts` 只接受来自已验证 Raw Diff/Git Index 的 repo-relative bytes，拒绝绝对路径、NUL 和 `..`；写入前后逐级 `lstat`，父级出现 Symlink、Windows Junction/Reparse Point 或 identity 变化即返回 `STALE_PLAN`。目标本身若是 tracked Symlink，只检查/恢复 Link 对象而不跟随其 target。Manifest 先完整写入 Content Store，再把 Journal 状态推进到 `Checkpointed`。

写前计算去重后的新增 bytes、当前 Store 实占和文件系统可用空间；同时满足 `safety.checkpointMaxDiskMB` 与“写完仍保留安全余量”才允许继续。配额检查和新对象/Manifest 发布必须持有 Extension Storage 根下的跨窗口 `StorageQuotaLease`：用原子 `mkdir` 获取，Owner 记录随机 Token、PID、进程启动身份与 Heartbeat；只释放自己的 Token。崩溃残留只有在 Heartbeat 超时、同一 PID/启动身份已不存在并成功原子移入 quarantine 后才可回收，无法证明就阻止新 Checkpoint 并显示诊断，不能并发越过配额。

清理器先按 `checkpointRetentionDays/checkpointMaxCount` 清理已终结、未 Pin、无活跃恢复引用的 Operation，并在删除前再次校验 Journal；固定/活跃数据即使超过上限也不删，而是阻止新的依赖源码恢复操作并打开 Recovery Center。故障测试用两个 Extension Host 子进程、稀疏大文件、去重对象、Pin、残留 Lease 和低磁盘配额证明不会并发超额或写出不完整 Checkpoint。

- [ ] **Step 5: 运行快照、清理与配额测试并提交**

Run: `npx vitest run packages/transactions/src/contentStore.test.ts packages/transactions/src/checkpoint.test.ts packages/transactions/src/safePath.test.ts`

Expected: PASS；Retention 只清理未 Pin 且 Journal 已终结的对象；Symlink/Junction 父级交换不能把 Checkpoint 或 Restore 写到 Worktree 外。

```bash
git add packages/transactions/src/contentStore.ts packages/transactions/src/checkpoint.ts packages/transactions/src/safePath.ts packages/transactions/src/refCheckpoint.ts packages/transactions/src/*checkpoint.test.ts packages/transactions/src/safePath.test.ts
git commit -m "feat: checkpoint affected Git content"
```

### Task 4: 原子应用到 Index

**Files:**
- Create: `packages/git-cli/src/applyPatch.ts`
- Create: `src/extension/patch/patchService.ts`
- Test: `tests/integration/patch/index.test.ts`

- [ ] **Step 1: 写多 Hunk 任一失败全部不应用测试**

```ts
it('does not modify the index when one selected hunk is stale', async () => {
  const before = await fixture.indexFingerprint();
  await fixture.changeIndexOutsideWorkbench('b.ts');
  await expect(service.apply(selection, { kind: 'index' })).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
  expect(await fixture.indexFingerprint()).not.toBe(before);
  expect(await fixture.isStaged('a.ts')).toBe(false);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/patch/index.test.ts`

Expected: FAIL with missing apply service。

- [ ] **Step 3: 实现单 Patch、单 Git 调用**

```ts
// packages/git-cli/src/applyPatch.ts
import { GitWorkbenchError } from '@git-workbench/domain';
import type { MutationGitProvider } from './ports.js';

export async function applyPatchToIndex(provider: MutationGitProvider, patch: Uint8Array): Promise<void> {
  const check = await provider.query(['apply', '--check', '--cached', '--whitespace=nowarn', '-'], patch);
  if (check.exitCode !== 0) throw new GitWorkbenchError({ code: 'STALE_PLAN', message: 'Patch 已不再适用于当前 Index', repositoryChanged: true, retry: 'refresh' });
  const result = await provider.mutate(['apply', '--cached', '--whitespace=nowarn', '-'], patch);
  if (result.exitCode !== 0 || result.outcome === 'unknown') throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: 'Index Patch 结果需要对账', repositoryChanged: true, retry: 'reconcile' });
}
```

MutationCoordinator 在 `--check` 与实际 apply 之间无异步 UI 工作，但仍在 apply 前再次采样 Index fingerprint。实际 Git 调用依赖 Index Lock；外部 lock 返回 `REPOSITORY_LOCKED`，从不删除 lock。

- [ ] **Step 4: 运行 Rename/Mode/Symlink/CRLF/大路径测试并提交**

Run: `npm run test:integration -- tests/integration/patch/index.test.ts`

Expected: PASS；任一普通校验失败 Index 不改变。

```bash
git add packages/git-cli/src/applyPatch.ts src/extension/patch/patchService.ts tests/integration/patch/index.test.ts
git commit -m "feat: apply selected patches to index"
```

### Task 5: 安全应用到 Working Tree 与 Dirty Editor

**Files:**
- Create: `src/extension/patch/workspaceEditAdapter.ts`
- Modify: `packages/git-cli/src/applyPatch.ts`
- Test: `tests/vscode/suite/workspaceEdit.test.ts`
- Test: `tests/integration/patch/worktree.test.ts`

- [ ] **Step 1: 写 Dirty 文档不保存和版本变化失败测试**

```ts
suite('patch workspace edit', () => {
  test('applies text edits without saving and rejects a changed document version', async () => {
    const document = await openDirtyDocument('a.ts', 'base\n');
    const baseline = document.version;
    await editDocument(document, 'external\n');
    await assert.rejects(() => adapter.apply([{ uri: document.uri, expectedVersion: baseline, edits: [replaceAll('ours\n')] }]), /STALE_PLAN/);
    assert.strictEqual(document.getText(), 'external\n');
    assert.strictEqual(document.isDirty, true);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:vscode -- --grep "patch workspace edit"`

Expected: FAIL with missing adapter。

- [ ] **Step 3: 实现无异步间隙复验的 Text-only WorkspaceEdit**

```ts
// src/extension/patch/workspaceEditAdapter.ts
import * as vscode from 'vscode';
import { GitWorkbenchError } from '@git-workbench/domain';

export interface VersionedTextEdits { readonly uri: vscode.Uri; readonly expectedVersion: number; readonly edits: readonly vscode.TextEdit[] }

export async function applyVersionedTextEdits(items: readonly VersionedTextEdits[]): Promise<void> {
  const documents = await Promise.all(items.map((item) => vscode.workspace.openTextDocument(item.uri)));
  for (let index = 0; index < items.length; index += 1) {
    if (documents[index]?.version !== items[index]?.expectedVersion) throw new GitWorkbenchError({ code: 'STALE_PLAN', message: '编辑器内容已变化', repositoryChanged: true, retry: 'refresh' });
  }
  const edit = new vscode.WorkspaceEdit();
  for (const item of items) edit.set(item.uri, [...item.edits]);
  if (!(await vscode.workspace.applyEdit(edit))) throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: 'VS Code 未能应用完整文本编辑', repositoryChanged: false, retry: 'reconcile' });
}
```

最后一次版本比较与 `applyEdit` 调用之间不得 `await`。该 API 不主动 Save。若选择同时包含 Dirty 文本文档和需要 Git 写盘的新建/删除/模式变化，预览要求拆成两个操作或选择 New Worktree，不能伪装成单次原子操作。

- [ ] **Step 4: 实现磁盘 Working Tree Git Apply**

没有 Dirty 文档且不与编辑器缓冲区分叉时，先 `git apply --check --whitespace=nowarn -`，再实际 `git apply --whitespace=nowarn -`。后置读取所有 After Image hash；不使用 `--reject`。I/O/崩溃可能部分写入时进入 Reconcile。

- [ ] **Step 5: 运行外部保存抢写与多文件测试并提交**

Run: `npm run test:vscode -- --grep "patch workspace edit" && npm run test:integration -- tests/integration/patch/worktree.test.ts`

Expected: PASS；外部新内容从不被旧快照自动覆盖。

```bash
git add src/extension/patch/workspaceEditAdapter.ts packages/git-cli/src/applyPatch.ts tests/vscode/suite/workspaceEdit.test.ts tests/integration/patch/worktree.test.ts
git commit -m "feat: apply patches without overwriting editor changes"
```

### Task 6: 可恢复地精确 Ignore 所选路径

**Files:**
- Create: `packages/git-cli/src/ignore.ts`
- Create: `src/extension/mutations/ignoreService.ts`
- Modify: `src/extension/scm/sourceControl.ts`
- Test: `packages/git-cli/src/ignore.test.ts`
- Test: `tests/integration/patch/ignore.test.ts`
- Test: `tests/vscode/suite/ignore.test.ts`

- [ ] **Step 1: 写特殊字符、Dirty `.gitignore` 与 Symlink 失败测试**

```ts
it('encodes an exact root-anchored path without interpreting glob syntax', () => {
  expect(encodeExactIgnorePath('build/[draft]*?.txt', false)).toBe('/build/\\[draft\\]\\*\\?.txt');
  expect(() => encodeExactIgnorePath('line\nbreak.txt', false)).toThrow('cannot encode');
});
```

VS Code 测试先打开并修改 `.gitignore`，再由外部编辑把版本推进，断言旧确认返回 `STALE_PLAN` 且两份内容都不被覆盖；集成测试把根 `.gitignore` 替换为指向 Worktree 外的 Symlink，断言服务拒绝跟随。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/ignore.test.ts && npm run test:integration -- tests/integration/patch/ignore.test.ts`

Expected: FAIL with missing Ignore encoder/service。

- [ ] **Step 3: 实现仅精确路径的 Pattern 编码**

V1 Context Menu 只提供“将所选路径精确加入 Ignore”，不接受 Webview/Command 参数中的任意 Pattern。Host 从当前 Status DTO 取得 repo-relative path 和 file/directory kind，拒绝 NUL、换行、越界与无法无歧义表示的名称；根锚定 Pattern 以 `/` 开头，逐字转义 `\\*?[]` 等 Gitignore 元字符，目录以 `/` 结尾。编码后在真实临时仓库用 `git check-ignore --no-index -z --stdin` 验证“只匹配目标、不匹配邻近反例”；验证失败就不写。

- [ ] **Step 4: 选择项目级或本机级目标并写入**

`target=repository` 写仓库根 `.gitignore`，会成为普通 Working Tree Change；`target=local` 通过 `git rev-parse --git-path info/exclude` 定位本 Worktree 生效的私有 exclude。预览显示目标文件、精确新增行、是否已存在和可恢复位置。目标必须是普通文件或尚不存在；Symlink/Junction/Reparse Point 一律拒绝。

MutationCoordinator 将目标文件 bytes/mode/exists、所选路径状态和打开文档 version 纳入 VersionVector/Checkpoint。Dirty `.gitignore` 使用单次 `WorkspaceEdit` 追加最小 TextEdit 且不 Save；磁盘目标保持原 BOM/换行风格，在锁内重验 hash 后写同目录临时文件、Flush、原子 Rename，再验证 `check-ignore` 后置条件。重复 entry 是可见 No-op，不重复追加；外部抢写进入三方恢复。不得自动 Stage `.gitignore`。

- [ ] **Step 5: 运行 Pattern、CRLF、并发、恢复测试并提交**

Run: `npx vitest run packages/git-cli/src/ignore.test.ts && npm run test:integration -- tests/integration/patch/ignore.test.ts && npm run test:vscode -- --grep Ignore`

Expected: PASS；空格、`#`、`!`、`*?[]`、Unicode、CRLF/BOM、重复项、Dirty Editor、外部保存和恢复均通过；无法安全编码的换行名称只提供“手工打开 Ignore 文件”。

```bash
git add packages/git-cli/src/ignore.ts src/extension/mutations/ignoreService.ts src/extension/scm/sourceControl.ts packages/git-cli/src/ignore.test.ts tests/integration/patch/ignore.test.ts tests/vscode/suite/ignore.test.ts
git commit -m "feat: add recoverable exact-path ignore"
```

### Task 7: New Worktree 隔离目标

**Files:**
- Create: `src/extension/patch/newWorktreeTarget.ts`
- Test: `tests/integration/patch/new-worktree.test.ts`

- [ ] **Step 1: 写当前分支不切换测试**

```ts
it('applies in a new worktree without changing the current HEAD or files', async () => {
  const before = await fixture.snapshotCurrentWorktree();
  const result = await service.apply(selection, { kind: 'newWorktree', branchOid: targetOid, directoryUri: targetUri });
  expect(await fixture.snapshotCurrentWorktree()).toEqual(before);
  expect(result.worktreeUri).toBe(targetUri);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/patch/new-worktree.test.ts`

Expected: FAIL with missing target adapter。

- [ ] **Step 3: 实现显式目录与清理策略**

目录必须由用户选择，规范化后不得位于当前 Worktree 内；先 `git worktree add --detach -- <directory> <resolvedOid>`，再在新仓库 ID 上重新验证 Patch 并应用。创建成功但 Apply 失败时保留 Worktree 并提供“打开/移除”选择，不自动递归删除含用户修改的目录。

- [ ] **Step 4: 运行路径空格/UNC/失败保留测试并提交**

Run: `npm run test:integration -- tests/integration/patch/new-worktree.test.ts`

Expected: PASS on Windows UNC fixture where runner supports it；当前 Worktree generation 不因切换而变化。

```bash
git add src/extension/patch/newWorktreeTarget.ts tests/integration/patch/new-worktree.test.ts
git commit -m "feat: apply patches in isolated worktrees"
```

### Task 8: Reconcile、CAS Rollback 与 Recovery Center

**Files:**
- Create: `packages/transactions/src/reconcile.ts`
- Create: `packages/transactions/src/rollback.ts`
- Create: `src/extension/recovery/recoveryService.ts`
- Create: `src/extension/recovery/recoveryView.ts`
- Create: `webview/workbench/src/recovery/recoveryPanel.tsx`
- Test: `packages/transactions/src/rollback.test.ts`
- Test: `tests/vscode/suite/recovery.test.ts`

- [ ] **Step 1: 写 After Image 不匹配禁止回滚测试**

```ts
// packages/transactions/src/rollback.test.ts
import { expect, it } from 'vitest';
import { decideRollback } from './rollback.js';

it('never restores before-image over an external after-image', async () => {
  const encoder = new TextEncoder();
  const result = decideRollback(encoder.encode('base'), encoder.encode('ours'), encoder.encode('external'));
  expect(result.kind).toBe('needsAttention');
  if (result.kind === 'needsAttention') expect(new TextDecoder().decode(result.merge.external)).toBe('external');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/transactions/src/rollback.test.ts`

Expected: FAIL with missing rollback。

- [ ] **Step 3: 实现 CAS 补偿决策**

```ts
// packages/transactions/src/rollback.ts
export type RollbackDecision =
  | { readonly kind: 'restoreBefore' }
  | { readonly kind: 'alreadyRestored' }
  | { readonly kind: 'needsAttention'; readonly merge: { readonly base: Uint8Array; readonly ours: Uint8Array; readonly external: Uint8Array } };

export function decideRollback(base: Uint8Array, operationAfter: Uint8Array, current: Uint8Array): RollbackDecision {
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  if (same(current, operationAfter)) return { kind: 'restoreBefore' };
  if (same(current, base)) return { kind: 'alreadyRestored' };
  return { kind: 'needsAttention', merge: { base, ours: operationAfter, external: current } };
}
```

实际 Restore Before 也先对当前 bytes 做 CAS 重验；写完验证 hash。Binary 三方恢复只提供选择 Base/Ours/External/保存三份，不做文本合并。

- [ ] **Step 4: 实现启动 Reconcile 与恢复动作**

启动扫描非终结 Journal，读取 HEAD/Refs/Index/Git operation markers/文件 hash，计算 Continue、Rollback、Restore Checkpoint 或 NeedsAttention。Recovery View 显示 Operation、时间、仓库、状态、受影响文件、存储位置、保留期限、Pin 和删除入口；删除源码快照二次确认。

- [ ] **Step 5: 运行恢复 UI 与 CAS 测试并提交**

Run: `npx vitest run packages/transactions/src/rollback.test.ts && npm run test:vscode -- --grep Recovery`

Expected: PASS；任何自动恢复都无法覆盖 external bytes。

```bash
git add packages/transactions/src/reconcile.ts packages/transactions/src/rollback.ts src/extension/recovery webview/workbench/src/recovery tests
git commit -m "feat: reconcile and recover patch transactions"
```

### Task 9: Hunk/行 UI、故障注入与 Phase 3 门槛

**Files:**
- Create: `webview/workbench/src/compare/hunkSelection.ts`
- Create: `webview/workbench/src/compare/diffFile.tsx`
- Create: `tests/fault-injection/patch-transaction.test.ts`
- Create: `tests/e2e/patch-workflow.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 写键盘选择与 stale banner 测试**

Hunk checkbox、逐行 checkbox、全文件选择、反向方向和目标选择都必须有可访问名称。Generation/Whitespace 变化后 selected IDs 清空、Apply 按钮禁用、横幅显示“预览已过期”。

`apply.defaultTarget` 只初始化目标控件；`prompt` 总是要求选择。默认目标与当前 Patch 类型、Dirty Editor 或 capability 不兼容时必须回到 Prompt，不能静默切换并执行。

- [ ] **Step 2: 实现选择归一化**

```ts
// webview/workbench/src/compare/hunkSelection.ts
export function toggleLine(selected: ReadonlySet<string>, lineId: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(lineId)) next.delete(lineId); else next.add(lineId);
  return next;
}

export function clearUnsafeSelection(): ReadonlySet<string> {
  return new Set();
}
```

View Diff line ID 必须携带 Raw Hunk mapping；无法映射的 whitespace-collapsed 行不显示可写 checkbox，只允许选择完整 Raw Hunk。

- [ ] **Step 3: 在每个 Journal 状态点强杀进程**

Run: `npx vitest run tests/fault-injection/patch-transaction.test.ts --pool=forks --maxWorkers=1`

Expected: 重启后每个操作为 Committed、RolledBack 或 NeedsAttention；不存在静默部分成功；Checkpoint bytes 校验通过。

- [ ] **Step 4: 运行三目标 E2E**

Run: `npx vitest run tests/e2e/patch-workflow.test.ts --pool=forks --maxWorkers=1 && npm run test:vscode -- --grep Patch`

Expected: Index、Working Tree、New Worktree 的文件/Hunk/行路径全部 PASS；Dirty Editor 保持未保存。

- [ ] **Step 5: 运行 Phase 3 全量门槛并提交**

Run: `npm run check && npm run test:integration && npm run test:vscode && npx vitest run tests/property tests/fault-injection tests/e2e --pool=forks --maxWorkers=1 && npm run package`

Expected: 全部 exit 0；Bundle 与日志扫描确认不存在 `--reject`、`--unidiff-zero` 和旧快照覆盖入口。

```bash
git add webview/workbench/src/compare tests/fault-injection/patch-transaction.test.ts tests/e2e/patch-workflow.test.ts .github/workflows/ci.yml
git commit -m "test: enforce patch transaction recovery gates"
```
