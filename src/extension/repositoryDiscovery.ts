import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepositoryDescriptor } from '@git-workbench/domain';

export type RepositoryAutoDetectMode = 'openFolders' | 'subFolders' | 'off';

export interface DiscoveryDiagnostic {
  readonly code: 'scanBudgetExceeded' | 'scanTimeExceeded' | 'scanError';
}

export interface DiscoveryOptions {
  readonly mode: RepositoryAutoDetectMode;
  readonly scanDepth: number;
  readonly maxDirectories?: number;
  readonly maxElapsedMs?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly fileSystem?: DiscoveryFileSystem;
}

export interface DiscoveryDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DiscoveryFileSystem {
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): Promise<readonly DiscoveryDirectoryEntry[]>;
  realpath(path: string): Promise<string>;
}

export interface DiscoveryResult {
  readonly repositories: readonly RepositoryDescriptor[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly partial: boolean;
}

export type RepositoryLocator = (path: string) => Promise<RepositoryDescriptor | undefined>;

const DEFAULT_MAX_DIRECTORIES = 10_000;
const DEFAULT_MAX_ELAPSED_MS = 2_000;

function stableRepositories(repositories: Iterable<RepositoryDescriptor>): readonly RepositoryDescriptor[] {
  return [...repositories].sort((left, right) => left.worktreeUri.localeCompare(right.worktreeUri) || left.id.localeCompare(right.id));
}

interface CanonicalDirectoryResult {
  readonly path?: string;
  readonly failed: boolean;
}

const nodeFileSystem: DiscoveryFileSystem = {
  lstat,
  readdir: async (path) => readdir(path, { withFileTypes: true }),
  realpath,
};

async function canonicalDirectory(path: string, fileSystem: DiscoveryFileSystem): Promise<CanonicalDirectoryResult> {
  try {
    const metadata = await fileSystem.lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { failed: false };
    return { path: await fileSystem.realpath(path), failed: false };
  } catch {
    return { failed: true };
  }
}

/**
 * Scans only the explicit workspace roots. The queue is BFS, does not follow
 * links/junctions, and invokes Git only at roots or parents containing `.git`.
 */
export async function discoverRepositories(
  workspaceFolders: readonly string[],
  locate: RepositoryLocator,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  if (options.mode === 'off') return { repositories: [], diagnostics: [], partial: false };
  const repositories = new Map<string, RepositoryDescriptor>();
  const diagnostics: DiscoveryDiagnostic[] = [];
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const locateOnce = async (path: string): Promise<void> => {
    try {
      const descriptor = await locate(path);
      if (descriptor !== undefined) repositories.set(descriptor.id, descriptor);
    } catch {
      // Locator failures are controlled and cannot disclose command output.
    }
  };
  let partial = false;
  const rootResults = await Promise.all(workspaceFolders.map((path) => canonicalDirectory(path, fileSystem)));
  const roots: string[] = [];
  for (const result of rootResults) {
    if (result.failed) { diagnostics.push({ code: 'scanError' }); partial = true; }
    if (result.path !== undefined) roots.push(result.path);
  }
  if (options.mode === 'openFolders') {
    for (const root of roots) await locateOnce(root);
    return { repositories: stableRepositories(repositories.values()), diagnostics, partial };
  }

  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxElapsedMs = options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const now = options.now ?? Date.now;
  const started = now();
  const queue: Array<{ path: string; depth: number }> = [];
  const visited = new Set<string>();
  let reservedDirectories = 0;
  let halted = false;

  const stopForTime = (): boolean => {
    if (options.signal?.aborted) { halted = true; return true; }
    if (now() - started >= maxElapsedMs) {
      diagnostics.push({ code: 'scanTimeExceeded' });
      partial = true;
      halted = true;
      return true;
    }
    return false;
  };

  const reserveDirectory = (): boolean => {
    if (reservedDirectories >= maxDirectories) {
      diagnostics.push({ code: 'scanBudgetExceeded' });
      partial = true;
      halted = true;
      return false;
    }
    reservedDirectories += 1;
    return true;
  };

  for (const root of roots) {
    if (queue.some((entry) => entry.path === root)) continue;
    if (stopForTime() || !reserveDirectory()) break;
    queue.push({ path: root, depth: 0 });
  }

  while (queue.length > 0) {
    if (stopForTime()) break;
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    let entries: readonly DiscoveryDirectoryEntry[];
    try {
      entries = await fileSystem.readdir(current.path);
    } catch {
      diagnostics.push({ code: 'scanError' });
      partial = true;
      continue;
    }
    let hasGitMarker = false;
    for (const entry of entries) {
      if (options.signal?.aborted) break;
      if (entry.name === '.git') { hasGitMarker = true; continue; }
      if (current.depth >= options.scanDepth || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      // Check before each candidate, not just each dequeued directory: a
      // wide directory must not fill the queue beyond the scan budget.
      if (stopForTime() || !reserveDirectory()) break;
      const child = join(current.path, entry.name);
      const canonical = await canonicalDirectory(child, fileSystem);
      if (canonical.failed) { diagnostics.push({ code: 'scanError' }); partial = true; }
      if (canonical.path !== undefined && !visited.has(canonical.path)) queue.push({ path: canonical.path, depth: current.depth + 1 });
    }
    if (hasGitMarker && !options.signal?.aborted) await locateOnce(current.path);
    if (options.signal?.aborted || halted) break;
  }
  return { repositories: stableRepositories(repositories.values()), diagnostics, partial };
}

/** Isolated debounce adapter: VS Code folder events can call this without leaking API types into discovery. */
export class WorkspaceFolderDiscoveryScheduler<T = string> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: readonly T[] = [];
  private active: AbortController | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly run: (folders: readonly T[], signal: AbortSignal) => Promise<void>, private readonly delayMs = 250) {}

  update(folders: readonly T[]): void {
    if (this.disposed) return;
    this.pending = [...folders];
    this.generation += 1;
    this.active?.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.execute(this.pending, generation);
    }, this.delayMs);
  }

  async runNow(folders: readonly T[]): Promise<void> {
    if (this.disposed) return;
    this.pending = [...folders];
    this.generation += 1;
    this.active?.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.execute(this.pending, this.generation);
  }

  private async execute(folders: readonly T[], generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const controller = new AbortController();
    this.active = controller;
    try {
      await this.run(folders, controller.signal);
    } catch {
      // An event-triggered task cannot be allowed to cause an unhandled
      // rejection. Later generations remain authoritative.
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
  }
}
