import type { EndpointKind, IgnoreWhitespace, CompareMode } from '@git-workbench/domain';

/**
 * Bounded, whitelist-only read-model request DTOs. Every request carries the
 * repository identity, the read generation it was planned against and a
 * host-unique requestId; no request ever carries free-form Git arguments.
 */
export interface ReadModelRequestBase {
  readonly protocol: 1;
  readonly requestId: string;
  readonly repositoryId: string;
  readonly generation: number;
}

export interface CompareEndpointDto {
  readonly kind: EndpointKind;
  readonly value: string;
  readonly label: string;
}

export interface LogFilterDto {
  readonly message?: string;
  readonly path?: string;
  readonly sinceEpochSeconds?: number;
  readonly untilEpochSeconds?: number;
}

export interface LogPageRequest extends ReadModelRequestBase {
  readonly type: 'log.page';
  readonly order: 'topo' | 'date' | 'authorDate';
  readonly limit: number;
  readonly cursor?: string;
  readonly filter?: LogFilterDto;
}

export interface RefsListRequest extends ReadModelRequestBase {
  readonly type: 'refs.list';
}

export interface CompareOpenRequest extends ReadModelRequestBase {
  readonly type: 'compare.open';
  readonly left: CompareEndpointDto;
  readonly right: CompareEndpointDto;
  readonly mode: CompareMode;
  readonly ignoreWhitespace: IgnoreWhitespace;
}

export interface CompareFileRequest extends ReadModelRequestBase {
  readonly type: 'compare.file';
  readonly digest: string;
  readonly path: string;
  readonly ignoreWhitespace: IgnoreWhitespace;
  readonly pageStart: number;
  readonly pageLimit: number;
}

export interface ContentReadRequest extends ReadModelRequestBase {
  readonly type: 'content.read';
  readonly endpoint: CompareEndpointDto;
  readonly path: string;
}

export interface QueryCancelRequest extends ReadModelRequestBase {
  readonly type: 'query.cancel';
  readonly cancelRequestId: string;
}
