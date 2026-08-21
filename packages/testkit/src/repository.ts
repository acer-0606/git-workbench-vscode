import { chmod, lstat, mkdtemp, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { GitProcessRunner, type GitRunRequest, type GitRunResult } from '@git-workbench/git-cli';

const MAX_OUTPUT_BYTES = 64 * 1024;
const fixtureEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1' as const,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

export interface RepositoryFixture {
  readonly path: string;
  readonly runner: GitProcessRunner;
  write(relativePath: string, content: string | Uint8Array): Promise<void>;
  commitAll(message: string): Promise<string>;
  addWorktree(branch: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface RepositoryFixtureOptions {
  /** Test seam for exercising retryable cleanup; production callers should omit it. */
  readonly removePath?: (path: string) => Promise<void>;
}

function fixtureError(): Error {
  return new Error('Git fixture command failed');
}

function isGitMetadataComponent(component: string): boolean {
  const normalized = component.replace(/[. ]+$/u, '').toLowerCase();
  return normalized === '.git';
}

function isGitMetadataAlias(component: string): boolean {
  return /^git~\d+$/u.test(component.replace(/[. ]+$/u, '').toLowerCase());
}

function isWindowsReservedName(component: string): boolean {
  const normalized = component.replace(/[. ]+$/u, '');
  const baseName = normalized.split('.', 1)[0]?.toUpperCase().replace(/[¹²³]/gu, (digit) => ({ '¹': '1', '²': '2', '³': '3' })[digit] ?? digit);
  return baseName === 'CON' || baseName === 'PRN' || baseName === 'AUX' || baseName === 'NUL'
    || baseName === 'CONIN$' || baseName === 'CONOUT$' || baseName === 'CLOCK$'
    || /^(COM|LPT)[1-9]$/u.test(baseName ?? '');
}

function assertSupportedPathComponents(requestedPath: string): void {
  for (const component of requestedPath.split(/[\\/]/u)) {
    if (isGitMetadataComponent(component)) throw new TypeError('Fixture file path must not modify Git metadata');
    if (component.includes(':') || component.endsWith('.') || component.endsWith(' ') || isWindowsReservedName(component) || isGitMetadataAlias(component)) {
      throw new TypeError('Fixture file path contains a platform-ambiguous component that is not supported');
    }
    // NTFS accepts control characters in names, but Windows rename/move
    // fails with a misleading ENOENT for such destinations. Reject them
    // explicitly instead of failing deep inside a write.
    if (process.platform === 'win32' && /[\x00-\x1f]/u.test(component)) {
      throw new TypeError('Fixture file path contains control characters that Windows rename cannot target');
    }
  }
}

async function assertTrustedFixtureRoot(repositoryPath: string): Promise<void> {
  const metadata = await lstat(repositoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError('Fixture repository root is not a trusted directory');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new TypeError('Fixture repository root is not private enough for secure writes');
  }
  // Node exposes neither Windows DACL inspection nor openat(FILE_FLAG_OPEN_REPARSE_POINT).
  // On Windows this fixture therefore relies on the standard per-user TMP trust boundary;
  // it deliberately makes no claim of safety against a same-user adversary that can alter it.
}

async function safeRepositoryPath(repositoryPath: string, requestedPath: string): Promise<string> {
  assertSupportedPathComponents(requestedPath);
  if (requestedPath.length === 0 || isAbsolute(requestedPath)) throw new TypeError('Fixture file path must be relative to the repository');
  const target = resolve(repositoryPath, requestedPath);
  const containedPath = relative(repositoryPath, target);
  if (containedPath === '' || containedPath === '..' || containedPath.startsWith(`..${sep}`) || isAbsolute(containedPath)) {
    throw new TypeError('Fixture file path must stay inside the repository');
  }
  if (containedPath.split(sep).some(isGitMetadataComponent)) {
    throw new TypeError('Fixture file path must not modify Git metadata');
  }
  await assertTrustedFixtureRoot(repositoryPath);
  const repositoryRealPath = await realpath(repositoryPath);
  let currentPath = repositoryPath;
  for (const component of containedPath.split(sep)) {
    currentPath = join(currentPath, component);
    try {
      const metadata = await lstat(currentPath);
      if (metadata.isSymbolicLink()) throw new TypeError('Fixture file path must not resolve through a symbolic link');
      const currentRealPath = await realpath(currentPath);
      const relativeRealPath = relative(repositoryRealPath, currentRealPath);
      if (relativeRealPath === '..' || relativeRealPath.startsWith(`..${sep}`) || isAbsolute(relativeRealPath)) {
        throw new TypeError('Fixture file path must not resolve through a symbolic link');
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

async function writeInsideTrustedFixture(repositoryPath: string, requestedPath: string, content: string | Uint8Array): Promise<void> {
  const target = await safeRepositoryPath(repositoryPath, requestedPath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await safeRepositoryPath(repositoryPath, requestedPath);
  // Node has no portable openat-style directory descriptor API. On POSIX, the private
  // fixture root is the trusted boundary; staging there and renaming atomically prevents
  // following a swapped final symlink. Windows retains its documented per-user-TMP limit.
  const stagingPath = join(repositoryPath, `.git-workbench-fixture-${randomUUID()}`);
  const stagingFile = await open(stagingPath, 'wx', 0o600);
  try {
    await stagingFile.writeFile(content);
    await stagingFile.close();
    await rename(stagingPath, target);
  } catch (error) {
    await stagingFile.close().catch(() => undefined);
    await rm(stagingPath, { force: true });
    throw error;
  }
}

class FixtureGitProcessRunner extends GitProcessRunner {
  constructor() {
    super('git');
  }

  override run(request: GitRunRequest): Promise<GitRunResult> {
    return super.run({ ...request, env: { ...request.env, ...fixtureEnvironment } });
  }
}

class RepositoryFixtureManager {
  readonly runner = new FixtureGitProcessRunner();
  readonly linkedWorktrees = new Set<string>();
  private disposed = false;

  constructor(
    readonly path: string,
    private readonly removePath: (path: string) => Promise<void>,
  ) {}

  async run(args: readonly string[], cwd: string, kind: GitRunRequest['kind']): Promise<string> {
    let result;
    try {
      result = await this.runner.run({
        args,
        cwd,
        kind,
        env: fixtureEnvironment,
        maxStdoutBytes: MAX_OUTPUT_BYTES,
        maxStderrBytes: MAX_OUTPUT_BYTES,
      });
    } catch {
      throw fixtureError();
    }
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw fixtureError();
    return result.stdoutText();
  }

  async allocateLinkedWorktreePath(): Promise<string> {
    const worktreePath = await mkdtemp(join(dirname(this.path), `${basename(this.path)}-worktree-`));
    await rm(worktreePath, { recursive: true, force: true });
    return worktreePath;
  }

  async removeLinkedWorktree(worktreePath: string): Promise<void> {
    try {
      await this.run(['worktree', 'remove', '--force', worktreePath], this.path, 'mutation');
    } catch {
      // The main repository or linked directory may already be gone during teardown.
    }
    let removalError: unknown;
    try {
      await this.removePath(worktreePath);
    } catch (error) {
      removalError = error;
    }
    try {
      await this.run(['worktree', 'prune'], this.path, 'mutation');
    } catch {
      // Pruning is best-effort once teardown has begun.
    }
    if (removalError !== undefined) throw removalError;
    this.linkedWorktrees.delete(worktreePath);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const errors: unknown[] = [];
    for (const worktreePath of [...this.linkedWorktrees]) {
      try {
        await this.removeLinkedWorktree(worktreePath);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.removePath(this.path);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Git fixture cleanup failed');
    }
    this.disposed = true;
  }
}

class RealRepositoryFixture implements RepositoryFixture {
  private disposed = false;

  constructor(
    readonly path: string,
    private readonly manager: RepositoryFixtureManager,
  ) {}

  get runner(): GitProcessRunner {
    return this.manager.runner;
  }

  async write(relativePath: string, content: string | Uint8Array): Promise<void> {
    await writeInsideTrustedFixture(this.path, relativePath, content);
  }

  async commitAll(message: string): Promise<string> {
    await this.manager.run(['add', '--all'], this.path, 'mutation');
    await this.manager.run(['commit', '--no-gpg-sign', '-m', message], this.path, 'mutation');
    const oid = (await this.manager.run(['rev-parse', '--verify', 'HEAD'], this.path, 'query')).trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) throw fixtureError();
    return oid;
  }

  async addWorktree(branch: string): Promise<string> {
    const worktreePath = await this.manager.allocateLinkedWorktreePath();
    this.manager.linkedWorktrees.add(worktreePath);
    try {
      await this.manager.run(['worktree', 'add', '--force', '-b', branch, worktreePath], this.path, 'mutation');
    } catch (error) {
      try {
        await this.manager.removeLinkedWorktree(worktreePath);
      } catch {
        // Keep the registered path for a later dispose() retry, without obscuring Git's error.
      }
      throw error;
    }
    return worktreePath;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.manager.dispose();
    this.disposed = true;
  }
}

export async function createRepositoryFixture(options: RepositoryFixtureOptions = {}): Promise<RepositoryFixture> {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'git-workbench-repository-'));
  await chmod(repositoryPath, 0o700);
  const manager = new RepositoryFixtureManager(repositoryPath, options.removePath ?? (async (path) => rm(path, { recursive: true, force: true })));
  try {
    await manager.run(['init', '--initial-branch=main'], repositoryPath, 'mutation');
    await manager.run(['config', '--local', 'user.name', 'Git Workbench Test'], repositoryPath, 'mutation');
    await manager.run(['config', '--local', 'user.email', 'test@git-workbench.invalid'], repositoryPath, 'mutation');
  } catch (error) {
    await manager.dispose().catch(() => undefined);
    throw error;
  }
  return new RealRepositoryFixture(repositoryPath, manager);
}
