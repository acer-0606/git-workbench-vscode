import AjvModule from 'ajv';

import {
  gitWorkbenchErrorCodes,
  retryAdvices,
  suggestedActionsForError,
} from '@git-workbench/domain';

import type { HostRequest, HostResponse } from './envelope.js';

const requestIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
} as const;

const identifierSchema = {
  ...requestIdSchema,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;

const presentedErrorVariants = gitWorkbenchErrorCodes.flatMap((code) =>
  retryAdvices.map((retry) => {
    const actions = suggestedActionsForError(code, retry);

    return {
      required: ['code', 'retry', 'suggestedActions'],
      properties: {
        code: { const: code },
        retry: { const: retry },
        suggestedActions: {
          type: 'array',
          minItems: actions.length,
          maxItems: actions.length,
          items: actions.map((action) => ({ const: action })),
          additionalItems: false,
        },
      },
    };
  }),
);

const presentedErrorSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'code',
    'message',
    'repositoryChanged',
    'retry',
    'diagnosticsId',
    'suggestedActions',
  ],
  properties: {
    code: {
      enum: gitWorkbenchErrorCodes,
    },
    operationId: identifierSchema,
    message: { type: 'string' },
    repositoryChanged: { type: 'boolean' },
    retry: { enum: retryAdvices },
    diagnosticsId: identifierSchema,
    suggestedActions: {
      type: 'array',
    },
  },
  allOf: [{ oneOf: presentedErrorVariants }],
} as const;

const endpointKindSchema = {
  enum: ['commit', 'branch', 'tag', 'stash', 'head', 'index', 'workingTree'],
} as const;

const compareEndpointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'value', 'label'],
  properties: {
    kind: endpointKindSchema,
    value: { type: 'string', minLength: 1, maxLength: 512 },
    label: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

const ignoreWhitespaceSchema = {
  enum: ['none', 'eol', 'all'],
} as const;

const compareModeSchema = {
  enum: ['auto', 'direct', 'mergeBase'],
} as const;

const generationSchema = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

const readModelBaseProperties = {
  protocol: { const: 1 },
  requestId: requestIdSchema,
  repositoryId: requestIdSchema,
  generation: generationSchema,
} as const;

const logCursorSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;

export const hostRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type'],
      properties: {
        protocol: { const: 1 },
        requestId: requestIdSchema,
        type: { const: 'repository.list' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId'],
      properties: {
        protocol: { const: 1 },
        requestId: requestIdSchema,
        type: { const: 'repository.status' },
        repositoryId: requestIdSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId', 'generation', 'order', 'limit'],
      properties: {
        ...readModelBaseProperties,
        type: { const: 'log.page' },
        order: { enum: ['topo', 'date', 'authorDate'] },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        cursor: logCursorSchema,
        filter: {
          type: 'object',
          additionalProperties: false,
          maxProperties: 4,
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 256 },
            path: { type: 'string', minLength: 1, maxLength: 1024 },
            sinceEpochSeconds: { type: 'integer', minimum: 0 },
            untilEpochSeconds: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId', 'generation'],
      properties: {
        ...readModelBaseProperties,
        type: { const: 'refs.list' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId', 'generation', 'left', 'right', 'mode', 'ignoreWhitespace'],
      properties: {
        ...readModelBaseProperties,
        type: { const: 'compare.open' },
        left: compareEndpointSchema,
        right: compareEndpointSchema,
        mode: compareModeSchema,
        ignoreWhitespace: ignoreWhitespaceSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId', 'generation', 'digest', 'path', 'ignoreWhitespace', 'pageStart', 'pageLimit'],
      properties: {
        ...readModelBaseProperties,
        type: { const: 'compare.file' },
        digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        path: { type: 'string', minLength: 1, maxLength: 1024 },
        ignoreWhitespace: ignoreWhitespaceSchema,
        pageStart: { type: 'integer', minimum: 0 },
        pageLimit: { type: 'integer', minimum: 1, maximum: 10_000 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId', 'generation', 'endpoint', 'path'],
      properties: {
        ...readModelBaseProperties,
        type: { const: 'content.read' },
        endpoint: compareEndpointSchema,
        path: { type: 'string', minLength: 1, maxLength: 1024 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'type', 'repositoryId', 'generation', 'cancelRequestId'],
      properties: {
        ...readModelBaseProperties,
        type: { const: 'query.cancel' },
        cancelRequestId: requestIdSchema,
      },
    },
  ],
} as const;

export const hostResponseSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'ok', 'data'],
      properties: {
        protocol: { const: 1 },
        requestId: requestIdSchema,
        ok: { const: true },
        data: {},
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'requestId', 'ok', 'error'],
      properties: {
        protocol: { const: 1 },
        requestId: requestIdSchema,
        ok: { const: false },
        error: presentedErrorSchema,
      },
    },
  ],
} as const;

const ajv = new AjvModule.default({ allErrors: true });
const validateHostRequest = ajv.compile(hostRequestSchema);
const validateHostResponse = ajv.compile(hostResponseSchema);

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function parseHostRequest(input: unknown): ParseResult<HostRequest> {
  return validateHostRequest(input)
    ? { ok: true, value: input as HostRequest }
    : { ok: false, message: validationMessage(validateHostRequest.errors) };
}

export function parseHostResponse(input: unknown): ParseResult<HostResponse> {
  return validateHostResponse(input)
    ? { ok: true, value: input as HostResponse }
    : { ok: false, message: validationMessage(validateHostResponse.errors) };
}

function validationMessage(
  errors: readonly { readonly instancePath: string; readonly message?: string }[] | null | undefined,
): string {
  return errors?.map((error) => `${error.instancePath} ${error.message ?? 'invalid'}`).join('; ')
    ?? 'invalid protocol envelope';
}
