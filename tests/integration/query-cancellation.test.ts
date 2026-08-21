import { describe, expect, it } from 'vitest';
import { createRepositoryFixture } from '@git-workbench/testkit';
import { GitWorkbenchError, type RepositoryId } from '@git-workbench/domain';
import { GitProcessRunner, readLogPage } from '@git-workbench/git-cli';

import { GenerationCache } from '../../src/extension/query/generationCache.js';
import { QueryScheduler } from '../../src/extension/query/queryScheduler.js';
import { ReadModelService } from '../../src/extension/query/readModelService.js';
import { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';

describe('query cancellation', () => {
  it('rejects a cancelled log page, writes nothing to the cache and leaves no dangling work', async () => {
    const fixture = await createRepositoryFixture();
    try {
      await fixture.write('a.txt', 'base\n');
      await fixture.commitAll('base');
      const registry = new RepositoryRegistry();
      const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
      const cache = new GenerationCache(1024 * 1024);
      const runner = new GitProcessRunner('git');
      const repositoryId = 'a'.repeat(64) as RepositoryId;
      let runs = 0;
      const service = new ReadModelService(registry, scheduler, cache, {
        status: async () => ({}),
        refs: async () => ({}),
        logPage: async (id, generation, input, signal) => {
          runs += 1;
          const request = input as { order: 'topo'; limit: number };
          const page = await readLogPage(runner, fixture.path, generation, request.order, request.limit);
          signal.throwIfAborted();
          return page;
        },
      });
      const pending = service.logPage(repositoryId, 1, { order: 'topo', limit: 200 }, 'request-1');
      scheduler.cancel('request-1');
      await expect(pending).rejects.toBeInstanceOf(GitWorkbenchError);
      expect(cache.get('log:{"order":"topo","limit":200}', 1)).toBeUndefined();
      // A later identical query still executes: the cancellation left no phantom inflight entry.
      const fresh = await service.logPage(repositoryId, 1, { order: 'topo', limit: 200 }, 'request-2');
      expect(fresh).toEqual(expect.objectContaining({ rows: expect.any(Array) }));
      // The cancellation arrived before the queued read started, so the port
      // only executed for the follow-up query.
      expect(runs).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });
});
