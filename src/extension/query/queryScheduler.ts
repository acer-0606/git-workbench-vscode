import { GitWorkbenchError } from '@git-workbench/domain';

interface Subscriber<T> { readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void }
interface InflightEntry<T> { readonly controller: AbortController; readonly subscribers: Map<string, Subscriber<T>> }
interface QueuedRead { readonly repositoryId: string; readonly signal: AbortSignal; readonly start: () => void; readonly cancel: () => void }

export interface QuerySchedulerLimits {
  readonly globalLimit: number;
  readonly repositoryLimit: number;
}

interface RetryPolicy { readonly maxRetries: number; readonly baseDelayMs: number }

/**
 * Bounds concurrent read queries, reuses identical inflight work and lets a
 * writer pause a repository's background reads entirely. Cancellation is
 * per-request: subscribers share one Git child process, and the process only
 * aborts when the last subscriber of a query goes away.
 */
export class QueryScheduler {
  private activeGlobal = 0;
  private readonly activeByRepository = new Map<string, number>();
  private readonly inflight = new Map<string, InflightEntry<unknown>>();
  private readonly knownRequestIds = new Set<string>();
  private readonly queue: QueuedRead[] = [];
  private readonly pausedRepositories = new Set<string>();

  constructor(
    private readonly limits: QuerySchedulerLimits,
    private readonly retry: RetryPolicy = { maxRetries: 2, baseDelayMs: 50 },
  ) {}

  run<T>(repositoryId: string, key: string, requestId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.knownRequestIds.has(requestId)) return Promise.reject(new Error(`duplicate requestId: ${requestId}`));
    this.knownRequestIds.add(requestId);
    const compound = `${repositoryId}\0${key}`;
    const existing = this.inflight.get(compound) as InflightEntry<T> | undefined;
    const promise = existing ? this.subscribe(existing, requestId) : this.start(repositoryId, compound, requestId, work);
    void promise.catch(() => undefined).finally(() => this.knownRequestIds.delete(requestId));
    return promise;
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

  pauseRepository(repositoryId: string): void {
    this.pausedRepositories.add(repositoryId);
  }

  resumeRepository(repositoryId: string): void {
    this.pausedRepositories.delete(repositoryId);
    this.drain();
  }

  private start<T>(repositoryId: string, compound: string, requestId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

  private subscribe<T>(entry: InflightEntry<T>, requestId: string): Promise<T> {
    if (entry.subscribers.has(requestId)) return Promise.reject(new Error(`duplicate requestId: ${requestId}`));
    return new Promise<T>((resolve, reject) => entry.subscribers.set(requestId, { resolve, reject }));
  }

  private acquire(repositoryId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.canRun(repositoryId)) {
      this.mark(repositoryId, 1);
      return Promise.resolve();
    }
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
    return !this.pausedRepositories.has(repositoryId)
      && this.activeGlobal < this.limits.globalLimit
      && (this.activeByRepository.get(repositoryId) ?? 0) < this.limits.repositoryLimit;
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
    for (;;) {
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
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          let timer: ReturnType<typeof setTimeout>;
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, this.retry.baseDelayMs * (2 ** attempt));
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }
}
