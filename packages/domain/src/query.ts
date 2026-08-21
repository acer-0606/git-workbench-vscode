import type { RepositoryId } from './ids.js';

export interface QueryContext {
  readonly repositoryId: RepositoryId;
  readonly generation: number;
  readonly requestId: string;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export const queryKey = (name: string, input: unknown): string => `${name}:${JSON.stringify(input)}`;
