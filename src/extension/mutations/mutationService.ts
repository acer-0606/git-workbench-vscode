import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asCommonRepositoryId, asRepositoryId, type MutationConfirmation, type MutationIntent, type MutationPlan } from '@git-workbench/domain';
import { GitProcessRunner, captureVersionVector, commit, createCliMutationProvider, stagePaths, unstagePaths } from '@git-workbench/git-cli';
import {
  DurableJournal,
  MutationCoordinator,
  RepositoryWriteQueue,
  captureRefCheckpoint,
  restoreIndexWithCas,
  sha256,
  type RefCheckpoint,
} from '@git-workbench/transactions';

import { sealPlan } from './confirmation.js';

export interface MutationWorkspace {
  /** 64-hex branded repository id. */
  readonly repositoryId: string;
  /** 64-hex branded common repository id (shared across linked worktrees). */
  readonly commonRepositoryId: string;
  readonly commonGitDir: string;
  readonly cwd: string;
  readonly generation: number;
  readonly commonGeneration: number;
  readonly configFingerprint: string;
}

/**
 * Plans and executes guarded mutations for one repository. Every execute
 * travels through the MutationCoordinator (queue, journal, preflight,
 * checkpoint, provider, verify); this class never talks to Git directly on
 * the write path.
 */
export class MutationService {
  private readonly runner: GitProcessRunner;
  private readonly coordinator: MutationCoordinator;
  private readonly journalRoot: string;
  private readonly journalRootOwned: boolean;
  private readonly checkpoints = new Map<string, { checkpoint: RefCheckpoint; afterIndexSha256?: string }>();

  constructor(private readonly workspace: MutationWorkspace, options: { runner?: GitProcessRunner; journalRoot?: string } = {}) {
    this.runner = options.runner ?? new GitProcessRunner('git');
    this.journalRootOwned = options.journalRoot === undefined;
    this.journalRoot = options.journalRoot ?? '';
    this.coordinator = new MutationCoordinator(new RepositoryWriteQueue(), new DurableJournal(this.journalRoot), {
      withRepositoryLease: async <T,>(_plan: MutationPlan, action: () => Promise<T>) => action(),
      capture: async () => ({
        baseline: await this.sample(),
        configFingerprint: this.workspace.configFingerprint,
      }),
      checkpoint: async (plan) => {
        this.checkpoints.set(String(plan.operationId), {
          checkpoint: await captureRefCheckpoint({ runner: this.runner, cwd: this.workspace.cwd }, ['HEAD'], this.affectedPaths(plan.intent)),
        });
      },
      invoke: async (plan) => {
        const outcome = await this.invokeIntent(plan.intent);
        if (outcome.outcome === 'success') {
          const entry = this.checkpoints.get(String(plan.operationId));
          if (entry) entry.afterIndexSha256 = await this.indexSha256();
        }
        return outcome;
      },
      verify: async (plan) => this.verifyIntent(plan),
      reconcileFailure: async () => ({ outcome: 'needsAttention' as const }),
      rollbackAfterFailure: async (plan) => {
        const entry = this.checkpoints.get(String(plan.operationId));
        if (!entry?.afterIndexSha256) throw new Error('no checkpoint to roll back to');
        await restoreIndexWithCas(await this.indexPath(), entry.checkpoint, entry.afterIndexSha256);
      },
      bumpGenerations: () => undefined,
    });
  }

  static async withEphemeralJournal(workspace: MutationWorkspace, runner?: GitProcessRunner): Promise<MutationService> {
    const journalRoot = await mkdtemp(join(tmpdir(), 'git-workbench-mutations-'));
    return runner === undefined
      ? new MutationService(workspace, { journalRoot })
      : new MutationService(workspace, { runner, journalRoot });
  }

  async dispose(): Promise<void> {
    if (this.journalRootOwned && this.journalRoot) await rm(this.journalRoot, { recursive: true, force: true });
  }

  async plan(intent: MutationIntent): Promise<MutationPlan> {
    return sealPlan({
      repositoryId: asRepositoryId(this.workspace.repositoryId),
      commonRepositoryId: asCommonRepositoryId(this.workspace.commonRepositoryId),
      intent,
      baseline: await this.sample(),
      summary: summaryFor(intent),
      effects: effectsFor(intent),
      risk: riskFor(intent),
      configFingerprint: this.workspace.configFingerprint,
    });
  }

  async execute(plan: MutationPlan, confirmation: MutationConfirmation): Promise<void> {
    await this.coordinator.execute(plan, confirmation);
  }

  private async sample() {
    return captureVersionVector(this.runner, this.workspace.cwd, {
      generation: this.workspace.generation,
      commonGeneration: this.workspace.commonGeneration,
      refs: ['HEAD'],
    });
  }

  private async invokeIntent(intent: MutationIntent): Promise<{ outcome: 'success' } | { outcome: 'unknown' }> {
    const provider = createCliMutationProvider(this.runner, this.workspace.cwd);
    switch (intent.type) {
      case 'stage.files':
        await stagePaths(provider, intent.paths);
        return { outcome: 'success' };
      case 'unstage.files':
        await unstagePaths(provider, intent.paths, await this.hasHeadCommit());
        return { outcome: 'success' };
      case 'commit.create':
        await commit(provider, { message: intent.message, amend: false });
        return { outcome: 'success' };
      case 'commit.amend':
        await commit(provider, { message: intent.message, amend: true });
        return { outcome: 'success' };
      default:
        throw new Error(`intent not implemented yet: ${intent.type}`);
    }
  }

  private async verifyIntent(plan: MutationPlan): Promise<boolean> {
    const now = await this.sample();
    switch (plan.intent.type) {
      case 'stage.files':
      case 'unstage.files':
        return now.indexFingerprint !== plan.baseline.indexFingerprint;
      case 'commit.create':
      case 'commit.amend':
        return now.headOid !== undefined && now.headOid !== plan.baseline.headOid;
      default:
        return false;
    }
  }

  private affectedPaths(intent: MutationIntent): readonly string[] {
    return 'paths' in intent ? intent.paths : [];
  }

  private async hasHeadCommit(): Promise<boolean> {
    const result = await this.runner.run({ args: ['rev-parse', '--verify', '-q', '--end-of-options', 'HEAD'], cwd: this.workspace.cwd, kind: 'query', maxStdoutBytes: 256, maxStderrBytes: 4096 });
    return result.exitCode === 0;
  }

  private async indexPath(): Promise<string> {
    const result = await this.runner.run({ args: ['rev-parse', '--git-path', 'index'], cwd: this.workspace.cwd, kind: 'query', maxStdoutBytes: 1024, maxStderrBytes: 4096 });
    const path = result.stdoutText().trim();
    return path.startsWith('/') ? path : join(this.workspace.cwd, path);
  }

  private async indexSha256(): Promise<string> {
    return sha256(await readFile(await this.indexPath()).catch(() => Buffer.alloc(0)));
  }
}

const summaryFor = (intent: MutationIntent): string => {
  if (intent.type === 'stage.files') return `暂存 ${intent.paths.length} 个路径`;
  if (intent.type === 'unstage.files') return `取消暂存 ${intent.paths.length} 个路径`;
  if (intent.type === 'commit.create') return '创建提交';
  if (intent.type === 'commit.amend') return '修补提交（旧提交签名将失效）';
  return intent.type;
};

const effectsFor = (intent: MutationIntent): readonly string[] => {
  if (intent.type === 'stage.files' || intent.type === 'unstage.files') return ['index'];
  if (intent.type === 'commit.create' || intent.type === 'commit.amend') return ['HEAD', 'index'];
  return [intent.type];
};

const riskFor = (intent: MutationIntent): MutationPlan['risk'] =>
  intent.type === 'commit.amend' ? 'confirmation' : 'normal';
