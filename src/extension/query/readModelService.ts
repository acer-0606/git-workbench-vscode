import { basename } from 'node:path';

import type { RepositoryId } from '@git-workbench/domain';

import type { GenerationCache } from './generationCache.js';
import type { QueryScheduler } from './queryScheduler.js';
import type { RepositoryRegistry } from '../repositoryRegistry.js';

/**
 * The only place where the scheduler, the generation cache and the Git query
 * ports are composed. Every read goes through the same path: cache hit first,
 * then a bounded, cancellable, deduplicated scheduler run keyed by
 * `repositoryId + queryKey`.
 */
export class ReadModelService {
  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly scheduler: QueryScheduler,
    private readonly cache: GenerationCache,
    private readonly ports: {
      status(repositoryId: RepositoryId, generation: number, signal: AbortSignal): Promise<unknown>;
      refs(repositoryId: RepositoryId, generation: number, signal: AbortSignal): Promise<unknown>;
      logPage(repositoryId: RepositoryId, generation: number, input: unknown, signal: AbortSignal): Promise<unknown>;
    },
  ) {}

  status(repositoryId: RepositoryId, generation: number, requestId: string): Promise<unknown> {
    return this.query(repositoryId, `status:${repositoryId}`, generation, requestId, (signal) => this.ports.status(repositoryId, generation, signal));
  }

  refs(repositoryId: RepositoryId, generation: number, requestId: string): Promise<unknown> {
    return this.query(repositoryId, `refs:${repositoryId}`, generation, requestId, (signal) => this.ports.refs(repositoryId, generation, signal));
  }

  logPage(repositoryId: RepositoryId, generation: number, input: unknown, requestId: string): Promise<unknown> {
    return this.query(repositoryId, `log:${JSON.stringify(input)}`, generation, requestId, (signal) => this.ports.logPage(repositoryId, generation, input, signal));
  }

  repositories(): readonly { readonly id: RepositoryId; readonly name: string }[] {
    return this.registry.list().map((repository) => ({ id: repository.id, name: basename(repository.worktreeUri) || repository.worktreeUri }));
  }

  private query(repositoryId: RepositoryId, key: string, generation: number, requestId: string, work: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const cached = this.cache.get<unknown>(key, generation);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.scheduler.run(String(repositoryId), key, requestId, async (signal) => {
      const value = await work(signal);
      signal.throwIfAborted();
      this.cache.set(key, generation, value, JSON.stringify(value ?? null).length * 2);
      return value;
    });
  }
}
