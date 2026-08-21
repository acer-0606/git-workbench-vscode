import type { PresentedError } from '@git-workbench/domain';

export interface RepositoryStatusRequest {
  readonly protocol: 1;
  readonly requestId: string;
  readonly type: 'repository.status';
  readonly repositoryId: string;
}

export interface RepositoryListRequest {
  readonly protocol: 1;
  readonly requestId: string;
  readonly type: 'repository.list';
}

export type HostRequest = RepositoryStatusRequest | RepositoryListRequest;

export type HostResponse<T = unknown> =
  | {
      readonly protocol: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly data: T;
    }
  | {
      readonly protocol: 1;
      readonly requestId: string;
      readonly ok: false;
      readonly error: PresentedError;
    };
