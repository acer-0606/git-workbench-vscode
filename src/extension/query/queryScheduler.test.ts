import { describe, expect, it, vi } from 'vitest';

import { GitWorkbenchError } from '@git-workbench/domain';

import { QueryScheduler } from './queryScheduler.js';

const transient = (message = 'busy'): Error & { readonly transientQuery: boolean } =>
  Object.assign(new Error(message), { transientQuery: true });

describe('QueryScheduler concurrency', () => {
  it('reuses identical inflight work and caps a repository at two reads', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn(async () => 42);
    const first = scheduler.run('repo', 'status:1', 'request-1', work);
    const second = scheduler.run('repo', 'status:1', 'request-2', work);
    expect(await first).toBe(42);
    expect(await second).toBe(42);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent reads per repository and globally', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 2, repositoryLimit: 1 });
    const running: number[] = [];
    let peak = 0;
    const work = vi.fn(async () => {
      running.push(1);
      peak = Math.max(peak, running.length);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running.pop();
      return peak;
    });
    const runs = Array.from({ length: 6 }, (_, index) => scheduler.run('repo', `log:${index}`, `request-${index}`, work));
    const peaks = await Promise.all(runs);
    expect(Math.max(...peaks)).toBe(1);
    const otherRepo = Array.from({ length: 4 }, (_, index) => scheduler.run('other', `log:${index}`, `other-${index}`, work));
    await Promise.all(otherRepo);
    expect(work).toHaveBeenCalledTimes(10);
  });

  it('does not start queued work that was cancelled while waiting', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 1, repositoryLimit: 1 });
    const release = new Promise<void>((resolve) => {
      void resolve;
      setTimeout(resolve, 20);
    });
    const first = scheduler.run('repo', 'a', 'request-1', async () => {
      await release;
      return 1;
    });
    const work = vi.fn(async () => 2);
    const second = scheduler.run('repo', 'b', 'request-2', work);
    scheduler.cancel('request-2');
    await expect(second).rejects.toBeInstanceOf(GitWorkbenchError);
    expect(await first).toBe(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('aborts the shared controller when the last subscriber cancels', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    let observedSignal: AbortSignal | undefined;
    let rejectHanging: ((error: unknown) => void) | undefined;
    const hanging = new Promise<number>((_resolve, reject) => {
      rejectHanging = reject;
      setTimeout(() => reject(new Error('should have been aborted')), 500);
    });
    const run = scheduler.run('repo', 'status', 'request-1', async (signal) => {
      observedSignal = signal;
      signal.addEventListener('abort', () => rejectHanging?.(new GitWorkbenchError({ code: 'CANCELLED', message: 'aborted', repositoryChanged: false, retry: 'none' })), { once: true });
      return await hanging;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    scheduler.cancel('request-1');
    await expect(run).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('cancelling one subscriber of a shared request leaves the other subscriber intact', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn(async () => 7);
    const surviving = scheduler.run('repo', 'status:1', 'request-1', work);
    const cancelled = scheduler.run('repo', 'status:1', 'request-2', work);
    scheduler.cancel('request-2');
    await expect(cancelled).rejects.toBeInstanceOf(GitWorkbenchError);
    expect(await surviving).toBe(7);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate requestId before entering the scheduler', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn(async () => 1);
    const first = scheduler.run('repo', 'a', 'request-1', work);
    const duplicate = scheduler.run('repo', 'b', 'request-1', work);
    await expect(duplicate).rejects.toThrow(/duplicate requestId/);
    expect(await first).toBe(1);
  });
});

describe('QueryScheduler retry policy', () => {
  it('retries only explicitly classified transient reads at most twice', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(42);
    await expect(scheduler.run('repo', 'status:2', 'request-3', work)).resolves.toBe(42);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('gives up after the second transient retry', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn().mockRejectedValue(transient());
    await expect(scheduler.run('repo', 'status:3', 'request-4', work)).rejects.toThrow('busy');
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-transient failures', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
    const work = vi.fn().mockRejectedValue(new Error('parse failure'));
    await expect(scheduler.run('repo', 'status:4', 'request-5', work)).rejects.toThrow('parse failure');
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('QueryScheduler write-priority pausing', () => {
  it('stops new background reads while a repository is paused and resumes afterwards', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 4 });
    const work = vi.fn(async () => 'ok');
    scheduler.pauseRepository('repo');
    const queued = scheduler.run('repo', 'status', 'request-1', work);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(work).not.toHaveBeenCalled();
    scheduler.resumeRepository('repo');
    expect(await queued).toBe('ok');
  });

  it('always resumes a repository after a mutation, even when the mutation fails', async () => {
    const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 4 });
    const attemptWrite = async (): Promise<void> => {
      scheduler.pauseRepository('repo');
      try {
        throw new Error('mutation failed');
      } finally {
        scheduler.resumeRepository('repo');
      }
    };
    await expect(attemptWrite()).rejects.toThrow('mutation failed');
    const work = vi.fn(async () => 'read');
    expect(await scheduler.run('repo', 'status', 'request-2', work)).toBe('read');
  });
});
