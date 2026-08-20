# Git Workbench Daily Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已验证的只读模型上交付文件级 Stage/Unstage、Commit/Amend、分支、Stash、Fetch/Pull/Push 和安全删除，并确保所有写入口统一经过写队列、版本向量、预览、Journal 与后置校验。

**Architecture:** UI 只提交领域 Intent；`MutationCoordinator` 冻结配置、获取每仓库唯一写租约、重验 VersionVector、写入最小 Durable Journal、调用受限 Provider 并验证 Postcondition。Phase 2 的 Checkpoint 保存 Ref/Index/操作元数据；Phase 3 再增加 Working Tree 内容快照和恢复中心，因此 Phase 2 不提供会覆盖 Working Tree 的 Reset/Rebase/Hunk Apply。

**Tech Stack:** Foundation/Read Model 技术栈、系统 Git CLI、VS Code Commands/SCM/Progress API、Node 原子文件写、真实 bare remote 测试、系统 Credential Helper/SSH Agent

---

**Authoritative spec:** `docs/superpowers/specs/2026-08-20-git-workbench-vscode-extension-design.md`

## 前置条件与阶段出口

- Read Model 全量门槛已通过，Repository Generation 可可靠失效。
- 每个写操作必须产出 Plan → Confirmed → Journal → Provider → Verify 证据。
- Commit Hooks、Signing 和用户 Git 配置保持生效；没有 `--no-verify` 或测试参数泄漏。
- 网络结果未知时先 Reconcile；不自动重试 Pull/Push/Fetch。
- Phase 2 不实现 Hunk/行 Patch、历史 Reword、Reset/Rebase UI 或强推。
- 在 Phase 3 内容快照接入前，Pull 与 Stash Apply/Pop 只允许干净 Working Tree；脏分支切换只允许先创建已验证 Stash 或 New Worktree。`keep` 脏切换和任何无法证明不覆盖用户内容的入口保持禁用。

## 文件结构

```text
packages/domain/src/mutation.ts                 Intent、Plan、Postcondition
packages/domain/src/versionVector.ts            HEAD/Index/文件基线
packages/transactions/src/writeQueue.ts         进程内公平写队列
packages/transactions/src/repositoryLease.ts     跨窗口/进程 Common Git Dir 租约
packages/transactions/src/journal.ts            Durable Journal 状态机
packages/transactions/src/coordinator.ts        Mutation 模板方法
packages/transactions/src/refCheckpoint.ts      Ref/Index 元数据检查点
packages/git-cli/src/versionVector.ts            Git 状态采样
packages/git-cli/src/stage.ts                    文件级 Stage/Unstage
packages/git-cli/src/commit.ts                   Commit/Amend
packages/git-cli/src/branch.ts                   Branch/Switch/Upstream
packages/git-cli/src/stash.ts                    Stash 操作
packages/git-cli/src/commitActions.ts            Cherry-pick/Revert
packages/git-cli/src/remote.ts                   Fetch/Pull/Push/Reconcile
src/extension/mutations/mutationService.ts       Intent 到 Use Case
src/extension/mutations/confirmation.ts          影响预览与确认令牌
src/extension/scm/sourceControl.ts               原生 SCM UI
src/extension/credentials/askpass.ts             安全 AskPass 桥接
tests/integration/mutations/*.test.ts             Hook/Lock/并发/网络测试
```

### Task 1: 定义 Mutation、VersionVector 与确认合同

**Files:**
- Create: `packages/domain/src/versionVector.ts`
- Create: `packages/domain/src/mutation.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/validate.ts`
- Test: `packages/domain/src/mutation.test.ts`

- [ ] **Step 1: 写过期计划失败测试**

```ts
// packages/domain/src/mutation.test.ts
import { describe, expect, it } from 'vitest';
import { compareVersionVectors } from './versionVector.js';

describe('compareVersionVectors', () => {
  it('rejects a plan when HEAD, index or an affected file changed', () => {
    const base = { generation: 3, commonGeneration: 7, headOid: 'a', headName: 'main', indexFingerprint: 'i1', pausedOperation: 'none', refs: [{ ref: 'refs/heads/topic', oid: 'b' }], files: [{ path: 'a.ts', hash: 'h1', mode: '100644', exists: true }] } as const;
    expect(compareVersionVectors(base, { ...base, generation: 4 })).toContain('generation');
    expect(compareVersionVectors(base, { ...base, commonGeneration: 8 })).toContain('commonGeneration');
    expect(compareVersionVectors(base, { ...base, refs: [{ ref: 'refs/heads/topic', oid: 'c' }] })).toContain('ref:refs/heads/topic');
    expect(compareVersionVectors(base, { ...base, files: [{ ...base.files[0], hash: 'h2' }] })).toContain('file:a.ts');
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/domain/src/mutation.test.ts`

Expected: FAIL with missing contracts。

- [ ] **Step 3: 实现 VersionVector 与允许的 Intent 联合类型**

```ts
// packages/domain/src/versionVector.ts
export interface FileVersion {
  readonly path: string;
  readonly hash: string;
  readonly mode: string;
  readonly exists: boolean;
  readonly documentVersion?: number;
  readonly documentDirty?: boolean;
}

export interface VersionVector {
  readonly generation: number;
  readonly commonGeneration: number;
  readonly headOid?: string;
  readonly headName?: string;
  readonly indexFingerprint: string;
  readonly pausedOperation: 'none' | 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply';
  readonly refs: readonly { readonly ref: string; readonly oid?: string; readonly symbolicTarget?: string }[];
  readonly files: readonly FileVersion[];
}

export function compareVersionVectors(expected: VersionVector, actual: VersionVector): string[] {
  const mismatches: string[] = [];
  if (expected.generation !== actual.generation) mismatches.push('generation');
  if (expected.commonGeneration !== actual.commonGeneration) mismatches.push('commonGeneration');
  if (expected.headOid !== actual.headOid || expected.headName !== actual.headName) mismatches.push('head');
  if (expected.indexFingerprint !== actual.indexFingerprint) mismatches.push('index');
  if (expected.pausedOperation !== actual.pausedOperation) mismatches.push('pausedOperation');
  const actualRefs = new Map(actual.refs.map((ref) => [ref.ref, ref]));
  for (const ref of expected.refs) {
    const current = actualRefs.get(ref.ref);
    if (!current || ref.oid !== current.oid || ref.symbolicTarget !== current.symbolicTarget) mismatches.push(`ref:${ref.ref}`);
  }
  const actualFiles = new Map(actual.files.map((file) => [file.path, file]));
  for (const file of expected.files) {
    const current = actualFiles.get(file.path);
    if (!current || file.hash !== current.hash || file.mode !== current.mode || file.exists !== current.exists || file.documentVersion !== current.documentVersion || file.documentDirty !== current.documentDirty) mismatches.push(`file:${file.path}`);
  }
  return mismatches;
}
```

```ts
// packages/domain/src/mutation.ts
import type { CommonRepositoryId, OperationId, RepositoryId } from './ids.js';
import type { VersionVector } from './versionVector.js';

export type MutationIntent =
  | { readonly type: 'stage.files'; readonly paths: readonly string[] }
  | { readonly type: 'unstage.files'; readonly paths: readonly string[] }
  | { readonly type: 'files.delete'; readonly paths: readonly string[] }
  | { readonly type: 'files.ignore'; readonly paths: readonly string[]; readonly target: 'repository' | 'local' }
  | { readonly type: 'commit.create'; readonly message: string }
  | { readonly type: 'commit.amend'; readonly message: string }
  | { readonly type: 'branch.create'; readonly name: string; readonly startPoint: string; readonly switch: boolean }
  | { readonly type: 'branch.switch'; readonly name: string; readonly dirtyStrategy: 'keep' | 'stash' | 'newWorktree' }
  | { readonly type: 'branch.rename'; readonly oldName: string; readonly newName: string }
  | { readonly type: 'branch.delete'; readonly name: string }
  | { readonly type: 'branch.upstream'; readonly name: string; readonly upstream: string | null }
  | { readonly type: 'stash.create'; readonly message: string; readonly includeUntracked: boolean; readonly keepIndex: boolean; readonly stagedOnly: boolean }
  | { readonly type: 'stash.apply'; readonly selector: string; readonly dropAfterSuccess: boolean }
  | { readonly type: 'stash.drop'; readonly selector: string }
  | { readonly type: 'stash.branch'; readonly selector: string; readonly branchName: string }
  | { readonly type: 'commit.cherryPick'; readonly oids: readonly string[] }
  | { readonly type: 'commit.revert'; readonly oids: readonly string[] }
  | { readonly type: 'partialClone.materialize'; readonly contentToken: string }
  | { readonly type: 'remote.fetch'; readonly remote: string; readonly prune: boolean }
  | { readonly type: 'remote.pull'; readonly remote: string; readonly branch: string; readonly strategy: 'ffOnly' | 'merge' | 'rebase' }
  | { readonly type: 'remote.push'; readonly remote: string; readonly localRef: string; readonly remoteRef: string };

export interface MutationPlan {
  readonly operationId: OperationId;
  readonly repositoryId: RepositoryId;
  readonly commonRepositoryId: CommonRepositoryId;
  readonly intent: MutationIntent;
  readonly baseline: VersionVector;
  readonly summary: string;
  readonly effects: readonly string[];
  readonly risk: 'normal' | 'confirmation';
  readonly configFingerprint: string;
  readonly planDigest: string;
}
```

`configFingerprint` 是 Host 在 Plan 时对“本操作读取到的完整 Effective Settings + Capability Snapshot + Safety Policy 版本”做 canonical JSON 后的 SHA-256；不包含凭据或任意环境变量。执行期间不重新吸收 Settings 变化，预检若当前 fingerprint 不同则返回 `STALE_PLAN`。`planDigest` 再覆盖整个 Plan（包括 `configFingerprint`），两者用途不可混用。

协议仅接受上述判别联合，限制 Commit/Stash message 字节数、路径数量与字符串长度；确认请求只传 `operationId + planDigest`，不能由 UI 修改 Plan。`contentToken` 是 Host 生成的短期随机句柄，只能解析到当前 Repository Generation 下已预检的 Promisor Remote 与 Missing OID 集合；Webview 不能提交 OID、Remote 或 Git 参数来物化任意对象。`files.ignore` 在 Phase 2 只有合同、没有可执行 capability；必须等 Phase 3 完整内容 Checkpoint 接入后才注册 UI/Provider。

- [ ] **Step 4: 运行合同测试并提交**

Run: `npx vitest run packages/domain/src packages/protocol/src`

Expected: PASS；任意 `args`、普通 `--force`、Reset/Rebase Intent 被拒绝。

```bash
git add packages/domain packages/protocol
git commit -m "feat: define safe mutation plans"
```

### Task 2: 实现写队列、Durable Journal 与最小 Checkpoint

**Files:**
- Modify: `packages/transactions/package.json`
- Modify: `packages/transactions/tsconfig.json`
- Create: `packages/transactions/src/writeQueue.ts`
- Create: `packages/transactions/src/repositoryLease.ts`
- Create: `packages/transactions/src/journal.ts`
- Create: `packages/transactions/src/refCheckpoint.ts`
- Create: `packages/transactions/src/index.ts`
- Test: `packages/transactions/src/writeQueue.test.ts`
- Test: `packages/transactions/src/repositoryLease.test.ts`
- Test: `packages/transactions/src/journal.test.ts`

- [ ] **Step 1: 写串行与崩溃记录失败测试**

```ts
// packages/transactions/src/writeQueue.test.ts
import { describe, expect, it } from 'vitest';
import { RepositoryWriteQueue } from './writeQueue.js';

it('serializes writers across linked worktrees sharing one common repository and releases after failure', async () => {
  const queue = new RepositoryWriteQueue();
  const order: string[] = [];
  const first = queue.run('common-repo', async () => { order.push('a:start'); await Promise.resolve(); order.push('a:end'); throw new Error('fail'); });
  const second = queue.run('common-repo', async () => { order.push('b'); });
  await expect(first).rejects.toThrow('fail');
  await second;
  expect(order).toEqual(['a:start', 'a:end', 'b']);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/transactions/src`

Expected: FAIL with missing queue/journal。

- [ ] **Step 3: 实现仓库级 Promise Chain 写队列**

```ts
// packages/transactions/src/writeQueue.ts
export class RepositoryWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(commonRepositoryId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(commonRepositoryId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(commonRepositoryId, tail);
    return result.finally(() => {
      if (this.tails.get(commonRepositoryId) === tail) this.tails.delete(commonRepositoryId);
    });
  }
}
```

MutationCoordinator 从 Registry 取得受信任 Descriptor 后只用 `commonRepositoryId` 作为队列键，绝不接受 UI 传入锁键。内存队列只负责当前 Extension Host 的公平性；随后必须获取 `<canonical-common-git-dir>/git-workbench/locks/write` 原子目录租约，才能覆盖两个 VS Code 窗口、不同 Profile/Extension Host 进程和 Linked Worktree 的复合事务。Owner 记录随机 Token、Operation ID、主机身份、PID/进程启动身份和 Heartbeat，只能释放自己的 Token；逐级 `lstat` 拒绝 Symlink/Junction/Reparse Point。崩溃租约仅在 Heartbeat 超时、同一主机进程身份已不存在、Journal 已 Reconcile 且目录成功原子移入 quarantine 后回收；证据不足则返回 `REPOSITORY_LOCKED` 并打开恢复中心，绝不通过删除未知 Lock“解卡”。无法创建可信跨进程租约时禁用插件写 capability，而不是退化为单窗口假保证。

测试创建两个真实 Linked Worktree，并启动两个 child Extension Host fixture 同时发 Commit/Fetch/Branch 操作，断言 Provider 并发峰值仍为 1、崩溃后先 Reconcile 再接管；不同 Common Git Dir 允许并发。写前暂停同组 Worktree 的新后台读，终结后统一 Resume/失效共享 Ref Cache。该插件租约绝不删除或替代 `index.lock`、Ref Lock 等 Git 自身 Lock，外部 Git 仍靠 VersionVector/CAS 防护。

- [ ] **Step 4: 实现校验和 Journal 状态机**

```ts
// packages/transactions/src/journal.ts
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type JournalState = 'Planned' | 'Preflight' | 'Rejected' | 'Cancelled' | 'Checkpointed' | 'Running' | 'Paused' | 'Verifying' | 'Committed' | 'RollingBack' | 'RolledBack' | 'NeedsAttention';
export type JournalDetail =
  | { readonly kind: 'reason'; readonly reasonCode: 'stale-plan' | 'preflight-failed' | 'checkpoint-failed' | 'provider-threw' | 'unknown-result' | 'postcondition' | 'reconciliation-failed' | 'rollback-failed' | 'cas-failed' | 'hook-failed' | 'auth-cancelled' | 'cancelled-before-run' }
  | { readonly kind: 'paused'; readonly operationKind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply'; readonly step: number }
  | { readonly kind: 'effects'; readonly refCount: number; readonly pathCount: number; readonly effectsDigest: string };
export interface JournalRecord { readonly schema: 1; readonly operationId: string; readonly state: JournalState; readonly sequence: number; readonly repositoryId: string; readonly planDigest: string; readonly updatedAt: string; readonly detail?: JournalDetail }

export class DurableJournal {
  constructor(private readonly root: string) {}

  async append(record: JournalRecord): Promise<void> {
    const repositorySegment = createHash('sha256').update(record.repositoryId).digest('hex');
    const operationSegment = createHash('sha256').update(record.operationId).digest('hex');
    const directory = join(this.root, repositorySegment, operationSegment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(record);
    const envelope = JSON.stringify({ checksum: createHash('sha256').update(body).digest('hex'), body });
    const payload = `${envelope}\n`;
    const target = join(directory, `${String(record.sequence).padStart(6, '0')}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(target, 'utf8') !== payload) throw error;
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    await syncDirectoryIfSupported(dirname(target));
  }
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(code)) throw error;
    // Capability Probe/Diagnostics 记录 directoryFsync=false；Journal 文件本身仍已 flush。
  } finally {
    await handle?.close();
  }
}
```

写入前用 JSON Schema 校验 `JournalDetail`、OID/digest/计数范围和 64 KiB 单条硬上限，拒绝任意 stderr、URL、绝对路径、Commit Message、Diff/源码或环境对象；负数/重复/回退的 sequence 同样拒绝。已 Flush 临时文件通过同目录 hard-link no-replace 发布，最终文件已存在时只接受字节完全相同的幂等重放，否则标记 Journal Corrupt，不覆盖。Windows/不支持目录 `fsync` 的文件系统将该步骤记录为 capability；文件本身 Flush、校验和与单调 sequence 仍为必需。启动 Reconcile 只读取校验正确的完整 generation 文件，并且只在确认没有对应活跃进程后清理随机 `.tmp` 残留。状态机合同测试覆盖合法边、禁止回退、`Rejected/Cancelled` 终态和 RollingBack 失败转 `NeedsAttention`。

- [ ] **Step 5: 实现 Ref/Index 精确 Checkpoint**

Checkpoint 保存 HEAD/分支/目标 Ref OID、未合并 stage 指纹和受影响路径清单，并通过 `git rev-parse --git-path index` 定位后复制完整 Index bytes、mode、exists、SHA-256；若 Index 使用 split-index，同时保存并校验其引用的 `sharedindex.<oid>`。恢复不能只靠 Tree OID，因为那会丢失 stage、intent-to-add、skip-worktree 等 Index 语义。Recovery Ref 使用 `refs/git-workbench/recovery/<operationId>/head` + expected old OID 创建。

Index 恢复必须遵循 Git Lockfile 协议：先以 `open(index.lock, 'wx')` 独占创建插件自有 Lock；`EEXIST` 立即返回 `REPOSITORY_LOCKED`，绝不读取后删除未知 Lock。成功持锁后再读取并确认当前 Index hash/exists 仍等于本操作 After Image，把已校验 Checkpoint bytes 写入该 Lock、Flush，然后同目录原子 Rename 为 Index 并 Flush 可支持的父目录；CAS 不成立则只关闭并删除本进程持有的 Lock，进入三方恢复。测试在“锁前/锁后重验/Flush/Rename”各点注入外部 Git，证明不会覆盖抢先写入的 Index。Phase 2 不复制 Working Tree 源码，因此任何可能覆盖未检查点用户内容的 Plan 必须被策略拒绝。

- [ ] **Step 6: 注入每个 Journal 状态点的强杀测试并提交**

Run: `npx vitest run packages/transactions/src --pool=forks --maxWorkers=1`

Expected: PASS；每个写入点重启后得到最后一个完整状态或前一完整状态，不解析半个 JSON。

```bash
git add packages/transactions
git commit -m "feat: journal daily Git mutations"
```

### Task 3: 实现 VersionVector 采样与 MutationCoordinator

**Files:**
- Create: `packages/git-cli/src/versionVector.ts`
- Create: `packages/transactions/src/coordinator.ts`
- Test: `packages/transactions/src/coordinator.test.ts`
- Test: `tests/integration/mutations/stale-plan.test.ts`

- [ ] **Step 1: 写 Hook/外部 Git 使计划过期的失败测试**

```ts
// packages/transactions/src/coordinator.test.ts
import { expect, it, vi } from 'vitest';
import { MutationCoordinator } from './coordinator.js';

it('does not execute when preflight differs from the preview baseline', async () => {
  const execute = vi.fn();
  const coordinator = fixtureCoordinator({ currentVector: changedVector, execute });
  await expect(coordinator.execute(plan, confirmation)).rejects.toMatchObject({ payload: { code: 'STALE_PLAN' } });
  expect(execute).not.toHaveBeenCalled();
});
```

测试文件内显式定义 `plan`、`confirmation`、`changedVector` 和 `fixtureCoordinator`，使用内存 Ports，不依赖未声明全局。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/transactions/src/coordinator.test.ts`

Expected: FAIL with missing coordinator。

- [ ] **Step 3: 实现采样端口**

`captureVersionVector` 通过以下事实构造指纹：

- `symbolic-ref -q HEAD` 与 `rev-parse --verify HEAD`。
- 通过 `git rev-parse --git-path index` 定位后，对 Index 的完整原始 bytes、exists、mode/文件身份以及 split-index 引用的 `sharedindex.<oid>` bytes 计算 canonical SHA-256；这会覆盖 stage、Intent-to-add、skip-worktree、assume-unchanged 与扩展数据。读取前后 `lstat` 身份/size/mtime 不一致时有界重读，仍不稳定则返回 `STALE_PLAN`。不能用会刷新 Index 的命令，也不能只哈希 `ls-files --stage -z` 而漏掉 flags。
- `MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD` 通过 Git rev-parse/操作目录 capability 判断。
- Plan 声明的每个完整目标/来源 Ref 用 `for-each-ref`/`symbolic-ref` 逐项读取 OID、存在状态和 symbolic target；不存在也作为 `oid=undefined` 的前置条件，不能只相信 File Watcher/common generation。
- 受影响文件读取 bytes、mode、exists；已打开文档由 VS Code Adapter 补充 version/dirty。

- [ ] **Step 4: 实现统一 Coordinator**

```ts
// packages/transactions/src/coordinator.ts
import { GitWorkbenchError, compareVersionVectors, type MutationPlan } from '@git-workbench/domain';
import type { DurableJournal } from './journal.js';
import type { RepositoryWriteQueue } from './writeQueue.js';

export interface MutationPorts {
  withRepositoryLease<T>(plan: MutationPlan, action: () => Promise<T>): Promise<T>;
  capture(plan: MutationPlan): Promise<{ readonly baseline: MutationPlan['baseline']; readonly configFingerprint: string }>;
  checkpoint(plan: MutationPlan): Promise<void>;
  invoke(plan: MutationPlan): Promise<
    | { readonly outcome: 'success'; readonly afterImage?: unknown }
    | { readonly outcome: 'paused'; readonly paused: { readonly operationKind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply'; readonly step: number } }
    | { readonly outcome: 'unknown' }
  >;
  verify(plan: MutationPlan): Promise<boolean>;
  reconcileFailure(plan: MutationPlan, error: unknown): Promise<
    | { readonly outcome: 'committed' | 'rollback' | 'needsAttention' }
    | { readonly outcome: 'paused'; readonly paused: { readonly operationKind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply'; readonly step: number } }
  >;
  rollbackAfterFailure(plan: MutationPlan, error: unknown): Promise<void>;
  bumpGenerations(repositoryId: string, commonRepositoryId: string): void;
}

export class MutationCoordinator {
  constructor(private readonly queue: RepositoryWriteQueue, private readonly journal: DurableJournal, private readonly ports: MutationPorts) {}

  execute(plan: MutationPlan, confirmation: { readonly operationId: string; readonly planDigest: string }): Promise<void> {
    if (confirmation.operationId !== plan.operationId || confirmation.planDigest !== plan.planDigest) {
      return Promise.reject(new GitWorkbenchError({ code: 'INVALID_INPUT', operationId: String(plan.operationId), message: '确认令牌无效', repositoryChanged: false, retry: 'refresh' }));
    }
    return this.queue.run(String(plan.commonRepositoryId), () => this.ports.withRepositoryLease(plan, async () => {
      let sequence = 0;
      const record = (state: import('./journal.js').JournalState, detail?: import('./journal.js').JournalDetail) => this.journal.append({
        schema: 1,
        operationId: String(plan.operationId),
        state,
        sequence: sequence++,
        repositoryId: String(plan.repositoryId),
        planDigest: plan.planDigest,
        updatedAt: new Date().toISOString(),
        ...(detail ? { detail } : {}),
      });
      const settleFailure = async (error: unknown, reasonCode: 'provider-threw' | 'unknown-result' | 'postcondition'): Promise<'committed' | 'paused' | 'failed'> => {
        await record('Verifying', { kind: 'reason', reasonCode });
        let reconciliation: Awaited<ReturnType<MutationPorts['reconcileFailure']>>;
        try {
          reconciliation = await this.ports.reconcileFailure(plan, error);
        } catch {
          await record('NeedsAttention', { kind: 'reason', reasonCode: 'reconciliation-failed' });
          this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
          return 'failed';
        }
        if (reconciliation.outcome === 'committed') {
          this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
          await record('Committed');
          return 'committed';
        }
        if (reconciliation.outcome === 'paused') {
          this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
          await record('Paused', { kind: 'paused', ...reconciliation.paused });
          return 'paused';
        }
        if (reconciliation.outcome === 'rollback') {
          await record('RollingBack');
          try {
            await this.ports.rollbackAfterFailure(plan, error);
            await record('RolledBack');
          } catch {
            await record('NeedsAttention', { kind: 'reason', reasonCode: 'rollback-failed' });
          }
        } else {
          await record('NeedsAttention');
        }
        this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
        return 'failed';
      };
      await record('Planned');
      await record('Preflight');
      let actual: Awaited<ReturnType<MutationPorts['capture']>>;
      try {
        actual = await this.ports.capture(plan);
      } catch (error) {
        await record('Rejected', { kind: 'reason', reasonCode: 'preflight-failed' });
        throw error instanceof GitWorkbenchError ? error : new GitWorkbenchError({
          code: 'PARSER_UNSUPPORTED',
          operationId: String(plan.operationId),
          message: '无法可靠读取执行前仓库状态',
          repositoryChanged: false,
          retry: 'refresh',
        });
      }
      const mismatches = compareVersionVectors(plan.baseline, actual.baseline);
      if (actual.configFingerprint !== plan.configFingerprint) mismatches.push('configuration');
      if (mismatches.length) {
        await record('Rejected', { kind: 'reason', reasonCode: 'stale-plan' });
        throw new GitWorkbenchError({ code: 'STALE_PLAN', operationId: String(plan.operationId), message: `计划已过期：${mismatches.join(', ')}`, repositoryChanged: true, retry: 'refresh' });
      }
      try {
        await this.ports.checkpoint(plan);
      } catch (error) {
        await record('NeedsAttention', { kind: 'reason', reasonCode: 'checkpoint-failed' });
        this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
        throw error instanceof GitWorkbenchError ? error : new GitWorkbenchError({
          code: 'POSTCONDITION_FAILED',
          operationId: String(plan.operationId),
          message: '恢复检查点未能完整建立，需要检查恢复数据',
          repositoryChanged: true,
          retry: 'reconcile',
        });
      }
      await record('Checkpointed');
      await record('Running');
      let result: Awaited<ReturnType<MutationPorts['invoke']>>;
      try {
        result = await this.ports.invoke(plan);
      } catch (error) {
        const typed = error instanceof GitWorkbenchError ? error : new GitWorkbenchError({
          code: 'POSTCONDITION_FAILED',
          operationId: String(plan.operationId),
          message: 'Git 写操作异常结束，需要对账',
          repositoryChanged: true,
          retry: 'reconcile',
        });
        if (await settleFailure(typed, 'provider-threw') !== 'failed') return;
        throw typed;
      }
      if (result.outcome === 'unknown') {
        const error = new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', operationId: String(plan.operationId), message: '操作结果未知，需要对账', repositoryChanged: true, retry: 'reconcile' });
        if (await settleFailure(error, 'unknown-result') !== 'failed') return;
        throw error;
      }
      if (result.outcome === 'paused') {
        this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
        await record('Paused', { kind: 'paused', ...result.paused });
        return;
      }
      await record('Verifying');
      if (!(await this.ports.verify(plan))) {
        const error = new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', operationId: String(plan.operationId), message: '后置状态与计划不一致', repositoryChanged: true, retry: 'reconcile' });
        if (await settleFailure(error, 'postcondition') !== 'failed') return;
        throw error;
      }
      this.ports.bumpGenerations(String(plan.repositoryId), String(plan.commonRepositoryId));
      await record('Committed');
    }));
  }
}
```

异常处理器在 catch 中重新采样实际状态；只有 Checkpoint restore 的 CAS 前置条件成立时写 `RollingBack/RolledBack`，否则写 `NeedsAttention` 并重新抛出 Typed Error。

取消语义按状态固定：Provider 启动前可取消，Journal 追加 `Cancelled/cancelled-before-run` 并以“未写入”终结；Mutation 子进程启动后，“停止等待”只关闭进度 UI、继续后台 Drain 并最终 Verify/Reconcile，不能把 Kill 误报成取消成功。用户显式选择“强制终止进程”时先警告结果可能未知，终止后直接写 `NeedsAttention` 并 Reconcile，绝不自动重试同一写命令。

- [ ] **Step 5: 运行并发集成测试并提交**

Run: `npx vitest run packages/transactions/src/coordinator.test.ts tests/integration/mutations/stale-plan.test.ts --pool=forks --maxWorkers=1`

Expected: PASS；预览后外部 Commit/Stage/文件保存均返回 `STALE_PLAN`，没有 Git 写命令执行。

```bash
git add packages/git-cli/src/versionVector.ts packages/transactions/src/coordinator.ts packages/transactions/src/coordinator.test.ts tests/integration/mutations/stale-plan.test.ts
git commit -m "feat: coordinate guarded Git mutations"
```

### Task 4: 文件级 Stage/Unstage、Commit/Amend 与安全删除

**Files:**
- Create: `packages/git-cli/src/stage.ts`
- Create: `packages/git-cli/src/commit.ts`
- Create: `src/extension/mutations/mutationService.ts`
- Create: `src/extension/scm/sourceControl.ts`
- Test: `tests/integration/mutations/commit.test.ts`
- Test: `tests/vscode/suite/scm.test.ts`

- [ ] **Step 1: 写 Hook 生效和 Smart Commit 默认关闭测试**

```ts
// tests/integration/mutations/commit.test.ts
it('keeps hooks enabled and never stages unstaged files implicitly', async () => {
  await fixture.installHook('commit-msg', 'exit 23');
  await fixture.write('unstaged.txt', 'not reviewed');
  await expect(service.commit({ message: 'message', smartCommit: false })).rejects.toMatchObject({ exitCode: 23 });
  expect(await fixture.isStaged('unstaged.txt')).toBe(false);
  expect(await fixture.head()).toBe(initialHead);
});
```

测试内创建真实可执行 Hook；Windows 使用 `.exe` test helper 或 Git for Windows 可执行 shell hook，不能跳过该平台。另建含 Summary/Body/注释提示的真实 `commit.template`，断言 Trusted Workspace 的新 Commit 表单按字节预算加载为初始值、取消不写入、确认后实际 Message 与预览一致；Untrusted Workspace 不读取模板且本来就不开放 Commit。

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/mutations/commit.test.ts`

Expected: FAIL because mutation service 不存在。

- [ ] **Step 3: 实现文件级 Stage/Unstage Provider**

所有路径先做数量/总字节预算，再编码为 NUL stdin；Stage 单次执行 `git --literal-pathspecs add --pathspec-from-file=- --pathspec-file-nul`，Unstage 在存在 HEAD 时单次执行 `git --literal-pathspecs restore --staged --source=HEAD --pathspec-from-file=- --pathspec-file-nul`，Unborn Branch 单次执行 `git --literal-pathspecs rm --cached --ignore-unmatch --pathspec-from-file=- --pathspec-file-nul`。因此正常失败由同一个 Index Lock 全成或全败，不按平台拆成可部分成功的批次。测试必须包含名为 `:(exclude)*`、`-n`、Tab、换行和 Unicode 的真实文件。

- [ ] **Step 4: 实现 Commit/Amend**

```ts
// packages/git-cli/src/commit.ts
export async function commit(provider: MutationGitProvider, input: { readonly message: string; readonly amend: boolean }): Promise<void> {
  if (!input.message.trim()) throw new Error('commit message is empty');
  const args = ['commit', '--file=-', '--cleanup=verbatim'];
  if (input.amend) args.push('--amend');
  const result = await provider.mutate(args, Buffer.from(`${input.message.replace(/\r\n/g, '\n')}\n`, 'utf8'));
  if (result.exitCode !== 0) throw new GitCommandFailure(result.exitCode, result.stderr);
}
```

不得加入 `--no-verify`、`--no-gpg-sign`、`--author` 或覆盖用户环境。`--cleanup=verbatim` 保证 UI 输入不会因 `#` 行被 Git 隐式清理；Commit Hook 若合法修改 Message，后置校验展示实际 Message 与 Hook 结果，不伪报原文本。Amend 预览必须标注旧 Commit 签名将失效；执行后读取新 OID 并验证 Parent/Tree/Message。

打开新 Commit 表单时通过只读 `git config --path --get commit.template` 获取生效模板路径，由 Remote/Local Extension Host 在原环境读取，限制为普通文件、256 KiB、支持的文本编码，不跟随 HTTP/自定义 URI。模板内容只是本次表单初始值，不修改 Git 配置；由于提交固定使用 `--cleanup=verbatim`，UI 必须把最终将提交的完整文本（包括模板中的注释提示行）原样预览，不能假装 Git 会替用户删掉。模板不存在、超限、编码不支持或读取竞态只显示可恢复诊断并提供空表单，不阻塞手工 Commit。

`commit.smartCommit` 只作为新 Commit 表单的初始开关；默认 `false` 时绝不隐式 Stage，用户本次修改不自动写回 Setting。即使开启，也先列出将 Stage 的确切文件并把范围写入 Plan。

Smart Commit 是同一个 Journal 下的“Checkpoint Index → Stage 已确认的全部 tracked paths → Commit → Verify”复合操作。Commit/Hook/Signing 失败且当前 Index 仍精确等于 Smart Stage 的 After Image 时，使用本计划的 owned `index.lock` CAS 恢复原 Index；Hook 产生的 Working Tree 文件变化始终保留并显示。若 Hook 或外部程序又改了 Index，则不自动 Unstage/覆盖，进入 NeedsAttention，并提供“保留当前 Index / 三方检查后恢复”动作。故障测试覆盖 Stage 后强杀、Hook 改 Index 后失败和 Signing 取消，不能把“Commit 未创建但全部文件仍被隐式 Stage”静默当成完整失败。

- [ ] **Step 5: 实现安全删除**

- Tracked 文件若已经从磁盘删除，只 Stage 现有删除状态，不再次触碰路径；用户主动删除仍干净的 Tracked 文件时先移入系统 Trash（Remote 无 Trash 则复制到私有 Recovery 并校验 hash），再 Stage 删除。
- Tracked 文件含未暂存修改时，Phase 2 禁止主动删除；Phase 3 完整内容 Checkpoint 接入后才允许“快照 → Trash/Recovery → Stage”，并沿用 After Image CAS。
- 用户主动删除 Untracked：本地 `vscode.workspace.fs.delete(uri,{useTrash:true})`；Remote 或 Provider 不支持 Trash 时，先复制到 Extension `globalStorageUri/recovery/deleted/<operationId>`，校验 hash 后删除。
- 目录递归删除逐项预览；不提供 `git clean` 快捷入口。

- [ ] **Step 6: 运行 Hook/Signing/Unborn/Trash 测试并提交**

Run: `npm run test:integration -- tests/integration/mutations/commit.test.ts && npm run test:vscode -- --grep SCM`

Expected: PASS；Hook 失败保留输出和其产生的文件变化，UI 不宣称成功。

```bash
git add packages/git-cli/src/stage.ts packages/git-cli/src/commit.ts src/extension/mutations src/extension/scm tests/integration/mutations/commit.test.ts tests/vscode/suite/scm.test.ts
git commit -m "feat: add guarded staging and commits"
```

### Task 5: 分支与脏工作区切换策略

**Files:**
- Create: `packages/git-cli/src/branch.ts`
- Create: `src/extension/mutations/branchService.ts`
- Test: `tests/integration/mutations/branch.test.ts`

- [ ] **Step 1: 写恶意分支名和脏切换失败测试**

```ts
it('validates branch names with Git and never treats them as options', async () => {
  await expect(service.createBranch('-c core.sshCommand=evil', 'HEAD')).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  expect(await fixture.branchExists('-c core.sshCommand=evil')).toBe(false);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/mutations/branch.test.ts`

Expected: FAIL with missing branch service。

- [ ] **Step 3: 实现 Git 校验和明确命令**

Branch 名先执行 `git check-ref-format --branch <name>`；创建用 `git branch --no-track -- <name> <resolvedOid>`，切换用 `git switch -- <name>`。重命名先冻结 old ref/OID，校验 new name 后使用 `git branch --move -- <old> <new>`，并在大小写不敏感文件系统覆盖 Case-only 名称与外部抢先创建目标 Ref；失败时重验两个 Ref，不自行移动 `.git/refs` 文件。删除前读取 merged/unmerged、upstream、其他 Worktree 占用和 protectedBranches，只执行非强制 `git branch --delete -- <name>`；普通 UI 不提供强制删除受保护或未合并分支。

Upstream 只能从已枚举 Remote-tracking Ref DTO 选择：设置使用 `git branch --set-upstream-to <validatedUpstream> -- <name>`，清除使用 `git branch --unset-upstream -- <name>`；执行前后验证 Local Branch OID 不变且 upstream 恰好符合 Plan。Rename/Delete/Upstream 都经过同一个 MutationCoordinator、VersionVector 与保护分支策略，不能从 Tree View 快捷入口绕过。

脏策略：

- `keep`：Provider 和测试在本阶段实现，但 UI 直到 Phase 3 完整内容 Checkpoint 接入后才启用；预检 `git switch`，冲突则不修改。
- `stash`：创建带 Operation ID 的 Stash，切换成功后按用户选择保留或 Apply；失败保留 Stash。
- `newWorktree`：解析显式目录后调用 `git worktree add -- <path> <oid>`，不切当前工作区。

`branch.dirtyWorktreeStrategy` 只预选上述策略；值为 `prompt` 或预选策略不满足当前 capability/安全前置条件时仍弹出选择，不静默改用更具破坏性的方案。

- [ ] **Step 4: 运行 Case-only/Detached/Unborn/Worktree 测试并提交**

Run: `npm run test:integration -- tests/integration/mutations/branch.test.ts`

Expected: PASS on case-sensitive and case-insensitive runners；Create/Switch/Rename/Delete/Set/Clear Upstream 均通过；Worktree 占用分支不可重复 checkout，Case-only Rename 不丢 Ref。

```bash
git add packages/git-cli/src/branch.ts src/extension/mutations/branchService.ts tests/integration/mutations/branch.test.ts
git commit -m "feat: add guarded branch workflows"
```

### Task 6: Stash Create/Preview/Apply/Pop/Drop/Create Branch

**Files:**
- Create: `packages/git-cli/src/stash.ts`
- Create: `src/extension/mutations/stashService.ts`
- Test: `tests/integration/mutations/stash.test.ts`

- [ ] **Step 1: 写 Pop 冲突保留 Stash 测试**

```ts
it('uses native pop and keeps the stash when application conflicts', async () => {
  const selector = await fixture.createConflictingStash();
  await expect(service.apply({ selector, dropAfterSuccess: true })).rejects.toMatchObject({ payload: { code: 'CONFLICT_PAUSED' } });
  expect(await fixture.stashExists(selector)).toBe(true);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/mutations/stash.test.ts`

Expected: FAIL with missing stash service。

- [ ] **Step 3: 实现 OID 锁定的 Stash 操作**

- Create：`git stash push -m <message>`，按选项增加 `--include-untracked`、`--keep-index` 或 `--staged`；创建前后通过 `refs/stash` OID 验证。
- Preview：只读比较 Stash Commit 与其 parent，不执行 Apply。
- Apply：把 UI selector 先解析为 Stash OID，再 `git stash apply <oid>`。
- Pop：执行前保存 selector→OID 映射并立即重验，随后使用 Git 原生 `git stash pop <selector>`；Git 仅在应用成功时删除对应 Stash，冲突时保留。命令后再次枚举 Reflog 验证删除的是确认的 OID；无法确认则进入 Needs Attention，绝不再次 Drop。
- Drop/Create Branch：预览将删除的 OID 或新分支目标，分别使用显式 `stash.drop`/`stash.branch` Intent；执行前按当前 `refs/stash` 重验 selector→OID。Create Branch 的分支名仍经 `check-ref-format --branch`，失败或冲突不得 Drop Stash。

Phase 2 的 Apply/Pop 要求当前 Working Tree/Index 干净；Phase 3 把受影响内容纳入 Checkpoint 后，才允许与现有本地修改组合。

`stash.includeUntracked` 只初始化 Create 表单；确认摘要始终列出实际包含的 Untracked 路径/数量与超限状态，用户本次切换不隐式持久化。

- [ ] **Step 4: 运行 Untracked/KeepIndex/StagedOnly/冲突测试并提交**

Run: `npm run test:integration -- tests/integration/mutations/stash.test.ts`

Expected: PASS；任何 Apply 冲突都保留 Stash 并生成 Paused 状态。

```bash
git add packages/git-cli/src/stash.ts src/extension/mutations/stashService.ts tests/integration/mutations/stash.test.ts
git commit -m "feat: add recoverable stash workflows"
```

### Task 7: 从 DAG 安全发起 Cherry-pick 与 Revert

**Files:**
- Create: `packages/git-cli/src/commitActions.ts`
- Create: `src/extension/mutations/commitActionService.ts`
- Test: `tests/integration/mutations/commit-actions.test.ts`
- Test: `tests/fault-injection/commit-actions.test.ts`

- [ ] **Step 1: 写过期 OID、顺序和中途冲突失败测试**

```ts
it('keeps the confirmed order and resumes the same journal after a conflict', async () => {
  const plan = await service.planCherryPick([firstOid, secondOid]);
  await fixture.moveDisplayedBranchWithoutRemovingObjects();
  const result = await service.execute(plan);
  expect(result.kind).toBe('paused');
  expect(result.operation.kind).toBe('cherryPick');
  expect(result.operation.originalHead).toBe(plan.baseline.headOid);
  expect(result.operation.remainingOids).toContain(secondOid);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/mutations/commit-actions.test.ts`

Expected: FAIL with missing commit action service。

- [ ] **Step 3: 实现 OID 锁定的 Sequencer 启动**

DAG 选择先在 Host 解析为完整 Commit OID，限制 1–100 个并保持用户确认的顺序；协议不接受 Ref 表达式、范围语法或参数。Phase 2 只在 Working Tree/Index 干净、无既有 PausedOperation 时开放，执行前创建 Ref/Index Checkpoint 并再次验证每个 OID 仍存在且类型为 Commit。Merge Commit 默认拒绝并解释需要 Mainline；V1 不猜 `-m` Parent。

Cherry-pick 单次执行 `git cherry-pick -- <confirmedOids...>`；Revert 单次执行 `git revert --no-edit -- <confirmedOids...>`。不得加入 `--no-verify` 或关闭 Signing。成功后逐个验证新增 Commit 的 Patch-ID/Parent 和最终 HEAD；冲突读取 `CHERRY_PICK_HEAD`/`REVERT_HEAD` 与 Sequencer 实际状态，把原 Journal 推进为 `Paused`，由 Phase 4 Continue/Skip/Abort 接管。进程终止或结果未知时先采样 HEAD/Sequencer/Reflog 再分类，绝不重新执行整个 OID 列表。

- [ ] **Step 4: 接入 DAG 上下文菜单与影响预览**

预览显示动作、Commit 数量与顺序、当前 HEAD、预期新 Commit、签名/Hook 可能性、冲突与恢复位置。Revert 明确说明“创建反向 Commit，不删除历史”；Cherry-pick 明确说明“复制变更并产生新 OID”。按钮和 Command Palette 只提交 sealed `operationId + planDigest`。

- [ ] **Step 5: 运行冲突、Hook、Signing、强杀测试并提交**

Run: `npm run test:integration -- tests/integration/mutations/commit-actions.test.ts && npx vitest run tests/fault-injection/commit-actions.test.ts --pool=forks --maxWorkers=1`

Expected: PASS；普通成功、第二个 Commit 冲突、Hook 失败、Signing 取消和每个强杀点都归类为 Committed/Paused/NeedsAttention 之一，没有重复 Cherry-pick/Revert。

```bash
git add packages/git-cli/src/commitActions.ts src/extension/mutations/commitActionService.ts tests/integration/mutations/commit-actions.test.ts tests/fault-injection/commit-actions.test.ts
git commit -m "feat: add guarded cherry-pick and revert"
```

### Task 8: Fetch/Pull/Push、认证与未知结果对账

**Files:**
- Create: `packages/git-cli/src/remote.ts`
- Create: `src/extension/credentials/askpass.ts`
- Create: `src/extension/mutations/remoteService.ts`
- Test: `tests/integration/mutations/remote.test.ts`
- Test: `tests/integration/mutations/remote-unknown.test.ts`

- [ ] **Step 1: 写 Push 未知结果不重试测试**

```ts
it('reconciles an unknown push result before offering retry', async () => {
  remote.closeConnectionAfterReceivingPack();
  const result = await service.push({ remote: 'origin', localRef: 'refs/heads/main', remoteRef: 'refs/heads/main' });
  expect(result.kind).toBe('reconciledSuccess');
  expect(remote.receivePackCalls()).toBe(1);
  expect(remote.lsRemoteCalls()).toBe(1);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/mutations/remote.test.ts tests/integration/mutations/remote-unknown.test.ts`

Expected: FAIL with missing remote service。

- [ ] **Step 3: 实现显式 Remote Plan**

- Fetch：Remote 必须来自重新枚举的已配置 Remote。Host 用 `git config --null --get-all remote.<name>.fetch` 读取后解析 RefSpec，只允许目的 Ref 位于该 Remote 已验证的 `refs/remotes/<remote>/...` 命名空间；无配置时生成标准 `+refs/heads/*:refs/remotes/<remote>/*`，任何指向 `refs/heads`、内部 Recovery、任意其他命名空间或含糊 refspec 的配置都拒绝并显示诊断。命令为 `git fetch --no-tags --no-write-fetch-head --no-recurse-submodules --no-auto-maintenance --no-write-commit-graph [--prune] -- <remote> <safeRefspecs...>`；因此前台/后台 Fetch 都只更新可枚举的 Remote-tracking Refs，不改 `FETCH_HEAD`，不递归抓 Submodule，也不把 Tag/Maintenance/Commit Graph 写入混进网络事务。后台 Fetch 默认不注册定时器。
- Pull：先对已枚举并经 `check-ref-format` 的完整 `refs/heads/<branch>` 执行 `git fetch --no-tags --no-recurse-submodules --no-auto-maintenance --no-write-commit-graph -- <remote> <remoteRef>`；该 RefSpec 没有 destination，只允许写 Objects 与 `FETCH_HEAD`。把唯一 `FETCH_HEAD` 解析、校验为 OID 后重新采样本地 VersionVector 并生成确认 Plan；执行阶段只运行 `merge --ff-only <confirmedOid>`、`-c merge.autoStash=false merge --no-edit <confirmedOid>` 或 `-c rebase.autoStash=false -c rebase.updateRefs=false rebase --no-autostash <confirmedOid>`。Merge Message 在预览中显示，`--no-edit` 只接受该自动 Message，避免隐藏启动外部 Editor，不跳过 Commit Hook。Remote 在 Fetch 后再次前进只留给下次 Pull，不把可移动的 `FETCH_HEAD`/Remote 名塞进已确认的写步骤，也不允许配置暗中 Stash 或更新额外分支。Fetch 与整合分别 Journal 化，因此不会用含糊的单一 `git pull` 隐藏状态。
- Push：先读取并确认 local OID、remote OID 与 ahead/behind，Local/Remote Ref 都经 `check-ref-format`；只允许快进 `git push -- <remote> <confirmedLocalOid>:<remoteRef>`，不用可在执行窗口移动的分支名作为 refspec；Phase 2 拒绝任何 force Intent。
- 非零或未知结果：只要 receive-pack 可能已开始，就通过当前 Operation 的 `userInitiatedNetwork` Mutation Profile 执行 `git ls-remote --refs -- <remote> <remoteRef>`，对账 confirmed local OID；它不能走普通 `QueryGitProvider`，因为所有本地 Query 的 Transport 均被硬隔离。fatal UTF-8 parser 只接受唯一一行 `<完整 OID>\t<完全相同 remoteRef>`；精确等于 confirmed local OID 才标记 ReconciledSuccess，仍为旧 OID 表示明确未应用，其他/删除表示远端并发变化，多行、缩写 OID、额外 Ref 或乱码返回 `PARSER_UNSUPPORTED`。无法联网对账才进入 Needs Attention，绝不靠 stderr 猜测或自动重试。
- Partial Clone 显式物化：`partialClone.materialize` 的短期 Token 在 Host 中解析为已验证的 Promisor Remote 与 Missing OID 集合，按 OID 数量/字节预算通过 NUL 无关的逐行 stdin 执行 Git 自身 Promisor 实现同构命令：`git -c fetch.negotiationAlgorithm=noop fetch --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin -- <remote>`。所有选项都位于 `--` 前，Remote 即使来自恶意配置也不能成为选项。Provider 使用 `materializeMissingObjects` profile，允许这一次用户确认的网络访问；完成或连接中断后都用 `rev-list --objects --no-walk --missing=print` Reconcile，不能自动重试，且不更新 Ref/FETCH_HEAD。成功后销毁 Token 并重跑原只读 Query。

`pull.strategy=inherit` 只读取仓库生效的 `pull.ff/pull.rebase` 并把解析结果写入 Plan；组合含糊时等同 `prompt`，不替用户改 Git config。`fetch.prune=inherit` 同理读取 `fetch.prune`，`on/off` 只改变本次 args。所有最终选择都进入 `configFingerprint` 和确认摘要。

Phase 2 Pull 仅在 Working Tree/Index 干净时开放；Phase 3 完整内容 Checkpoint 合并后才能放宽。Fetch/Push 不受此限制，因为它们不写 Working Tree。

`gitWorkbench.remote.autoFetch=true` 只在 Trusted Workspace 按 `commonRepositoryId + remote` 注册非重叠定时器；Linked Worktree 共用一次 Fetch，不各自重复联网。定时器按 interval 加随机抖动并走同一组 Query pause/写队列/跨进程租约/Journal。后台 Network Profile 固定 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`、拒绝式 AskPass、`SSH_ASKPASS_REQUIRE=never`；标准 SSH 只能通过插件自有的无 Shell wrapper 调用系统 `ssh -oBatchMode=yes`。Remote Helper、`ext::`、自定义 `core.sshCommand` 或无法证明非交互的 Credential/SSH 配置不具备 Auto Fetch capability，只显示“需前台 Fetch”，不能在后台试跑。后台命令有硬超时；终止后按未知写结果对账 Remote-tracking Refs，不能重跑。遇到 Auth/Offline 后退避并显示一次状态，不弹凭据框、不循环重试。窗口隐藏、同组最后一个 Repository 移除或设置关闭时立即撤销 timer；默认 `false` 时不得留下任何网络定时任务。

- [ ] **Step 4: 安全复用系统凭据**

AskPass 桥只在用户发起的网络 Mutation 中启用；请求通过随机一次性本地 IPC token 关联当前 Operation，Secret 仅由受限 Helper 的 stdout 返回给 Git，不进入主 Git 进程的 stdin，也不写日志、Settings、workspaceState 或 Journal。Unix Domain Socket/Windows Named Pipe 必须限制为当前用户，Token 单次使用且在 Operation 终结或超时后立即失效。优先尊重 Credential Helper 与 SSH Agent；用户取消映射为 `AUTH_REQUIRED`，不自动重试。

所有 `ls-remote`、Remote capability discovery 和结果对账虽然不写本地仓库，仍属于显式 Network Operation：必须经过 Trust/Consent、网络 Profile、认证生命周期、超时和审计；不得为了绕过空 `GIT_ALLOW_PROTOCOL` 把普通 Query Runner 改成可联网。后台 Auto Fetch 使用单独的无 AskPass Profile。

- [ ] **Step 5: 运行 bare remote、断网、认证取消测试并提交**

Run: `npm run test:integration -- tests/integration/mutations/remote.test.ts tests/integration/mutations/remote-unknown.test.ts`

Expected: PASS；Push 断线场景 receive-pack 调用恰好一次；Partial Clone 普通查询无网络，显式物化只发起一次 Fetch 且不改 Ref/FETCH_HEAD。

```bash
git add packages/git-cli/src/remote.ts src/extension/credentials src/extension/mutations/remoteService.ts tests/integration/mutations/remote*.test.ts
git commit -m "feat: add reconciled Git remote operations"
```

### Task 9: UI 注册、错误表达与 Phase 2 故障门槛

**Files:**
- Create: `src/extension/mutations/confirmation.ts`
- Create: `src/extension/mutations/errorPresenter.ts`
- Modify: `src/extension/activate.ts`
- Modify: `package.json`
- Create: `tests/fault-injection/daily-mutations.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 写所有 UI 入口都经过 Coordinator 的合同测试**

枚举 Manifest 中 `gitWorkbench.stageFiles/unstageFiles/deletePaths/commit/amend/createBranch/switchBranch/stash/fetch/pull/push` Commands，Spy 每个 handler；断言只能调用 `MutationService.plan()` 和 `MutationCoordinator.execute()`，不能导入 `GitProcessRunner`。另一个合同测试证明 Dirty Tracked Delete、Dirty `keep` Switch、Dirty Stash Apply/Pop 和 Dirty Pull 的 `enablement` 为 false，直到 Phase 3 注册 `contentCheckpointReady` context key。

- [ ] **Step 2: 实现不可伪造的确认令牌**

```ts
// src/extension/mutations/confirmation.ts
import { createHash, randomUUID } from 'node:crypto';
import type { MutationPlan } from '@git-workbench/domain';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('unsupported plan value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sealPlan(plan: Omit<MutationPlan, 'operationId' | 'planDigest'>): MutationPlan {
  const operationId = randomUUID() as MutationPlan['operationId'];
  const planDigest = createHash('sha256').update(canonicalJson({ ...plan, operationId })).digest('hex');
  return { ...plan, operationId, planDigest };
}
```

生产实现把对象键递归排序后再序列化；测试用两个键插入顺序不同但语义相同的 Plan 证明 digest 一致，并证明修改 `effects` 或 `configFingerprint` 会改变 digest。确认 UI 展示 summary/effects/risk；按钮返回 Operation ID 和 digest。计划过期后旧按钮立即禁用。

- [ ] **Step 3: 实现 Typed Error 表达**

错误通知必须显示：Operation ID、仓库是否变化、是否可刷新/对账、脱敏日志入口。Hook stderr 只进入受限 Output Channel；Remote URL 去凭据，绝对路径按设置脱敏。普通失败不弹重复 Toast。

- [ ] **Step 4: 注入 Lock/Hook/网络/外部修改/进程强杀**

Run: `npx vitest run tests/fault-injection/daily-mutations.test.ts --pool=forks --maxWorkers=1`

Expected: 每个场景为 Committed、RolledBack、Paused 或 NeedsAttention 之一；不存在无 Journal 的部分成功；外部 `index.lock` 从不被删除。

- [ ] **Step 5: 运行 Phase 2 全量门槛**

Run: `npm run check && npm run test:integration && npm run test:vscode && npx vitest run tests/fault-injection --pool=forks --maxWorkers=1 && npm run package`

Expected: 全部 exit 0；UI 无普通 force/Reset/Rebase/Hunk Apply 命令。

- [ ] **Step 6: 提交 Phase 2 收尾**

```bash
git add src/extension/mutations/confirmation.ts src/extension/mutations/errorPresenter.ts src/extension/activate.ts package.json tests/fault-injection .github/workflows/ci.yml
git commit -m "test: enforce daily mutation safety gates"
```
