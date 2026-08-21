import { describe, expect, it, vi } from 'vitest';

import { ReadModelService } from './readModelService.js';
import { GenerationCache } from './generationCache.js';
import { QueryScheduler } from './queryScheduler.js';
import { RepositoryRegistry } from '../repositoryRegistry.js';

const makeService = () => {
  const registry = new RepositoryRegistry();
  const scheduler = new QueryScheduler({ globalLimit: 4, repositoryLimit: 2 });
  const cache = new GenerationCache(64 * 1024);
  const ports = {
    status: vi.fn(async () => ({ ahead: 1 })),
    refs: vi.fn(async () => ({ refs: [] })),
    logPage: vi.fn(async () => ({ rows: [] })),
  };
  return { service: new ReadModelService(registry, scheduler, cache, ports), ports, registry };
};

describe('ReadModelService', () => {
  it('serves repeat queries from the generation cache without re-running Git', async () => {
    const { service, ports } = makeService();
    const first = await service.status('a'.repeat(64) as never, 3, 'request-1');
    const second = await service.status('a'.repeat(64) as never, 3, 'request-2');
    expect(first).toEqual({ ahead: 1 });
    expect(second).toEqual({ ahead: 1 });
    expect(ports.status).toHaveBeenCalledTimes(1);
  });

  it('never serves a cached value from a stale generation', async () => {
    const { service, ports } = makeService();
    await service.refs('a'.repeat(64) as never, 3, 'request-1');
    await service.refs('a'.repeat(64) as never, 4, 'request-2');
    expect(ports.refs).toHaveBeenCalledTimes(2);
  });

  it('exposes registry repositories by display name', () => {
    const { service, registry } = makeService();
    registry.replace([{
      id: 'a'.repeat(64) as never,
      commonRepositoryId: 'a'.repeat(64) as never,
      worktreeUri: '/work/projects/demo',
      commonDirUri: '/work/projects/demo/.git',
      mode: 'readWrite',
      objectFormat: 'sha1',
    }]);
    expect(service.repositories()).toEqual([{ id: 'a'.repeat(64), name: 'demo' }]);
  });
});
