# Git Workbench Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Foundation 公开接口之上交付可分页的 Commit DAG、Refs/WIP 状态、任意端点只读比较、虚拟化工作台和会话级空白差异控制。

**Architecture:** Extension Host 负责所有 Git 查询、缓存与取消，Webview 只接收版本化 DTO；`repositoryGeneration + queryKey` 是缓存键。日志和 Diff 使用 NUL/明确格式流式解析，图布局进入 Web Worker，超大结果按规格降级，不允许 Webview 构造 Git 参数。

**Tech Stack:** Foundation 技术栈、React、React DOM、Web Worker、VS Code Webview/TreeDataProvider、Vitest、Playwright-style DOM 测试使用 `@testing-library/react` 与 jsdom

---

**Authoritative spec:** `docs/superpowers/specs/2026-08-20-git-workbench-vscode-extension-design.md`

## 前置条件与阶段出口

开始前必须在三个 CI 平台通过 Foundation 的完整门槛。完成后必须证明：

- 10 万 Commit 仓库首批 200 行 P95 `<1s`（已有 Commit Graph）。
- 任意 Commit/Branch/Tag/Stash/HEAD/Index/Working Tree 组合可比较。
- `auto` 只对 Branch↔Branch 使用 merge-base，其他组合使用 direct。
- `none/eol/all` 切换只改变当前会话并清空选择，不修改 `diffEditor.ignoreTrimWhitespace`。
- Webview IPC、取消、generation 失效、Graph 降级和大 Diff 降级均有测试。

Untrusted Workspace 的 Phase 1 能力固定为 Log/Refs 与本地对象已完整的 Commit↔Commit 比较；WIP、Status、Index/Working Tree 端点、Untracked 与原生工作区 Diff 全部显示 Trust Gate。Host 按 Query DTO 白名单决策，而不是在任意 args 生成后再猜命令是否安全；测试仓库配置恶意 `filter.evil.process`，证明 Untrusted Extension Host 从不启动该进程。

## 文件结构

```text
packages/domain/src/ref.ts                   Ref/Endpoint/Diff 模型
packages/domain/src/query.ts                 QueryKey、Generation 与分页合同
packages/git-cli/src/log.ts                  Log/Parent NUL 解析
packages/git-cli/src/refs.ts                 for-each-ref 解析
packages/git-cli/src/diff.ts                 端点解析、Diff 命令与解析
packages/git-cli/src/content.ts              只读 Blob/Index/Working Tree 内容
packages/protocol/src/readModel.ts           只读请求/响应 DTO
src/extension/query/queryScheduler.ts        有界并发、取消、同请求复用
src/extension/query/generationCache.ts       generation 键控 LRU
src/extension/query/readModelService.ts      只读 Use Cases
src/extension/views/repositoriesView.ts      仓库/状态侧栏
src/extension/views/refsView.ts              Branch/Tag/Stash/Worktree 侧栏
src/extension/webview/workbenchPanel.ts      CSP、IPC、生命周期
src/extension/virtualDocuments.ts            vscode.diff 只读内容
webview/workbench/src/app.tsx                工作台根组件
webview/workbench/src/graph/commitGraph.tsx  虚拟化 DAG
webview/workbench/src/graph/layout.worker.ts 轨道布局
webview/workbench/src/compare/compareView.tsx 文件/Hunk 预览
webview/workbench/src/compare/toolbar.tsx     端点与空白三态
webview/workbench/src/state/session.ts        会话覆盖状态
tests/performance/read-model.bench.test.ts    大仓库预算
```

### Task 1: 定义只读 Endpoint、Ref、Diff 与 Query 合同

**Files:**
- Create: `packages/domain/src/ref.ts`
- Create: `packages/domain/src/query.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/protocol/src/readModel.ts`
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/validate.ts`
- Test: `packages/domain/src/ref.test.ts`
- Test: `packages/protocol/src/readModel.test.ts`

- [ ] **Step 1: 写 auto 比较语义失败测试**

```ts
// packages/domain/src/ref.test.ts
import { describe, expect, it } from 'vitest';
import { effectiveCompareMode, type CompareEndpoint } from './ref.js';

const endpoint = (kind: CompareEndpoint['kind'], value = kind): CompareEndpoint => ({ kind, value, label: value });

describe('effectiveCompareMode', () => {
  it('uses mergeBase only for two branches', () => {
    expect(effectiveCompareMode('auto', endpoint('branch'), endpoint('branch', 'topic'))).toBe('mergeBase');
    expect(effectiveCompareMode('auto', endpoint('commit'), endpoint('commit', 'b'))).toBe('direct');
    expect(effectiveCompareMode('auto', endpoint('branch'), endpoint('workingTree'))).toBe('direct');
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/domain/src/ref.test.ts`

Expected: FAIL with missing `ref.js`。

- [ ] **Step 3: 实现不可变只读模型**

```ts
// packages/domain/src/ref.ts
import type { ObjectId, RepoRelativePath } from './ids.js';

export type EndpointKind = 'commit' | 'branch' | 'tag' | 'stash' | 'head' | 'index' | 'workingTree';
export type CompareMode = 'auto' | 'direct' | 'mergeBase';
export type EffectiveCompareMode = Exclude<CompareMode, 'auto'>;
export type IgnoreWhitespace = 'none' | 'eol' | 'all';

export interface CompareEndpoint {
  readonly kind: EndpointKind;
  readonly value: string;
  readonly label: string;
  readonly resolvedOid?: ObjectId;
}

export interface DiffFile {
  readonly path: RepoRelativePath;
  readonly originalPath?: RepoRelativePath;
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'U';
  readonly binary: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffLine {
  readonly kind: 'context' | 'addition' | 'deletion' | 'noNewline';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export function effectiveCompareMode(mode: CompareMode, left: CompareEndpoint, right: CompareEndpoint): EffectiveCompareMode {
  return mode === 'auto' ? (left.kind === 'branch' && right.kind === 'branch' ? 'mergeBase' : 'direct') : mode;
}
```

```ts
// packages/domain/src/query.ts
import type { RepositoryId } from './ids.js';

export interface QueryContext {
  readonly repositoryId: RepositoryId;
  readonly generation: number;
  readonly requestId: string;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export const queryKey = (name: string, input: unknown): string => `${name}:${JSON.stringify(input)}`;
```

扩展 `HostRequest` 只能增加白名单类型：`log.page`、`refs.list`、`compare.open`、`compare.file`、`content.read`、`query.cancel`。所有请求都必须包含 `repositoryId`、`generation` 和有限长度 `requestId`；Host 对未完成请求维护全局唯一索引，重复 `requestId` 在进入 Scheduler 前拒绝，防止一次 Cancel 误伤其他 Query；不得增加 `args` 字段。

- [ ] **Step 4: 运行领域与协议测试并提交**

Run: `npx vitest run packages/domain/src packages/protocol/src`

Expected: PASS；`git.exec` 与多余属性仍被拒绝。

```bash
git add packages/domain packages/protocol
git commit -m "feat: define Git read model contracts"
```

### Task 2: 实现有界 Query Scheduler 与 Generation Cache

**Files:**
- Create: `src/extension/query/queryScheduler.ts`
- Create: `src/extension/query/generationCache.ts`
- Test: `src/extension/query/queryScheduler.test.ts`
- Test: `src/extension/query/generationCache.test.ts`

- [ ] **Step 1: 写并发、复用、写优先占位失败测试**

```ts
// src/extension/query/queryScheduler.test.ts
import { describe, expect, it, vi } from 'vitest';
import { QueryScheduler } from './queryScheduler.js';

describe('QueryScheduler', () => {
  it('reuses identical inflight work and caps a repository at two reads', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn(async () => 42);
    const first = scheduler.run('repo', 'status:1', 'request-1', work);
    const second = scheduler.run('repo', 'status:1', 'request-2', work);
    expect(await first).toBe(42);
    expect(await second).toBe(42);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retries only explicitly classified transient reads at most twice', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { transientQuery: true }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { transientQuery: true }))
      .mockResolvedValue(42);
    await expect(scheduler.run('repo', 'status:2', 'request-3', work)).resolves.toBe(42);
    expect(work).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/extension/query/queryScheduler.test.ts`

Expected: FAIL with missing scheduler。

- [ ] **Step 3: 实现调度器和可取消句柄**

```ts
// src/extension/query/queryScheduler.ts
import { GitWorkbenchError } from '@git-workbench/domain';

interface Subscriber<T> { readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void }
interface InflightEntry<T> { readonly controller: AbortController; readonly subscribers: Map<string, Subscriber<T>> }
interface QueuedRead { readonly repositoryId: string; readonly signal: AbortSignal; readonly start: () => void; readonly cancel: () => void }

export class QueryScheduler {
  private activeGlobal = 0;
  private readonly activeByRepository = new Map<string, number>();
  private readonly inflight = new Map<string, InflightEntry<unknown>>();
  private readonly queue: QueuedRead[] = [];
  private readonly pausedRepositories = new Set<string>();

  constructor(
    private readonly limits: { readonly globalLimit: number; readonly repositoryLimit: number },
    private readonly retry = { maxRetries: 2, baseDelayMs: 50 },
  ) {}

  run<T>(repositoryId: string, key: string, requestId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const compound = `${repositoryId}\0${key}`;
    const existing = this.inflight.get(compound) as InflightEntry<T> | undefined;
    if (existing) return this.subscribe(existing, requestId);
    const controller = new AbortController();
    const entry: InflightEntry<T> = { controller, subscribers: new Map() };
    this.inflight.set(compound, entry as InflightEntry<unknown>);
    let acquired = false;
    void this.acquire(repositoryId, controller.signal)
      .then(async () => {
        acquired = true;
        controller.signal.throwIfAborted();
        const value = await this.runWithRetry(work, controller.signal);
        controller.signal.throwIfAborted();
        return value;
      })
      .then(
        (value) => { for (const subscriber of entry.subscribers.values()) subscriber.resolve(value); },
        (error: unknown) => { for (const subscriber of entry.subscribers.values()) subscriber.reject(error); },
      )
      .finally(() => {
        entry.subscribers.clear();
        this.inflight.delete(compound);
        if (acquired) this.release(repositoryId);
      });
    return this.subscribe(entry, requestId);
  }

  cancel(requestId: string): void {
    for (const entry of this.inflight.values()) {
      const subscriber = entry.subscribers.get(requestId);
      if (!subscriber) continue;
      entry.subscribers.delete(requestId);
      subscriber.reject(new GitWorkbenchError({ code: 'CANCELLED', message: 'Git 查询已取消', repositoryChanged: false, retry: 'none' }));
      if (entry.subscribers.size === 0) entry.controller.abort();
    }
  }

  pauseRepository(repositoryId: string): void { this.pausedRepositories.add(repositoryId); }

  resumeRepository(repositoryId: string): void {
    this.pausedRepositories.delete(repositoryId);
    this.drain();
  }

  private subscribe<T>(entry: InflightEntry<T>, requestId: string): Promise<T> {
    if (entry.subscribers.has(requestId)) return Promise.reject(new Error(`duplicate requestId: ${requestId}`));
    return new Promise<T>((resolve, reject) => entry.subscribers.set(requestId, { resolve, reject }));
  }

  private acquire(repositoryId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.canRun(repositoryId)) { this.mark(repositoryId, 1); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      let queued: QueuedRead;
      const cancel = (): void => {
        const index = this.queue.indexOf(queued);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      queued = {
        repositoryId,
        signal,
        cancel,
        start: () => {
          signal.removeEventListener('abort', cancel);
          this.mark(repositoryId, 1);
          resolve();
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.queue.push(queued);
    });
  }

  private canRun(repositoryId: string): boolean {
    return !this.pausedRepositories.has(repositoryId) && this.activeGlobal < this.limits.globalLimit && (this.activeByRepository.get(repositoryId) ?? 0) < this.limits.repositoryLimit;
  }

  private mark(repositoryId: string, delta: 1 | -1): void {
    this.activeGlobal += delta;
    this.activeByRepository.set(repositoryId, (this.activeByRepository.get(repositoryId) ?? 0) + delta);
  }

  private release(repositoryId: string): void {
    this.mark(repositoryId, -1);
    this.drain();
  }

  private drain(): void {
    while (true) {
      const nextIndex = this.queue.findIndex((entry) => !entry.signal.aborted && this.canRun(entry.repositoryId));
      if (nextIndex < 0) return;
      this.queue.splice(nextIndex, 1)[0]?.start();
    }
  }

  private async runWithRetry<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work(signal);
      } catch (error) {
        const transient = error instanceof Error && (error as Error & { readonly transientQuery?: boolean }).transientQuery === true;
        if (signal.aborted || !transient || attempt >= this.retry.maxRetries) throw error;
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(signal.reason); return; }
          let timer: ReturnType<typeof setTimeout>;
          const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
          timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, this.retry.baseDelayMs * (2 ** attempt));
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }
}
```

测试还必须覆盖：排队期间取消不会启动 `work`；取消最后一个订阅者后 Git 子进程退出；取消共享请求中的一个订阅者只拒绝该请求而不终止另一个订阅者；MutationCoordinator 获取写租约前调用 `pauseRepository()`、终结后 `resumeRepository()`，写操作等待期间新后台读不插队。测试用 `finally` 证明异常路径也会 Resume。

自动重试仅允许调用方结构化标记的本地、幂等、瞬时 Query（例如 OS `EAGAIN/EBUSY/EMFILE/ENFILE` 或已确认的短暂只读锁竞争），总尝试次数最多 3 次，延迟为 50ms/100ms 并可取消。不得通过匹配本地化 stderr 猜测“瞬时”；Parser、Auth、Offline、`TOO_LARGE`、`MISSING_LOCAL_OBJECT`、用户网络查询和任何 Mutation 都不得进入该路径。测试使用 Fake Timer 证明两次上限、非瞬时零重试、退避中取消不再启动下一次，并确认共享订阅者只触发一组尝试。

- [ ] **Step 4: 实现有字节预算的 Generation LRU**

```ts
// src/extension/query/generationCache.ts
interface Entry<T> { readonly generation: number; readonly value: T; readonly bytes: number; touched: number }

export class GenerationCache {
  private readonly values = new Map<string, Entry<unknown>>();
  private used = 0;
  constructor(private readonly maxBytes: number) {}

  get<T>(key: string, generation: number): T | undefined {
    const entry = this.values.get(key);
    if (!entry || entry.generation !== generation) return undefined;
    entry.touched = Date.now();
    return entry.value as T;
  }

  set<T>(key: string, generation: number, value: T, bytes: number): void {
    const previous = this.values.get(key);
    if (previous) this.used -= previous.bytes;
    this.values.set(key, { generation, value, bytes, touched: Date.now() });
    this.used += bytes;
    for (const [candidate, entry] of [...this.values].sort((a, b) => a[1].touched - b[1].touched)) {
      if (this.used <= this.maxBytes) break;
      this.values.delete(candidate);
      this.used -= entry.bytes;
    }
  }
}
```

- [ ] **Step 5: 运行并发与缓存测试并提交**

Run: `npx vitest run src/extension/query`

Expected: PASS；100 个并发请求不超过全局 4/仓库 2，旧 generation 永不命中。

```bash
git add src/extension/query
git commit -m "feat: schedule and cache Git queries"
```

### Task 3: 分页读取 Log、Refs、Stash 与 Worktree

**Files:**
- Create: `packages/git-cli/src/log.ts`
- Create: `packages/git-cli/src/refs.ts`
- Test: `packages/git-cli/src/log.test.ts`
- Test: `tests/integration/log.test.ts`

- [ ] **Step 1: 写 Merge Commit、Unicode 和游标失败测试**

```ts
// packages/git-cli/src/log.test.ts
import { describe, expect, it } from 'vitest';
import { parseLogRecords } from './log.js';

describe('parseLogRecords', () => {
  it('preserves all parents and commit message text', () => {
    const oid = 'a'.repeat(40);
    const parents = ['b'.repeat(40), 'c'.repeat(40)];
    const bytes = Buffer.from(`${[oid, parents.join(' '), '作者', '1700000000', '主题含控制符\x1f 😀'].join('\0')}\0\0\n`);
    expect(parseLogRecords(bytes)).toEqual([{ oid, parents, author: '作者', authoredAt: 1700000000, subject: '主题含控制符\x1f 😀' }]);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/git-cli/src/log.test.ts`

Expected: FAIL with missing parser。

- [ ] **Step 3: 实现明确分隔符的 Log Page**

```ts
// packages/git-cli/src/log.ts
import type { GitProcessRunner } from './process.js';

export interface CommitRow { readonly oid: string; readonly parents: readonly string[]; readonly author: string; readonly authoredAt: number; readonly subject: string }
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const orderArg = { topo: '--topo-order', date: '--date-order', authorDate: '--author-date-order' } as const;

export function parseLogRecords(bytes: Uint8Array): CommitRow[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text.split('\0\0\n').filter(Boolean).map((record) => {
    const fields = record.split('\0');
    if (fields.length !== 5) throw new Error('invalid log record');
    const [oid = '', parents = '', author = '', authoredAt = '0', subject = ''] = fields;
    const parentOids = parents ? parents.split(' ') : [];
    if (!oidPattern.test(oid) || parentOids.some((parent) => !oidPattern.test(parent)) || !/^\d+$/.test(authoredAt)) throw new Error('invalid log identity');
    return { oid, parents: parentOids, author, authoredAt: Number(authoredAt), subject };
  });
}

const encodeCursor = (generation: number, offset: number): string => Buffer.from(JSON.stringify({ generation, offset }), 'utf8').toString('base64url');
const decodeCursor = (cursor: string | undefined, generation: number): number => {
  if (!cursor) return 0;
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid log cursor');
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { generation?: unknown; offset?: unknown };
  if (value.generation !== generation || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error('stale or invalid log cursor');
  return value.offset;
};

export async function readLogPage(runner: GitProcessRunner, cwd: string, generation: number, order: keyof typeof orderArg, limit: number, cursor?: string): Promise<{ rows: CommitRow[]; nextCursor?: string }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid log page size');
  const offset = decodeCursor(cursor, generation);
  const args = ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '--exclude=refs/git-workbench/*', '--all', orderArg[order], `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=tformat:%H%x00%P%x00%an%x00%at%x00%s%x00%x00'];
  const result = await runner.run({ args, cwd, kind: 'query', maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 64 * 1024 });
  const rows = parseLogRecords(result.stdout);
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return hasMore ? { rows: visible, nextCursor: encodeCursor(generation, offset + visible.length) } : { rows: visible };
}
```

Cursor 只在同一 Repository Generation 内有效；Refs 变化立即失效全部 Cursor。`--skip` 方案优先保证 Merge DAG 无重复/漏项，性能基准若证明深页不达标，再在不改变 Cursor 合同的前提下用服务端 session 缓存加速。

调用者把 `graph.pageSize` 和 `graph.order` 作为 Query Key 的一部分；任一设置变化创建新 Cursor 会话，不把旧页混入新顺序。

`log.page` 的 Filter DTO 只允许有限长度的 literal message、已解析 Ref/OID、日期范围和 repo-relative path。Literal message 使用 `--fixed-strings --regexp-ignore-case --grep=<text>`；Path 查询使用 `git --literal-pathspecs log ... -- <path>`；Ref 先解析为 OID。UI 输入 200 ms debounce，旧请求通过 requestId 取消。协议不接受任意 grep regex、rev expression 或 Git args。

- [ ] **Step 4: 实现 `for-each-ref -z` 等价的安全 Ref 读取**

使用 `for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00%(HEAD)%00 refs/heads refs/remotes refs/tags`，只解析 Local/Remote Branch、Tag；Stash 用显式 `refs/stash` 的 `reflog show --format`，Worktree 用 `worktree list --porcelain -z`。`refs/git-workbench/**` 不进入普通 Ref DTO/搜索；所有显示名都作为不可信文本，不生成 HTML。

- [ ] **Step 5: 运行真实 DAG 集成测试并提交**

Run: `npx vitest run packages/git-cli/src/log.test.ts tests/integration/log.test.ts --pool=forks --maxWorkers=1`

Expected: PASS；分页合并后 OID 无重复、无漏项，Merge parents 顺序保留。

```bash
git add packages/git-cli/src/log.ts packages/git-cli/src/refs.ts packages/git-cli/src/log.test.ts tests/integration/log.test.ts
git commit -m "feat: read paged Git history and refs"
```

### Task 4: 实现端点解析与任意只读比较

**Files:**
- Create: `packages/git-cli/src/diff.ts`
- Create: `packages/git-cli/src/content.ts`
- Test: `packages/git-cli/src/diff.test.ts`
- Test: `tests/integration/compare.test.ts`

- [ ] **Step 1: 写 Branch auto、Commit direct、WIP generation 失败测试**

```ts
// tests/integration/compare.test.ts
import { describe, expect, it } from 'vitest';
import type { CompareEndpoint } from '@git-workbench/domain';
import { GitProcessRunner } from '../../packages/git-cli/src/process.js';
import { planComparison } from '../../packages/git-cli/src/diff.js';
import { createRepositoryFixture } from '../../packages/testkit/src/repository.js';

const endpoint = (kind: CompareEndpoint['kind'], value: string): CompareEndpoint => ({ kind, value, label: value });

describe('comparison planning', () => {
  it('resolves branch auto through merge-base and commit auto directly', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('a.txt', 'base\n');
      const first = await fixture.commitAll('base');
      const provider = { runner: new GitProcessRunner('git'), cwd: fixture.path };
      const commitPlan = await planComparison(provider, endpoint('commit', first), endpoint('head', 'HEAD'), 'auto', 4);
      expect(commitPlan.effectiveMode).toBe('direct');
      expect(commitPlan.generation).toBe(4);
    } finally {
      await fixture.dispose();
    }
  });
});
```

同一测试文件再用 `git switch -c topic` 创建分叉并断言 Branch↔Branch 为 `mergeBase`；所有 fixture 都在 `finally` 中释放，不使用全局隐式状态。

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/compare.test.ts`

Expected: FAIL with missing `planComparison`。

- [ ] **Step 3: 实现 Ref 安全解析和命令计划**

```ts
// packages/git-cli/src/diff.ts
import { asObjectId, effectiveCompareMode, type CompareEndpoint, type CompareMode, type EffectiveCompareMode } from '@git-workbench/domain';
import type { GitProcessRunner } from './process.js';

export interface ComparisonPlan {
  readonly left: CompareEndpoint;
  readonly right: CompareEndpoint;
  readonly effectiveMode: EffectiveCompareMode;
  readonly baseArgs: readonly string[];
  readonly empty: boolean;
  readonly generation: number;
}

const withResolvedOid = (endpoint: CompareEndpoint, oid: string | undefined): CompareEndpoint => oid ? { ...endpoint, resolvedOid: asObjectId(oid) } : endpoint;

const parseSingleOid = (bytes: Uint8Array): string => {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\r?\n$/.exec(value);
  if (!match?.[1]) throw new Error('invalid single OID output');
  return match[1];
};

export async function resolveRevision(runner: GitProcessRunner, cwd: string, endpoint: CompareEndpoint): Promise<string | undefined> {
  if (endpoint.kind === 'workingTree' || endpoint.kind === 'index') return undefined;
  const value = endpoint.kind === 'head' ? 'HEAD' : endpoint.value;
  const result = await runner.run({ args: ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(`unresolvable endpoint: ${endpoint.label}`);
  return parseSingleOid(result.stdout);
}

function directDiffArgs(left: CompareEndpoint, right: CompareEndpoint, leftOid: string | undefined, rightOid: string | undefined): { readonly baseArgs: readonly string[]; readonly empty: boolean } {
  if (leftOid && rightOid) return { baseArgs: [leftOid, rightOid], empty: leftOid === rightOid };
  if (left.kind === right.kind && (left.kind === 'index' || left.kind === 'workingTree')) return { baseArgs: [], empty: true };
  if (leftOid && right.kind === 'workingTree') return { baseArgs: [leftOid], empty: false };
  if (left.kind === 'workingTree' && rightOid) return { baseArgs: ['--reverse', rightOid], empty: false };
  if (leftOid && right.kind === 'index') return { baseArgs: ['--cached', leftOid], empty: false };
  if (left.kind === 'index' && rightOid) return { baseArgs: ['--cached', '--reverse', rightOid], empty: false };
  if (left.kind === 'index' && right.kind === 'workingTree') return { baseArgs: [], empty: false };
  if (left.kind === 'workingTree' && right.kind === 'index') return { baseArgs: ['--reverse'], empty: false };
  throw new Error('unsupported endpoint pair');
}

export async function planComparison(provider: { runner: GitProcessRunner; cwd: string }, left: CompareEndpoint, right: CompareEndpoint, mode: CompareMode, generation: number): Promise<ComparisonPlan> {
  const effectiveMode = effectiveCompareMode(mode, left, right);
  const leftOid = await resolveRevision(provider.runner, provider.cwd, left);
  const rightOid = await resolveRevision(provider.runner, provider.cwd, right);
  let command: { readonly baseArgs: readonly string[]; readonly empty: boolean };
  if (effectiveMode === 'mergeBase') {
    if (!leftOid || !rightOid) throw new Error('merge-base requires two commit-like endpoints');
    const base = await provider.runner.run({ args: ['merge-base', leftOid, rightOid], cwd: provider.cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 64 * 1024 });
    if (base.exitCode !== 0) throw new Error('merge-base unavailable');
    const baseOid = parseSingleOid(base.stdout);
    command = { baseArgs: [baseOid, rightOid], empty: baseOid === rightOid };
  } else {
    command = directDiffArgs(left, right, leftOid, rightOid);
  }
  return { left: withResolvedOid(left, leftOid), right: withResolvedOid(right, rightOid), effectiveMode, ...command, generation };
}
```

端点选择来自已解析 Ref DTO；用户显示名不能直接作为任意 revision 语法。Ref 名先由 `check-ref-format`/已读取 Ref 映射为 OID。`empty=true` 直接返回完整空 DTO，不能把 `WorkingTree↔WorkingTree`/`Index↔Index` 的空参数误执行成另一种 Diff。`--reverse` 只由 Host 在交换端点后生成新的只读 Query 与 Raw Token；执行 Patch 的消息没有 reverse 字段，也不能复用旧选择。

- [ ] **Step 4: 实现 Diff 读取与限制**

文件列表阶段运行两条独立的 NUL 输出，避免把两种格式拼进同一 parser；展开文件时再运行 Patch 查询：

1. 非 `empty` 计划运行 `git diff --raw -z --no-ext-diff --no-textconv --full-index <baseArgs>` 获取状态、mode、OID 和 Rename/Copy 元数据。
2. `git diff --numstat -z --no-ext-diff --no-textconv <baseArgs>` 获取 additions/deletions/binary 统计，并按原始 path bytes 与第 1 条结果合并。
3. 用户展开文件时运行 `git --literal-pathspecs diff --patch --no-ext-diff --no-textconv --full-index --unified=3 <whitespaceArgs> <baseArgs> -- <path>`。

`none/eol/all` 分别映射为 `[]`、`['--ignore-space-at-eol']`、`['--ignore-all-space']`。文件超过 `compare.maxFileSizeMB` 或内部硬字节预算时返回 `TOO_LARGE` DTO 与统计，不截断成可能被误解为完整 Diff 的内容；行数超过 `compare.maxDiffLines` 时，该值只限制首次渲染，Host 返回带 `totalLines/pageStart/pageEnd/complete=false` 的连续分页 DTO，UI 明示“已加载 X/Y”并按块请求。分页仍绑定同一 generation/raw digest，任一页过期就清空全部选择，不能把局部页伪装成完整 Patch。

所有只读 Query 默认同时带 `GIT_NO_LAZY_FETCH=1` 和空的 `GIT_ALLOW_PROTOCOL`。Capability Probe 确认 `git --no-lazy-fetch` 可用时，Partial Clone 缺 Blob 直接返回“对象尚未在本地”。最低支持基线中若该能力不可用，则任何可能读取 Tree/Blob 的 Diff 前必须先运行 `git --literal-pathspecs rev-list --objects --no-walk --missing=print <resolvedOids> -- <paths>`：该命令的 `--missing=print` 在 Git 2.35.3 内部会关闭按需抓取；仅当输出无 `?oid` 且未超预算时才允许执行后续 Diff，否则返回 `MISSING_LOCAL_OBJECT`/`TOO_LARGE`。若预检后到实际 Query 之间对象被外部 GC 移除，Transport 隔离仍使 Lazy Fetch 无法联网；Host 随后重跑有界 `--missing=print` 来结构化归类为 `MISSING_LOCAL_OBJECT`，不匹配本地化 stderr。预检结果按 OID、Path、Object Store Generation 短期缓存，避免大仓库重复遍历。

Trusted Workspace 中用户显式选择“获取缺失对象”才创建独立、可审计的网络 Mutation；该 Mutation 使用独立 Profile，不继承 Query 的空 `GIT_ALLOW_PROTOCOL`。Untrusted 或离线状态只提供诊断。集成测试使用受控 HTTP/SSH/File/Remote Helper Promisor Remote 记录请求次数，分别覆盖原生 `noLazyFetch`、旧版预检和预检后移除对象的竞态，断言普通 Log/Compare/展开 Patch 的请求次数始终为 0，而显式获取恰好增加 1 次。

`compare.defaultMode` 只决定新会话的初始 Mode；`compare.renameDetection=on/off` 明确映射 `--find-renames/--no-renames`，`auto` 由 Repository Profile 决定并把 effective value 展示在工具栏。`compare.maxFileSizeMB` 在读取/解析前后双重执行；`maxDiffLines` 在每页返回和 Webview 渲染两端执行。文件大小超限仍可打开元数据/统计，行数超限则有界分页，二者都不能生成或展示被误认成完整的截断 Patch。

Working Tree 端点带会话级 `includeUntracked`：关闭时不扫描；开启时运行有字节/条目上限的 `git ls-files --others --exclude-standard -z`，逐个按大小预算读取并作为“空 Blob → 本地文件”合成只读 Diff。它们进入同一 generation/file-hash 基线；Binary/Symlink 或新文件在 Phase 3 只能整文件选择。大仓库 Profile 默认不主动开启，达到上限时显示“Untracked 结果不完整”和手动缩小路径范围，不能把截断列表伪装成完整结果。

- [ ] **Step 5: 运行端点矩阵集成测试并提交**

Run: `npm run test:integration -- tests/integration/compare.test.ts`

Expected: Commit/Branch/Tag/Stash/HEAD/Index/Working Tree 的有序端点矩阵全部 PASS；尤其 Commit↔Index、Commit↔Working Tree、Index↔Working Tree 的 A/B 交换产生互为反向的状态和 Hunk，两个相同可变端点返回空结果；Untracked 开/关、超限和变更失效 PASS；不存在隐式 checkout。

```bash
git add packages/git-cli/src/diff.ts packages/git-cli/src/content.ts packages/git-cli/src/diff.test.ts tests/integration/compare.test.ts
git commit -m "feat: compare arbitrary Git endpoints"
```

### Task 5: 构建 Native Views 与只读服务

**Files:**
- Create: `src/extension/query/readModelService.ts`
- Create: `src/extension/views/repositoriesView.ts`
- Create: `src/extension/views/refsView.ts`
- Modify: `src/extension/activate.ts`
- Modify: `package.json`
- Test: `tests/vscode/suite/views.test.ts`

- [ ] **Step 1: 写 View ID 与增量刷新失败测试**

```ts
// tests/vscode/suite/views.test.ts
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('native views', () => {
  test('contributes repository and refs views', async () => {
    const extension = vscode.extensions.getExtension('git-workbench-project.git-workbench');
    assert.ok(extension);
    const views = extension.packageJSON.contributes.views.gitWorkbench as Array<{ id: string }>;
    assert.deepStrictEqual(views.map((view) => view.id), ['gitWorkbench.repositories', 'gitWorkbench.refs']);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:vscode`

Expected: FAIL because views 未贡献。

- [ ] **Step 3: 实现只读 Service 和 TreeDataProvider**

`ReadModelService` 是唯一可以组合 `QueryScheduler`、Cache 和 Git CLI Query 的类：

```ts
export class ReadModelService {
  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly scheduler: QueryScheduler,
    private readonly cache: GenerationCache,
    private readonly ports: { status(repositoryId: RepositoryId, generation: number, signal: AbortSignal): Promise<RepositoryStatus> },
  ) {}

  status(repositoryId: RepositoryId, generation: number, requestId: string): Promise<RepositoryStatus> {
    const key = `status:${repositoryId}`;
    const cached = this.cache.get<RepositoryStatus>(key, generation);
    if (cached) return Promise.resolve(cached);
    return this.scheduler.run(String(repositoryId), key, requestId, async (signal) => {
      const value = await this.ports.status(repositoryId, generation, signal);
      signal.throwIfAborted();
      this.cache.set(key, generation, value, JSON.stringify(value).length * 2);
      return value;
    });
  }
}
```

`performance.maxConcurrentReads` 初始化 Scheduler 全局上限（每 Worktree 仍最多 2），`performance.maxCacheMB` 初始化全局分片 LRU，`performance.profile` 决定 Rename/Untracked/装饰的初始预算；`auto` 用有上限的 tracked file count、Commit Graph 存在性和近期 Git 延迟计算 Effective Profile，并在 UI 显示，不把自动判定写回 Setting。

Trusted Changes View 先运行关闭 FSMonitor/Rename 且 `--untracked-files=no` 的快速 Status，100ms 内显示 tracked/staged/conflict 骨架；随后独立运行有条目/字节/时间上限的 `git ls-files --others --exclude-standard -z` 并增量合并 Untracked。Balanced 可自动启动该增量，Large Repository 只在用户展开 Untracked 组时启动；达到上限显示 Partial 状态和缩小范围入口。Untrusted 不运行两者。这样状态解析器仍覆盖 `?` 记录以兼容其他 Provider，但首屏不把无界 Untracked 扫描塞进单次 Status。

两条命令都接入 Foundation 的 `stdoutSink`，以完整 NUL record 为单位增量构建有条目上限的 DTO；达到条目/时间预算时主动取消 Query 并标记 `complete=false`，不把已捕获的 bytes 再复制成第二份大字符串。极端“全部文件已修改”场景必须进入 Partial/路径筛选模式，不能为了完整列表突破 Cache/IPC/Webview 内存预算。

Tree item 分组固定为 Repository → Changes/Staged/Conflicts 与 Branches/Tags/Stashes/Worktrees。文件名只传给 `TreeItem.label`，不得拼 Markdown command URI。

`ui.followActiveRepository=true` 只根据当前 Editor URI 匹配已注册 Repository，不触发新扫描；关闭后保持用户显式选择。`ui.compactMode=auto` 依据可用宽度/窗口密度选择布局，`compact/comfortable` 只改变呈现密度，不隐藏风险、冲突或恢复状态。

- [ ] **Step 4: 注册 Views 与命令并验证无打开视图时不读 Log**

Run: `npm run test:vscode`

Expected: PASS；只展开 Refs View 时才发 `refs.list`，只打开工作台时才读 Log。

- [ ] **Step 5: 提交 Native Views**

```bash
git add src/extension/query/readModelService.ts src/extension/views src/extension/activate.ts package.json tests/vscode/suite/views.test.ts
git commit -m "feat: add Git Workbench read-only views"
```

### Task 6: 建立安全 Webview、虚拟化 DAG 与降级列表

**Files:**
- Create: `webview/workbench/package.json`
- Create: `webview/workbench/src/index.tsx`
- Create: `webview/workbench/src/app.tsx`
- Create: `webview/workbench/src/graph/commitGraph.tsx`
- Create: `webview/workbench/src/graph/layout.worker.ts`
- Create: `src/extension/webview/workbenchPanel.ts`
- Modify: `esbuild.mjs`
- Test: `webview/workbench/src/graph/commitGraph.test.tsx`
- Test: `src/extension/webview/workbenchPanel.test.ts`

- [ ] **Step 1: 安装 UI 测试依赖并写 300 行虚拟化失败测试**

Run:

```bash
mkdir -p webview/workbench
npm init -y --workspace webview/workbench
npm pkg set --workspace webview/workbench name=@git-workbench/workbench private=true type=module
npm install --workspace webview/workbench react react-dom
npm install --save-dev --workspace webview/workbench @types/react @types/react-dom @testing-library/react jsdom
```

```tsx
// webview/workbench/src/graph/commitGraph.test.tsx
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CommitGraph } from './commitGraph.js';

it('keeps the rendered row count bounded', () => {
  const commits = Array.from({ length: 100_000 }, (_, index) => ({ oid: `${index}`, parents: index ? [`${index - 1}`] : [], subject: `commit ${index}` }));
  const view = render(<CommitGraph commits={commits} rowHeight={28} viewportHeight={560} scrollTop={50_000} />);
  expect(view.container.querySelectorAll('[data-commit-row]').length).toBeLessThanOrEqual(60);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run webview/workbench/src/graph/commitGraph.test.tsx --environment jsdom`

Expected: FAIL with missing component。

- [ ] **Step 3: 实现确定窗口的虚拟列表和 Worker 轨道**

```tsx
// webview/workbench/src/graph/commitGraph.tsx
interface Commit { readonly oid: string; readonly parents: readonly string[]; readonly subject: string }
interface Props { readonly commits: readonly Commit[]; readonly rowHeight: number; readonly viewportHeight: number; readonly scrollTop: number }

export function CommitGraph({ commits, rowHeight, viewportHeight, scrollTop }: Props): JSX.Element {
  const overscan = 12;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const visible = commits.slice(first, first + count);
  return <div role="tree" style={{ height: commits.length * rowHeight, position: 'relative' }}>
    {visible.map((commit, offset) => <div role="treeitem" data-commit-row key={commit.oid} style={{ position: 'absolute', top: (first + offset) * rowHeight, height: rowHeight }}>
      <span aria-hidden="true" data-lane-for={commit.oid} />
      <span>{commit.subject}</span>
    </div>)}
  </div>;
}
```

`layout.worker.ts` 输入仅含 OID/parent OID/可见范围，输出 lane 索引和线段；超过 `graph.maxLanes` 折叠远轨道。`graph.showWorkingTree/showRemoteBranches/showTags/showStashes/showWorktrees` 只控制明确的数据源和图标层，关闭的数据源不发查询；Worker 异常时 Host/Webview 切换为带父 OID 的可搜索 Commit 列表。

工作台顶部实现同一 Filter DTO 的搜索框与 Ref/日期/Path chips；结果模式与完整 DAG 模式视觉区分，清空筛选恢复原 Cursor，不把“当前已加载页内匹配”误标为全仓库搜索。

- [ ] **Step 4: 实现严格 CSP Panel**

```ts
// src/extension/webview/workbenchPanel.ts
import * as vscode from 'vscode';

export function renderWorkbenchHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri, nonce: string): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob:;"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${styleUri}"></head><body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}
```

每次 Panel 创建都用 `randomBytes(16).toString('base64url')` 生成新 nonce，不能复用固定值。仅 Style 允许 inline，以支持经过数值边界校验的虚拟列表定位；Script 仍严格要求 nonce。任何 Git/User 文本只能进入 React text node，不能进入 style 值。Webview 不启用网络源，不使用 `innerHTML`，只发送 `parseHostRequest` 接受的消息。

创建 Panel 时 `localResourceRoots` 只允许 Extension 安装目录下的已构建 Webview asset 目录，不包含 Workspace、用户目录或 `globalStorageUri`；`asWebviewUri` 只转换 manifest allowlist 中的固定 script/style 文件。合同测试尝试加载 Workspace 源码、Recovery Snapshot、任意 `https:` 和未列入 manifest 的扩展文件，均必须被拒绝。

- [ ] **Step 5: 构建双入口并提交**

Run: `npm run build && npx vitest run webview/workbench/src src/extension/webview`

Expected: Extension/Webview 两个 bundle 成功；CSP 测试拒绝 inline script 和任意网络连接。

```bash
git add webview src/extension/webview esbuild.mjs package.json package-lock.json
git commit -m "feat: render virtualized Git workbench"
```

### Task 7: 实现 Compare UI 与会话级 Whitespace 三态

**Files:**
- Create: `webview/workbench/src/state/session.ts`
- Create: `webview/workbench/src/compare/toolbar.tsx`
- Create: `webview/workbench/src/compare/compareView.tsx`
- Create: `src/extension/virtualDocuments.ts`
- Test: `webview/workbench/src/compare/toolbar.test.tsx`
- Test: `tests/vscode/suite/virtualDocuments.test.ts`

- [ ] **Step 1: 写切换清空选择且不写 Settings 的失败测试**

```tsx
// webview/workbench/src/compare/toolbar.test.tsx
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CompareToolbar } from './toolbar.js';

it('changes only the session and clears selected hunks', () => {
  const change = vi.fn();
  const view = render(<CompareToolbar value="none" settingsDefault="none" selectedCount={2} onSessionWhitespaceChange={change} onPersistDefault={vi.fn()} />);
  fireEvent.click(view.getByRole('button', { name: '忽略全部空白' }));
  expect(change).toHaveBeenCalledWith({ ignoreWhitespace: 'all', clearSelection: true });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run webview/workbench/src/compare/toolbar.test.tsx --environment jsdom`

Expected: FAIL with missing toolbar。

- [ ] **Step 3: 实现会话状态 Reducer**

```ts
// webview/workbench/src/state/session.ts
import type { IgnoreWhitespace } from '@git-workbench/domain';

export interface CompareSessionState { readonly ignoreWhitespace: IgnoreWhitespace; readonly selectedHunkIds: ReadonlySet<string>; readonly stale: boolean }
export type CompareSessionAction =
  | { readonly type: 'whitespace.changed'; readonly value: IgnoreWhitespace }
  | { readonly type: 'generation.changed' }
  | { readonly type: 'selection.changed'; readonly ids: ReadonlySet<string> };

export function reduceCompareSession(state: CompareSessionState, action: CompareSessionAction): CompareSessionState {
  if (action.type === 'whitespace.changed') return { ...state, ignoreWhitespace: action.value, selectedHunkIds: new Set(), stale: false };
  if (action.type === 'generation.changed') return { ...state, selectedHunkIds: new Set(), stale: true };
  return { ...state, selectedHunkIds: action.ids };
}
```

- [ ] **Step 4: 实现三态工具栏与显式持久化菜单**

工具栏三个按钮固定为“显示全部空白”“忽略行尾空白”“忽略全部空白”。普通点击只发 `compare.sessionWhitespaceChanged`；“设为 User/Workspace/Folder 默认”才发 `settings.update`，Host 用 `ConfigurationTarget` 写指定层。“恢复 Settings 默认值”删除 session override。任何切换先清空 Hunk/行选择，再重新 Query。Working Tree 端点旁提供“包含 Untracked”会话开关，同样清空选择并重新生成 generation-bound 预览，但不写新增的持久化 Setting。

- [ ] **Step 5: 实现原生 Diff 辅助入口**

`virtualDocuments.ts` 注册 `git-workbench-content:` 只读 Provider，以已解析 OID、Index 或当前文档生成内容 URI，再调用 `vscode.diff`。不得修改 `diffEditor.ignoreTrimWhitespace`；原生 Diff 标题明确显示“遵循 VS Code 全局空白设置”。

- [ ] **Step 6: 运行 UI/VS Code 测试并提交**

Run: `npx vitest run webview/workbench/src/compare --environment jsdom && npm run test:vscode`

Expected: PASS；测试 Spy 证明 session 切换未调用 `WorkspaceConfiguration.update`。

```bash
git add webview/workbench/src/state webview/workbench/src/compare src/extension/virtualDocuments.ts tests/vscode/suite/virtualDocuments.test.ts
git commit -m "feat: add compare workspace and whitespace controls"
```

### Task 8: 性能、降级、可访问性与 Phase 1 门槛

**Files:**
- Create: `tests/performance/read-model.bench.test.ts`
- Create: `tests/integration/query-cancellation.test.ts`
- Create: `tests/fixtures/large-repository.ts`
- Create: `tests/support/measure.ts`
- Modify: `webview/workbench/src/app.tsx`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 写性能预算测试**

```ts
// tests/performance/read-model.bench.test.ts
import { expect, it } from 'vitest';
import { measureP95 } from '../support/measure.js';
import { openPreparedRepository } from '../fixtures/large-repository.js';

it('loads the first 200 commits within the local P95 budget', async () => {
  const repository = await openPreparedRepository(process.env.GIT_WORKBENCH_PERF_REPO!);
  const p95 = await measureP95(20, () => repository.logPage({ limit: 200 }));
  expect(p95).toBeLessThan(1000);
});
```

性能夹具由确定性脚本创建 100,000 Commit 并运行 `git commit-graph write --reachable`；CI nightly 保存夹具缓存，PR CI 使用 10,000 Commit smoke，不伪造时间结果。

`performance.profile=auto` 先用索引/Commit 数和首批耗时选择 balanced 或 largeRepository；显式 profile 可提高降级但不能突破安全上限。`performance.maxCacheMB/maxConcurrentReads` 在创建 GenerationCache/QueryScheduler 时校验并热建新实例，旧实例 Drain 后释放；不能在有写操作时迁移 Query。

- [ ] **Step 2: 写取消与 Event Storm 降级测试**

连续发 100 次 generation 变化，断言后台刷新被 100 ms debounce 合并；达到熔断阈值后显示“刷新已暂停”并提供手动刷新。取消 `log.page` 后进程退出、缓存不写入、无未处理 rejection。

- [ ] **Step 3: 验证键盘和屏幕阅读器语义**

Run: `npm run test:unit -- webview/workbench && npm run test:vscode`

Expected: DAG 行为 `role=tree/treeitem`，端点选择、交换、空白三态、打开文件全部可用键盘；高对比主题不依赖仅颜色表达状态。

- [ ] **Step 4: 运行 Phase 1 全量门槛**

Run: `npm run check && npm run test:integration && npm run test:vscode && npm run build && npm run package`

Expected: 全部 exit 0；nightly 性能任务满足 P95，普通 CI 大仓库 smoke 无 OOM。

- [ ] **Step 5: 提交 Phase 1 收尾**

```bash
git add tests/performance tests/integration/query-cancellation.test.ts tests/fixtures webview/workbench/src/app.tsx .github/workflows/ci.yml
git commit -m "test: enforce Git read model budgets"
```
