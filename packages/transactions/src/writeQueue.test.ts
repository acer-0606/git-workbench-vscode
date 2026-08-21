import { describe, expect, it } from 'vitest';

import { RepositoryWriteQueue } from './writeQueue.js';

it('serializes writers across linked worktrees sharing one common repository and releases after failure', async () => {
  const queue = new RepositoryWriteQueue();
  const order: string[] = [];
  const first = queue.run('common-repo', async () => {
    order.push('a:start');
    await Promise.resolve();
    order.push('a:end');
    throw new Error('fail');
  });
  const second = queue.run('common-repo', async () => {
    order.push('b');
  });
  await expect(first).rejects.toThrow('fail');
  await second;
  expect(order).toEqual(['a:start', 'a:end', 'b']);
});

it('runs writers for different common repositories concurrently', async () => {
  const queue = new RepositoryWriteQueue();
  const order: string[] = [];
  const release: (() => void)[] = [];
  const blocked = queue.run('repo-a', () => new Promise<void>((resolve) => { order.push('a:start'); release.push(resolve); }));
  const other = queue.run('repo-b', async () => { order.push('b'); });
  await other;
  expect(order).toEqual(['a:start', 'b']);
  release[0]!();
  await blocked;
  expect(order).toEqual(['a:start', 'b']);
});

it('stops tracking a repository once its queue drains', async () => {
  const queue = new RepositoryWriteQueue();
  await queue.run('repo', async () => undefined);
  const tails = (queue as unknown as { tails: Map<string, unknown> }).tails;
  expect(tails.has('repo')).toBe(false);
});
