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
