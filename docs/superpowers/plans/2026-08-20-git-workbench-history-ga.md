# Git Workbench History and GA Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安全交付历史 Commit Reword、Interactive Rebase、Soft/Mixed/Hard Reset 与精确 Lease Push，并完成诊断、性能、可访问性、跨平台、Remote、供应链和 Stable 发布门槛。

**Architecture:** 所有历史改写先构建 Impact Plan，标记受保护/已发布历史，创建完整 Checkpoint，再由受控 Editor Helper 驱动 Git Sequencer。Push 只使用保存的远端 expected OID；GA 阶段通过统一诊断脱敏、性能降级、配置迁移、VSIX/SBOM 和真实平台矩阵证明发布质量。

**Tech Stack:** 前五阶段技术栈、Git interactive rebase/reset/update-ref/push、受控 Node Editor Helper、VS Code SecretStorage/Localization/Accessibility、npm SBOM、GitHub Actions、Remote SSH/WSL/Dev Container 测试夹具

---

**Authoritative spec:** `docs/superpowers/specs/2026-08-20-git-workbench-vscode-extension-design.md`

## 前置条件与阶段出口

- PausedOperation 的 Continue/Skip/Abort 与 Recovery Center 已通过三平台强杀测试。
- 已发布历史改写默认二次确认，Strict 模式禁止；不存在普通 `--force`。
- Hard Reset 前完整列出会丢弃的变更并建立可用源码快照。
- Settings 38 项中英文 Manifest 文案、Schema、运行时默认值完全一致。
- 第 19 节九项发布门槛全部有机器证据后才可标记 V1 Stable。

## 文件结构

```text
packages/domain/src/history.ts                    历史计划、发布状态、SHA 映射
packages/domain/src/safetyPolicy.ts               保护分支与改写决策
packages/git-cli/src/history.ts                   Rev-list/merge-base/contains
packages/git-cli/src/rebase.ts                    受控 Interactive Rebase
packages/git-cli/src/reset.ts                     Soft/Mixed/Hard
packages/git-cli/src/leasePush.ts                 精确 expected OID Lease
packages/transactions/src/historyCheckpoint.ts    历史与 Working Tree Checkpoint
src/extension/history/historyService.ts           计划、确认、执行、映射
src/extension/history/editorHelper.ts             受控 Sequence/Commit Editor
src/extension/history/resetService.ts             Reset 预览与执行
webview/workbench/src/history/rebasePlan.tsx       可视化计划
webview/workbench/src/history/resetDialog.tsx      结果解释
src/extension/diagnostics/redactor.ts              结构化脱敏
src/extension/diagnostics/exporter.ts              本地诊断包
packages/domain/src/futureProviders.ts             仅接口、无实现
scripts/check-vsix.mjs                              VSIX 内容检查
scripts/check-settings.mjs                          Settings/NLS 漂移检查
tests/security/*.test.ts                            命令/路径/Webview/脱敏
tests/performance/*.test.ts                         P95 与内存预算
tests/e2e/history-workflow.test.ts                  历史改写/Reset E2E
docs/release/v1-checklist.md                        发布证据索引
```

### Task 1: 历史影响模型与不可降级安全策略

**Files:**
- Create: `packages/domain/src/history.ts`
- Create: `packages/domain/src/safetyPolicy.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/validate.ts`
- Test: `packages/domain/src/safetyPolicy.test.ts`

- [ ] **Step 1: 写 Strict/Protected/Published 决策失败测试**

```ts
// packages/domain/src/safetyPolicy.test.ts
import { expect, it } from 'vitest';
import { decideHistoryRewrite } from './safetyPolicy.js';

it('denies published rewrites in strict mode and requires confirmation otherwise', () => {
  expect(decideHistoryRewrite({ mode: 'strict', protected: false, publication: 'published', policy: 'confirm' })).toEqual({ allowed: false, reason: 'strict-published' });
  expect(decideHistoryRewrite({ mode: 'balanced', protected: false, publication: 'published', policy: 'confirm' })).toEqual({ allowed: true, confirmation: 'published-history' });
  expect(decideHistoryRewrite({ mode: 'balanced', protected: false, publication: 'unknown', policy: 'confirm' })).toEqual({ allowed: true, confirmation: 'publication-unknown' });
  expect(decideHistoryRewrite({ mode: 'balanced', protected: true, publication: 'unpublished', policy: 'confirm' })).toEqual({ allowed: true, confirmation: 'protected-branch' });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run packages/domain/src/safetyPolicy.test.ts`

Expected: FAIL with missing safety policy。

- [ ] **Step 3: 实现计划与策略类型**

```ts
// packages/domain/src/history.ts
export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
export interface RebaseStep { readonly oldOid: string; readonly action: RebaseAction; readonly subject: string; readonly newMessage?: string }
export interface HistoryImpactPlan {
  readonly operationId: string;
  readonly branchRef: string;
  readonly originalTip: string;
  readonly upstreamBase: string;
  readonly steps: readonly RebaseStep[];
  readonly rewrittenOids: readonly string[];
  readonly affectedRefs: readonly { readonly ref: string; readonly oid: string }[];
  readonly publication: 'published' | 'unpublished' | 'unknown';
  readonly expectedRemote?: { readonly remote: string; readonly ref: string; readonly oid: string };
  readonly signedCommits: readonly string[];
}

export interface RewriteResult { readonly oldToNew: Readonly<Record<string, string>>; readonly newTip: string }
```

```ts
// packages/domain/src/safetyPolicy.ts
export interface RewriteSafetyInput { readonly mode: 'balanced' | 'strict'; readonly protected: boolean; readonly publication: 'published' | 'unpublished' | 'unknown'; readonly policy: 'deny' | 'confirm' }
export type RewriteSafetyDecision = { readonly allowed: false; readonly reason: string } | { readonly allowed: true; readonly confirmation?: 'published-history' | 'publication-unknown' | 'protected-branch' };

export function decideHistoryRewrite(input: RewriteSafetyInput): RewriteSafetyDecision {
  if (input.publication !== 'unpublished' && (input.mode === 'strict' || input.policy === 'deny')) return { allowed: false, reason: input.publication === 'unknown' ? 'publication-unknown' : 'strict-published' };
  if (input.publication === 'published') return { allowed: true, confirmation: 'published-history' };
  if (input.publication === 'unknown') return { allowed: true, confirmation: 'publication-unknown' };
  if (input.protected) return { allowed: true, confirmation: 'protected-branch' };
  return { allowed: true };
}
```

Protected Branch matcher 只支持有界的 `*`/`?` Glob；先转义全部 regex 元字符，再展开这两个符号，拒绝 NUL、`..`、超过 Schema 长度/数量的规则，不启用 brace/extglob 或用户正则。测试用灾难性 regex 字符串证明匹配时间受控。

协议新增 `history.planRebase/history.executeRebase/reset.plan/reset.execute`，所有执行消息只携带 Host 签发的 Operation ID/Digest。普通 force、任意 todo 文本、任意 editor 命令均不属于协议。

- [ ] **Step 4: 运行策略/协议测试并提交**

Run: `npx vitest run packages/domain/src packages/protocol/src`

Expected: PASS；Workspace/Folder 设置不能降低 Global strict 或移除保护分支。

```bash
git add packages/domain packages/protocol
git commit -m "feat: define history rewrite safety policy"
```

### Task 2: 构建 History Impact Plan 与发布状态

**Files:**
- Create: `packages/git-cli/src/history.ts`
- Create: `src/extension/history/historyService.ts`
- Test: `tests/integration/history/impact-plan.test.ts`

- [ ] **Step 1: 写 Merge 后代、受影响 Ref、远端已发布失败测试**

```ts
it('lists every rewritten descendant and the exact remote lease', async () => {
  const plan = await service.planReword({ commitOid: target, message: 'new subject' });
  expect(plan.rewrittenOids).toEqual([target, child, mergeTip]);
  expect(plan.affectedRefs).toContainEqual({ ref: 'refs/heads/main', oid: mergeTip });
  expect(plan.expectedRemote).toEqual({ remote: 'origin', ref: 'refs/heads/main', oid: remoteTip });
  expect(plan.publication).toBe('published');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/history/impact-plan.test.ts`

Expected: FAIL with missing history service。

- [ ] **Step 3: 实现精确影响查询**

- 验证目标 OID 属于当前分支 first-parent/完整 ancestry；不在分支上的 Commit 要求选择受影响分支。
- `rev-list --reverse <target>^..<tip>` 得到将重写集合；含 Merge 时启用 `--rebase-merges` 并保留拓扑。
- `for-each-ref --contains <target> refs/heads` 只列出 Local Branch refs；Remote refs 只用于 publication 判定，不自动改写，`refs/git-workbench/**` 不进入影响集合。
- 用户进入历史改写流程后，通过受 Trust/Consent 控制的 `userInitiatedNetwork` Profile 显式运行 `ls-remote --refs -- <remote> <remoteRef>`（不能走 Transport 隔离的普通 Query Runner），用唯一精确记录保存 expected OID，再以 ancestry 判断 `published/unpublished`；无 Upstream、离线、认证取消、Shallow 缺对象或无法唯一确认时必须是 `unknown`，不能回落为 `unpublished`。计划确认后后台 Fetch 变化不会替换保存的 OID。
- `cat-file commit` 检测 `gpgsig`，列出签名将失效的 Commit。

- [ ] **Step 4: 生成可读影响摘要**

摘要必须包含：被改写 Commit 数、后代/merge 数、受影响本地 refs、远端 expected OID、保护分支、签名失效、冲突可能性和恢复 Ref。若 Shallow history 缺 ancestor，拒绝执行并提供 Fetch deepen 建议，不自动联网。

- [ ] **Step 5: 运行 DAG/浅克隆/多 Worktree 测试并提交**

Run: `npm run test:integration -- tests/integration/history/impact-plan.test.ts`

Expected: PASS；当前分支被其他 Worktree checkout 时计划明确冲突，不执行。

```bash
git add packages/git-cli/src/history.ts src/extension/history/historyService.ts tests/integration/history/impact-plan.test.ts
git commit -m "feat: preview Git history rewrite impact"
```

### Task 3: 受控 Reword 与 Interactive Rebase

**Files:**
- Create: `src/extension/history/editorHelper.ts`
- Create: `packages/git-cli/src/rebase.ts`
- Create: `packages/transactions/src/historyCheckpoint.ts`
- Create: `webview/workbench/src/history/rebasePlan.tsx`
- Test: `tests/integration/history/rebase.test.ts`
- Test: `tests/security/editor-helper.test.ts`

- [ ] **Step 1: 写 Helper 只接受签名 Operation 文件测试**

```ts
it('rejects workspace-controlled paths and an invalid operation token', async () => {
  await expect(runEditorHelper({ mode: 'sequence', operationFile: workspaceFile, token: 'bad', targetFile: todoFile })).rejects.toThrow('invalid editor operation');
  expect(await readFile(todoFile, 'utf8')).toBe(originalTodo);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run tests/security/editor-helper.test.ts`

Expected: FAIL with missing helper。

- [ ] **Step 3: 实现受控 Editor Helper**

Helper 位于 Extension 安装目录，只接受四个固定参数：`sequence|message`、Extension globalStorage 下 Operation JSON、随机 256-bit token、Git 提供的 target file。它验证 Operation JSON 的 HMAC、target realpath 位于当前 Git operation path、旧 Todo OID/顺序与 Plan 一致，然后执行：

- sequence 模式：只把 Plan 指定行改为 `pick/reword/edit/squash/fixup/drop`，拒绝 `exec/label/reset/merge` 等 UI 未生成指令；`--rebase-merges` 自己生成的结构指令只能原样保留。
- message 模式：只在当前 stopped OID 等于 Plan reword OID 时写入 UTF-8 message；其他 Editor 调用保留现有内容。

POSIX 通过权限 `0700` wrapper 调用当前 Extension Host Node；Windows 使用 Extension 自带 `.cmd` wrapper，参数用固定文件路径而非用户文本。测试覆盖空格、`&`、`%`、引号和 Unicode 安装路径。

- [ ] **Step 4: 实现 Rebase Provider 与完整 Checkpoint**

执行前要求 Working Tree/Index 安全或用户显式创建 Stash；创建 recovery refs 和内容快照。先把待改写目标解析为 OID 并读取其 Parent；普通 Commit 与 Root Commit 使用不同命令，不能对 Root 拼造 `<target>^`：

```text
非 Root: git -c rebase.autoStash=false -c rebase.autoSquash=false -c rebase.updateRefs=false rebase --interactive --rebase-merges --no-autosquash --empty=keep <target-parent-oid> <branch-ref>
Root:    git -c rebase.autoStash=false -c rebase.autoSquash=false -c rebase.updateRefs=false rebase --interactive --rebase-merges --no-autosquash --empty=keep --root <branch-ref>
```

环境只设置受控 `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR` wrapper、Operation file/token；用命令级 `-c` 显式关闭会在 Plan 外重排/暂存/更新额外 Ref 的 autosquash/autostash/updateRefs 配置（旧 Git 不具备 updateRefs 功能时该 config 无副作用），Hooks 和 Signing 配置仍保持。Capability Probe 不支持 `--empty=keep` 等实际所需能力时禁用历史改写，不退回含糊命令。冲突进入 Phase 4 PausedOperation。成功后以 Patch-ID/拓扑映射旧 SHA→新 SHA，展示无法一一对应的 squash/drop。

- [ ] **Step 5: 实现可视化计划 UI**

拖动只改变 Host 支持的 `RebaseStep[]`，每次变化重新校验 dependency；Merge commits 默认锁定结构。Reword 编辑器显示 Summary/Body，签名警告始终可见。执行按钮显示 protected/published confirmation，不提供“永远允许”。

- [ ] **Step 6: 运行 Reword/Reorder/Squash/Fixup/Drop/Merge/冲突测试并提交**

Run: `npm run test:integration -- tests/integration/history/rebase.test.ts && npx vitest run tests/security/editor-helper.test.ts`

Expected: PASS on macOS、Windows、Linux；Helper 无法执行任意 shell 文本。

```bash
git add src/extension/history packages/git-cli/src/rebase.ts packages/transactions/src/historyCheckpoint.ts webview/workbench/src/history/rebasePlan.tsx tests/integration/history/rebase.test.ts tests/security/editor-helper.test.ts
git commit -m "feat: safely rewrite Git commit history"
```

### Task 4: Soft/Mixed/Hard Reset 与恢复

**Files:**
- Create: `packages/git-cli/src/reset.ts`
- Create: `packages/git-cli/src/reflog.ts`
- Create: `src/extension/history/resetService.ts`
- Create: `webview/workbench/src/history/resetDialog.tsx`
- Modify: `src/extension/recovery/recoveryService.ts`
- Modify: `src/extension/recovery/recoveryView.ts`
- Test: `tests/integration/history/reset.test.ts`
- Test: `tests/integration/history/reflog-recovery.test.ts`
- Test: `tests/fault-injection/reset.test.ts`

- [ ] **Step 1: 写 Hard Reset 影响预览和默认 Mixed 测试**

```ts
it('defaults to mixed and lists every path hard reset would overwrite', async () => {
  const plan = await service.planReset(targetOid);
  expect(plan.defaultMode).toBe('mixed');
  expect(plan.modes.hard.paths).toEqual(['modified.ts', 'deleted.ts', 'blocking-untracked']);
  expect(plan.modes.hard.checkpointRequired).toBe(true);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/history/reset.test.ts`

Expected: FAIL with missing reset service。

- [ ] **Step 3: 实现三种结果预览**

入口允许用户从 Commit DAG 或 Branch Tree 选择 Commit/Local Branch/Remote-tracking Branch/Tag；选择项必须来自已枚举 DTO，并立即解析、冻结为完整 OID。执行期只接受该 OID，不接受自由 revision 文本，也不因同名 Branch 后续移动而改变目标。

- Soft：仅 Branch/HEAD Ref 将变化；Index/Working Tree 不变。
- Mixed：Branch/HEAD 与 Index 将变化；Working Tree 保留。
- Hard：Branch/HEAD、Index、所有受影响 Working Tree 路径、会阻挡 checkout 的 Untracked 路径。

目标必须先解析为 OID。受保护/已发布状态、变更文件/行数、签名/Worktree 影响和恢复位置全部显示。

- [ ] **Step 4: 实现 Checkpointed Reset**

Soft/Mixed 保存 Ref/Index Checkpoint；Hard 还保存每个受影响/阻挡路径完整 bytes/mode/symlink。执行 `git reset --soft|--mixed|--hard <oid>` 后验证 HEAD、Index Tree 与 Working Tree hash；不匹配进入 Reconcile。Abort/Restore 使用 After Image CAS。

- [ ] **Step 5: 增加有界 Reflog 恢复**

Recovery Center 分页读取 `HEAD` 与已枚举 Local Branch 的 Reflog；命令使用固定 UTF-8/NUL 格式，解析完整 OID、selector、timestamp 与 subject，设置条目/字节/时间预算，不接受 Webview 提交任意 revision。Selector 只用于显示，动作目标立即冻结为该条目的完整 OID。

默认恢复动作是经 `check-ref-format --branch` 校验后在所选 OID 创建新的 `recovery/<date>-<shortOid>` Local Branch，不移动 HEAD、不改 Index/Working Tree；若用户明确选择“将当前分支重置到这里”，必须转入本 Task 的 Soft/Mixed/Hard Reset 影响预览、确认、Checkpoint 与 CAS 恢复流程，不能从 Reflog View 直接调用 `reset`。测试覆盖过期 selector、Reflog 在预览后增长、已删除 Commit、恶意 subject、分页上限和新建恢复分支名称碰撞。

- [ ] **Step 6: 在每个 Reset 状态点强杀并提交**

Run: `npx vitest run tests/fault-injection/reset.test.ts --pool=forks --maxWorkers=1 && npm run test:integration -- tests/integration/history/reset.test.ts tests/integration/history/reflog-recovery.test.ts`

Expected: PASS；Hard Reset 后可 Restore，外部后续修改不被 Restore 覆盖。

```bash
git add packages/git-cli/src/reset.ts packages/git-cli/src/reflog.ts src/extension/history/resetService.ts src/extension/recovery webview/workbench/src/history/resetDialog.tsx tests/integration/history/reset.test.ts tests/integration/history/reflog-recovery.test.ts tests/fault-injection/reset.test.ts
git commit -m "feat: add recoverable Git reset modes"
```

### Task 5: 精确 `force-with-lease` 与未知 Push 对账

**Files:**
- Create: `packages/git-cli/src/leasePush.ts`
- Modify: `src/extension/mutations/remoteService.ts`
- Test: `tests/integration/history/lease-push.test.ts`

- [ ] **Step 1: 写后台 Fetch 不改变 Lease 和远端抢先更新失败测试**

```ts
it('uses the OID saved in the confirmed plan, not the tracking ref', async () => {
  const plan = await service.planPublishedRewritePush();
  await fixture.backgroundFetchThatMovesTrackingRef();
  remote.advanceRefByAnotherWriter();
  await expect(service.executeLeasePush(plan)).rejects.toMatchObject({ payload: { code: 'LEASE_REJECTED' } });
  expect(remote.ref()).toBe(otherWriterOid);
  expect(remote.lastArgs()).toContain(`--force-with-lease=${plan.expectedRemote.ref}:${plan.expectedRemote.oid}`);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:integration -- tests/integration/history/lease-push.test.ts`

Expected: FAIL with missing lease provider。

- [ ] **Step 3: 实现只有显式 expected OID 的 Lease Push**

```ts
// packages/git-cli/src/leasePush.ts
import { GitWorkbenchError } from '@git-workbench/domain';
import type { MutationGitProvider } from './ports.js';

export async function pushWithExactLease(provider: MutationGitProvider, input: { readonly remote: string; readonly localRef: string; readonly localOid: string; readonly remoteRef: string; readonly expectedOid: string }): Promise<PushResult> {
  await assertFullBranchRef(provider, input.localRef);
  await assertFullBranchRef(provider, input.remoteRef);
  await assertKnownRemote(provider, input.remote);
  assertOid(input.localOid);
  assertOid(input.expectedOid);
  if (await provider.resolve(input.localRef) !== input.localOid) throw new GitWorkbenchError({ code: 'STALE_PLAN', message: '本地分支已变化', repositoryChanged: true, retry: 'refresh' });
  const args = ['push', `--force-with-lease=${input.remoteRef}:${input.expectedOid}`, '--', input.remote, `${input.localOid}:${input.remoteRef}`];
  const result = await provider.mutate(args);
  if (result.outcome === 'unknown' || result.exitCode !== 0) return reconcileRemoteOid(provider, input.remote, input.remoteRef, input.expectedOid, input.localOid);
  return { kind: 'success' };
}

export type PushResult = { readonly kind: 'success' | 'reconciledSuccess' };

const assertFullBranchRef = async (provider: MutationGitProvider, ref: string): Promise<void> => {
  if (!ref.startsWith('refs/heads/') || ref.length > 1024 || /[\0-\x1f\x7f]/.test(ref)) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Ref 格式无效', repositoryChanged: false, retry: 'none' });
  }
  const checked = await provider.query(['check-ref-format', ref]);
  if (checked.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Ref 格式无效', repositoryChanged: false, retry: 'none' });
};

const assertKnownRemote = async (provider: MutationGitProvider, remote: string): Promise<void> => {
  if (!remote || remote.startsWith('-') || /[\0-\x1f\x7f]/.test(remote)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Remote 名称无效', repositoryChanged: false, retry: 'none' });
  const checked = await provider.query(['remote', 'get-url', '--', remote]);
  if (checked.exitCode !== 0) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Remote 不存在', repositoryChanged: false, retry: 'refresh' });
};

const assertOid = (oid: string): void => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'OID 格式无效', repositoryChanged: false, retry: 'none' });
};

async function reconcileRemoteOid(provider: MutationGitProvider, remote: string, remoteRef: string, expectedOldOid: string, expectedNewOid: string): Promise<PushResult> {
  const result = await provider.mutate(['ls-remote', '--refs', '--', remote, remoteRef], undefined, 'userInitiatedNetwork');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  const lines = text === '' ? [] : text.split(/\r?\n/).filter((line) => line.length > 0);
  const match = lines.length === 1 ? /^([0-9a-f]{40}|[0-9a-f]{64})\t([^\0\r\n]+)$/.exec(lines[0] ?? '') : null;
  if (result.exitCode === 0 && match?.[1] === expectedNewOid && match[2] === remoteRef) return { kind: 'reconciledSuccess' };
  if (result.exitCode === 0 && match?.[1] === expectedOldOid && match[2] === remoteRef) throw new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: 'Push 未应用，远端仍是确认前的 OID', repositoryChanged: false, retry: 'refresh' });
  if (result.exitCode === 0 && match?.[2] === remoteRef) throw new GitWorkbenchError({ code: 'LEASE_REJECTED', message: '远端分支已被其他操作更新', repositoryChanged: true, retry: 'refresh' });
  if (result.exitCode === 0 && lines.length === 0) throw new GitWorkbenchError({ code: 'LEASE_REJECTED', message: '远端分支已被删除', repositoryChanged: true, retry: 'refresh' });
  if (result.exitCode === 0) throw new GitWorkbenchError({ code: 'PARSER_UNSUPPORTED', message: '无法安全解析远端 Ref 响应', repositoryChanged: true, retry: 'reconcile' });
  throw classifyStructuredNetworkFailure(result);
}

function classifyStructuredNetworkFailure(result: { readonly failureClass?: 'authCancelled' | 'offline' | 'timeout' | 'remoteRejected' }): GitWorkbenchError {
  if (result.failureClass === 'authCancelled') return new GitWorkbenchError({ code: 'AUTH_REQUIRED', message: '认证未完成', repositoryChanged: true, retry: 'authenticate' });
  if (result.failureClass === 'offline') return new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: '当前离线，无法确认远端结果', repositoryChanged: true, retry: 'reconcile' });
  if (result.failureClass === 'timeout') return new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: '远端请求超时，结果需要对账', repositoryChanged: true, retry: 'reconcile' });
  return new GitWorkbenchError({ code: 'POSTCONDITION_FAILED', message: '远端结果无法确认，请查看脱敏诊断', repositoryChanged: true, retry: 'reconcile' });
}
```

`classifyStructuredNetworkFailure` 只读取 AskPass 取消事件、Provider timeout/offline 类别和已脱敏的服务端状态，不匹配本地化 stderr；无法确定时返回 `POSTCONDITION_FAILED/reconcile`。代码扫描和协议测试必须证明不存在裸 `--force`、无 expected OID 的 `--force-with-lease` 或 `+refspec`。Refspec 使用确认后的 `localOid` 而不是可在执行窗口移动的本地分支名；Remote 必须来自重新校验的已配置 Remote 列表。Ref 不用 ASCII 自制正则代替 Git：中文/Unicode Full Ref 通过，控制字符、超长值和 `check-ref-format` 拒绝的名称失败。

- [ ] **Step 4: 运行并发 Remote/断线测试并提交**

Run: `npm run test:integration -- tests/integration/history/lease-push.test.ts`

Expected: PASS；服务端 Ref 被其他 Writer 更新时永不覆盖。

```bash
git add packages/git-cli/src/leasePush.ts src/extension/mutations/remoteService.ts tests/integration/history/lease-push.test.ts
git commit -m "feat: push rewritten history with exact leases"
```

### Task 6: 诊断脱敏、日志等级与未来 Provider 空接口

**Files:**
- Create: `src/extension/diagnostics/redactor.ts`
- Create: `src/extension/diagnostics/exporter.ts`
- Create: `packages/domain/src/futureProviders.ts`
- Test: `tests/security/redactor.test.ts`
- Test: `tests/contract/futureProviders.test.ts`

- [ ] **Step 1: 写凭据永远脱敏测试**

```ts
it.each([true, false])('removes credentials even when redactPaths=%s', (redactPaths) => {
  const value = redactDiagnostics({ remote: 'https://user:secret@example.com/org/repo.git', token: 'ghp_value', path: '/Users/alice/private/repo' }, { redactPaths });
  expect(JSON.stringify(value)).not.toMatch(/secret|ghp_value/);
  if (redactPaths) expect(JSON.stringify(value)).not.toContain('/Users/alice');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run tests/security/redactor.test.ts`

Expected: FAIL with missing redactor。

- [ ] **Step 3: 实现结构化 allowlist 导出**

只导出版本、Capability、错误码、Operation state、耗时、脱敏路径 hash 和用户主动选择的日志片段；不先序列化任意对象再正则清洗。Remote URL 用 URL parser 移除 username/password/query；Token/AskPass/环境变量不进入输入模型。`redactPaths=false` 仅保留本地路径上下文，凭据规则不可配置。

- [ ] **Step 4: 定义但不注册未来 Provider**

```ts
// packages/domain/src/futureProviders.ts
export interface ProviderDataRequest { readonly classification: 'metadata' | 'source' | 'diff'; readonly purpose: string; readonly bytes: number }
export interface ProviderConsent { readonly operationId: string; readonly allowed: readonly ProviderDataRequest[] }
export interface RemoteHostingProvider { readonly id: string; readonly domains: readonly string[]; connect(consent: ProviderConsent, signal: AbortSignal): Promise<void> }
export interface AiProvider { readonly id: string; explain(request: ProviderDataRequest, consent: ProviderConsent, signal: AbortSignal): Promise<string> }
export interface PatchSharingProvider { readonly id: string; share(request: ProviderDataRequest, consent: ProviderConsent, signal: AbortSignal): Promise<{ readonly url: string }> }
```

合同测试扫描 Extension activation，断言 V1 没有 Provider 实例、网络 SDK 或遥测 SDK。

- [ ] **Step 5: 运行安全测试并提交**

Run: `npx vitest run tests/security tests/contract/futureProviders.test.ts`

Expected: PASS；Trace 日志也不含源码、Diff、Token、URL password。

```bash
git add src/extension/diagnostics packages/domain/src/futureProviders.ts tests/security tests/contract/futureProviders.test.ts
git commit -m "feat: export redacted local diagnostics"
```

### Task 7: Settings/NLS、可访问性与性能 GA 门槛

**Files:**
- Create: `scripts/check-settings.mjs`
- Create: `scripts/check-localization.mjs`
- Create: `l10n/bundle.l10n.json`
- Create: `l10n/bundle.l10n.zh-cn.json`
- Create: `webview/workbench/src/i18n.ts`
- Create: `tests/accessibility/workbench.test.tsx`
- Create: `tests/contract/localization.test.ts`
- Create: `tests/performance/ga.bench.test.ts`
- Modify: `package.nls.json`
- Modify: `package.nls.zh-cn.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 38 项 NLS 完整性检查**

```js
// scripts/check-settings.mjs
import { readFile } from 'node:fs/promises';
const schema = JSON.parse(await readFile('config/settings.schema.json', 'utf8'));
const en = JSON.parse(await readFile('package.nls.json', 'utf8'));
const zh = JSON.parse(await readFile('package.nls.zh-cn.json', 'utf8'));
const missing = [];
for (const key of Object.keys(schema.properties)) {
  const description = `config.${key}`;
  if (en[description] !== schema.properties[key].descriptions.en) missing.push(`en:${description}`);
  if (zh[description] !== schema.properties[key].descriptions.zhCN) missing.push(`zh:${description}`);
  for (const [index, value] of (schema.properties[key].enum ?? []).entries()) {
    const enumKey = `enum.${key}.${String(value)}`;
    if (en[enumKey] !== schema.properties[key].enumDescriptions[index].en || zh[enumKey] !== schema.properties[key].enumDescriptions[index].zhCN) missing.push(enumKey);
  }
}
if (Object.keys(schema.properties).length !== 38 || missing.length) throw new Error(`settings contract failed: ${missing.join(', ')}`);
```

同一步建立完整 UI 本地化合同：Extension Host 的用户可见文案统一使用 `vscode.l10n.t`，默认英文与简体中文分别进入 `l10n/bundle.l10n.json`、`l10n/bundle.l10n.zh-cn.json`；Webview 使用 `i18n.ts` 的固定 Message ID，Host 只把当前 locale 对应的 allowlisted 字符串表传入初始状态，不能让 Webview 请求任意本地文件。`check-localization.mjs`/合同测试扫描 Host/Webview 的 Message ID，要求英中两份 key 集合、ICU/编号占位符和复数分支一致，拒绝新增硬编码的用户可见英文/中文字符串。Git 原始错误不得直译后当稳定分类，仍先映射 Typed Error，再本地化展示。

- [ ] **Step 2: 验证完整键盘/屏幕阅读器/高对比**

使用 axe test adapter 检查工作台；键盘 E2E 覆盖打开 DAG、选择两个端点、切空白、选择 Hunk、应用、解决冲突、恢复、历史计划。状态不只用颜色，所有图标有 accessible name，焦点在刷新后保持或移动到明确目标。

- [ ] **Step 3: 运行 GA 性能预算**

Nightly fixtures：100 万 Commit、25 万文件、10 Repo、20,000 行 Diff、150 MB Cache、200 ms SSH latency。记录 P50/P95/peak RSS；断言规格第 15 节阈值，超阈值路径必须进入可见降级而非 OOM。

- [ ] **Step 4: 提交 Settings/UX/性能门槛**

Run: `node scripts/check-settings.mjs && node scripts/check-localization.mjs && npx vitest run tests/contract/localization.test.ts tests/accessibility tests/performance --pool=forks --maxWorkers=1`

Expected: 38/38 中英文配置通过；Host/Webview 英中 Message ID 与占位符 100% 对齐；可访问性 0 serious/critical；性能达到预算或明确降级断言通过。

```bash
git add scripts/check-settings.mjs scripts/check-localization.mjs package.nls.json package.nls.zh-cn.json l10n webview/workbench/src/i18n.ts tests/contract/localization.test.ts tests/accessibility tests/performance .github/workflows/ci.yml
git commit -m "test: enforce Git Workbench GA quality budgets"
```

### Task 8: 跨平台/Remote、安全供应链与 Stable 发布证据

**Files:**
- Create: `scripts/check-vsix.mjs`
- Create: `docs/release/v1-checklist.md`
- Create: `.github/workflows/nightly.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `.vscodeignore`

- [ ] **Step 1: 写 VSIX 内容 allowlist 检查**

`check-vsix.mjs` 解包 VSIX，拒绝：未声明 executable、`.env`、测试凭据、恢复快照、源码仓库、安装时下载脚本、超过预算的单文件。允许 `dist/**`、Manifest/NLS、README/LICENSE/CHANGELOG、SBOM。

- [ ] **Step 2: 生成并检查 SBOM**

Run: `npm audit --audit-level=high && npm sbom --sbom-format cyclonedx > dist/sbom.cdx.json && npm run package && node scripts/check-vsix.mjs`

Expected: High/Critical 漏洞为 0；SBOM 覆盖生产 Bundle 依赖；VSIX allowlist PASS。

- [ ] **Step 3: 建立真实支持矩阵**

```yaml
# .github/workflows/nightly.yml（核心矩阵）
strategy:
  fail-fast: false
  matrix:
    include:
      - os: macos-15
        arch: arm64
      - os: macos-15-intel
        arch: x64
      - os: windows-2022
        arch: x64
      - os: ubuntu-24.04
        arch: x64
      - os: ubuntu-24.04-arm
        arch: arm64
```

矩阵不使用已于 2025-12-04 退役的 `macos-13`；标签选择依据 [GitHub 官方 runner 公告](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)，并由定期 CI 检查可用性。Hosted Matrix 是快速跨架构门槛，不冒充真实桌面覆盖：VS Code 官方当前支持的 64 位 Windows Client（当前至少 Windows 11）+ Git for Windows、macOS Intel/Apple Silicon 的默认 APFS 与临时 Case-sensitive APFS Volume，以及 Remote SSH、WSL2、Debian/Alpine Dev Container，都由自托管隔离 runner 执行同一签名 VSIX E2E。只有仍被 VS Code 上游明确支持的 Windows 10 LTSC/其他版本才可加入声明，不能用已 EOL 的普通 Windows 10 22H2 扩大兼容口径。某目标 OS 已被 VS Code 上游停止支持时必须先更新产品支持声明与迁移说明；其余必需 runner 缺席时 Release job 阻断，不把缺测写成通过。

- [ ] **Step 4: 执行特殊仓库与安全矩阵**

普通/Shallow/Partial/Sparse/Worktree/Submodule/LFS/Detached/Unborn/SHA-1/SHA-256；中文/Emoji/空格/Tab/换行名；CRLF/LF/Binary/Symlink/Executable Bit；恶意 Ref/Message/Path/Webview XSS；Hook/Signing/Lock/断网/强杀全部生成 JUnit 与性能报告。

- [ ] **Step 5: 写发布证据索引**

`docs/release/v1-checklist.md` 的九行对应规格第 19 节，每行必须链接 CI artifact SHA、测试报告或签名 VSIX hash。Manifest `publisher` 必须替换为用户实际拥有并在 Marketplace 验证的 Publisher ID，并在发布分支把 `private` 改为 `false`；未提供/未验证时 Release job 明确失败，不使用工作名称发布。

- [ ] **Step 6: 运行最终 Gate 并提交**

Run: `npm ci && npm run sync:settings && node scripts/check-settings.mjs && npm run check && npm run test:integration && npm run test:vscode && npx vitest run tests/security tests/accessibility tests/fault-injection tests/e2e --pool=forks --maxWorkers=1 && npm run build && npm audit --audit-level=high && npm sbom --sbom-format cyclonedx > dist/sbom.cdx.json && npm run package && node scripts/check-vsix.mjs`

Expected: 全部 exit 0；工作树 clean；Release workflow 只接受已签名 tag 和已验证 Publisher secret。

```bash
git add scripts/check-vsix.mjs docs/release .github/workflows package.json .vscodeignore
git commit -m "release: enforce Git Workbench V1 gates"
```

## Stable 判定

只有 `docs/release/v1-checklist.md` 九项均附带可验证 artifact，且支持矩阵没有缺席平台时，才把版本提升为 `1.0.0` 并发布 Stable。任何性能、安全、恢复或 Remote 缺口都只能保持 Preview，不能通过修改文案规避门槛。
