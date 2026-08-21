import { asOperationId, type OperationId } from './ids.js';

export const gitWorkbenchErrorCodes = [
  'INVALID_INPUT',
  'STALE_PLAN',
  'REPOSITORY_LOCKED',
  'WORKSPACE_UNTRUSTED',
  'CONFLICT_PAUSED',
  'POSTCONDITION_FAILED',
  'AUTH_REQUIRED',
  'LEASE_REJECTED',
  'UNSUPPORTED_GIT_CAPABILITY',
  'PARSER_UNSUPPORTED',
  'MISSING_LOCAL_OBJECT',
  'UNSAFE_LINE_SELECTION',
  'TOO_LARGE',
  'CORRUPT_REPOSITORY',
  'CANCELLED',
] as const;

export type GitWorkbenchErrorCode = (typeof gitWorkbenchErrorCodes)[number];

export const retryAdvices = [
  'none',
  'retry',
  'refresh',
  'reconcile',
  'authenticate',
] as const;

export type RetryAdvice = (typeof retryAdvices)[number];

export const suggestedActions = [
  'retry',
  'refresh',
  'reconcile',
  'authenticate',
  'fetchMissingObjects',
  'openRecovery',
  'openDiagnostics',
] as const;

export type SuggestedAction = (typeof suggestedActions)[number];

export interface GitWorkbenchErrorPayload {
  readonly code: GitWorkbenchErrorCode;
  readonly operationId?: OperationId;
  readonly message: string;
  readonly repositoryChanged: boolean;
  readonly retry: RetryAdvice;
}

export interface GitWorkbenchErrorInput {
  readonly code: GitWorkbenchErrorCode;
  readonly operationId?: string;
  readonly message: string;
  readonly repositoryChanged: boolean;
  readonly retry: RetryAdvice;
}

export class GitWorkbenchError extends Error {
  readonly payload: GitWorkbenchErrorPayload;

  constructor(input: GitWorkbenchErrorInput) {
    super(input.message);
    this.name = 'GitWorkbenchError';

    const { operationId, ...payload } = input;
    this.payload = {
      ...payload,
      ...(operationId === undefined ? {} : { operationId: asOperationId(operationId) }),
    };
  }

  toJSON(): GitWorkbenchErrorPayload {
    const { code, operationId, message, repositoryChanged, retry } = this.payload;

    return {
      code,
      ...(operationId === undefined ? {} : { operationId }),
      message,
      repositoryChanged,
      retry,
    };
  }
}

export interface PresentedError extends GitWorkbenchErrorPayload {
  readonly diagnosticsId: string;
  readonly suggestedActions: readonly SuggestedAction[];
}

export function suggestedActionsForError(
  code: GitWorkbenchErrorCode,
  retry: RetryAdvice,
): readonly SuggestedAction[] {
  const primary: readonly SuggestedAction[] =
    code === 'MISSING_LOCAL_OBJECT'
      ? ['fetchMissingObjects']
      : retry === 'retry'
        ? ['retry']
        : retry === 'refresh'
          ? ['refresh']
          : retry === 'reconcile'
            ? ['reconcile', 'openRecovery']
            : retry === 'authenticate'
              ? ['authenticate']
              : [];

  return Object.freeze([...primary, 'openDiagnostics']);
}

export function toPresentedError(
  error: GitWorkbenchError,
  diagnosticsId: string,
): PresentedError {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(diagnosticsId)) {
    throw new TypeError('Invalid diagnostics id');
  }

  return {
    ...error.toJSON(),
    diagnosticsId,
    suggestedActions: suggestedActionsForError(error.payload.code, error.payload.retry),
  };
}
