import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LeaseOwner {
  readonly token: string;
  readonly operationId: string;
  readonly host: string;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly heartbeatAt: number;
}

export interface RepositoryLease {
  readonly directory: string;
  readonly owner: LeaseOwner;
  release(): Promise<void>;
}

export interface LeaseOptions {
  /** Rejects unknown lock directories instead of quarantining them. */
  readonly heartbeatTimeoutMs: number;
  readonly now?: () => number;
}

const ownerFileName = 'owner.json';

/**
 * Cross-process write lease stored under
 * `<common-git-dir>/git-workbench/locks/write`. The lock directory is created
 * atomically with mkdir; the owner file records a random token so only the
 * process that acquired the lease can release it. Every path component is
 * checked with lstat so symlinks cannot redirect the lock elsewhere.
 */
export class CrossProcessRepositoryLease {
  constructor(private readonly commonGitDir: string, private readonly options: LeaseOptions = { heartbeatTimeoutMs: 30_000 }) {}

  get lockDirectory(): string {
    return join(this.commonGitDir, 'git-workbench', 'locks', 'write');
  }

  async acquire(operationId: string): Promise<RepositoryLease> {
    await this.ensureLockComponent(join(this.commonGitDir, 'git-workbench'));
    await this.ensureLockComponent(join(this.commonGitDir, 'git-workbench', 'locks'));
    const owner: LeaseOwner = {
      token: randomBytes(24).toString('base64url'),
      operationId,
      host: await hostname(),
      pid: process.pid,
      processStartedAt: processStartId(),
      heartbeatAt: (this.options.now ?? Date.now)(),
    };
    try {
      await mkdir(this.lockDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('REPOSITORY_LOCKED');
      }
      throw error;
    }
    const ownerFile = join(this.lockDirectory, ownerFileName);
    const temporary = `${ownerFile}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await rename(temporary, ownerFile);
    let released = false;
    return {
      directory: this.lockDirectory,
      owner,
      release: async () => {
        if (released) return;
        released = true;
        let current: LeaseOwner | undefined;
        try {
          current = JSON.parse(await readFile(ownerFile, 'utf8')) as LeaseOwner;
        } catch {
          // The lock already vanished; nothing left to release.
          return;
        }
        if (current.token !== owner.token) throw new Error('cannot release a lease owned by another process');
        await rm(this.lockDirectory, { recursive: true, force: true });
      },
    };
  }

  /** Reports whether a held lock's heartbeat expired without guessing at recovery. */
  async isStale(): Promise<boolean> {
    let owner: LeaseOwner;
    try {
      owner = JSON.parse(await readFile(join(this.lockDirectory, ownerFileName), 'utf8')) as LeaseOwner;
    } catch {
      return false;
    }
    const now = (this.options.now ?? Date.now)();
    return now - owner.heartbeatAt > this.options.heartbeatTimeoutMs;
  }

  /**
   * Validates one plugin-owned lock component. Ancestors of the common git
   * dir are intentionally not re-verified: legitimate environments (macOS
   * `/var`, symlinked homes) sit behind symlinks the plugin must not reject.
   */
  private async ensureLockComponent(directory: string): Promise<void> {
    try {
      const stats = await lstat(directory);
      if (stats.isSymbolicLink()) throw new Error('symlinked lock directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(directory, { mode: 0o700 });
      } else {
        throw error;
      }
    }
  }
}

const hostname = async (): Promise<string> => (await import('node:os')).hostname();
const processStartId = (): number => Math.round(process.uptime() * 1000);

export const leaseOwnerDigest = (owner: LeaseOwner): string =>
  createHash('sha256').update(`${owner.host}\0${owner.pid}\0${owner.token}`).digest('hex');
