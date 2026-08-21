import { describe, expect, test } from 'vitest';

import {
  GitWorkbenchError,
  gitWorkbenchErrorCodes,
  retryAdvices,
  toPresentedError,
} from '@git-workbench/domain';

import { parseHostRequest, parseHostResponse } from './validate.js';

describe('parseHostRequest', () => {
  test('accepts only the versioned repository query envelopes', () => {
    expect(
      parseHostRequest({
        protocol: 1,
        requestId: 'request-1',
        type: 'repository.list',
      }),
    ).toEqual({
      ok: true,
      value: {
        protocol: 1,
        requestId: 'request-1',
        type: 'repository.list',
      },
    });
    expect(
      parseHostRequest({
        protocol: 1,
        requestId: 'request-2',
        type: 'repository.status',
        repositoryId: 'repository identifier',
      }).ok,
    ).toBe(true);
  });

  test.each([
    {
      protocol: 1,
      requestId: 'request-1',
      type: 'repository.status',
    },
    {
      protocol: 1,
      requestId: 'request-1',
      type: 'repository.list',
      repositoryId: 'not-allowed',
    },
    {
      protocol: 1,
      requestId: 'request-2',
      type: 'git.exec',
      args: ['reset', '--hard'],
    },
    {
      protocol: 2,
      requestId: 'request-3',
      type: 'repository.list',
    },
    {
      protocol: 1,
      requestId: '',
      type: 'repository.list',
    },
    {
      protocol: 1,
      requestId: 'r'.repeat(129),
      type: 'repository.list',
    },
    {
      protocol: 1,
      requestId: 'request-4',
      type: 'repository.list',
      diagnosticsId: 'ui-created',
    },
  ])('rejects a non-whitelisted request envelope: %j', (input) => {
    expect(parseHostRequest(input)).toMatchObject({ ok: false });
  });
});

describe('parseHostResponse', () => {
  const presentedError = toPresentedError(
    new GitWorkbenchError({
      code: 'STALE_PLAN',
      operationId: 'operation-1',
      message: 'The repository changed since planning.',
      repositoryChanged: true,
      retry: 'refresh',
    }),
    'diagnostics-1',
  );

  test('accepts a success response or a complete host-presented error', () => {
    expect(
      parseHostResponse({
        protocol: 1,
        requestId: 'request-1',
        ok: true,
        data: { repositories: [] },
      }).ok,
    ).toBe(true);
    expect(
      parseHostResponse({
        protocol: 1,
        requestId: 'request-2',
        ok: false,
        error: presentedError,
      }),
    ).toEqual({
      ok: true,
      value: {
        protocol: 1,
        requestId: 'request-2',
        ok: false,
        error: presentedError,
      },
    });
  });

  test('accepts every complete error DTO that the domain presenter can produce', () => {
    for (const code of gitWorkbenchErrorCodes) {
      for (const retry of retryAdvices) {
        const error = toPresentedError(
          new GitWorkbenchError({
            code,
            operationId: 'operation-1',
            message: 'Error.',
            repositoryChanged: false,
            retry,
          }),
          'diagnostics-1',
        );

        expect(
          parseHostResponse({
            protocol: 1,
            requestId: 'request-1',
            ok: false,
            error,
          }).ok,
        ).toBe(true);
      }
    }
  });

  test.each(['stderr', 'stack', 'cause', 'command', 'env'] as const)(
    'rejects a response that leaks %s',
    (field) => {
      expect(
        parseHostResponse({
          protocol: 1,
          requestId: 'request-1',
          ok: false,
          error: { ...presentedError, [field]: 'sensitive value' },
        }),
      ).toMatchObject({ ok: false });
    },
  );

  test.each([
    {
      code: 'STALE_PLAN',
      retry: 'none',
      suggestedActions: ['authenticate', 'openDiagnostics'],
    },
    {
      code: 'MISSING_LOCAL_OBJECT',
      retry: 'retry',
      suggestedActions: ['retry', 'openDiagnostics'],
    },
    {
      code: 'STALE_PLAN',
      retry: 'reconcile',
      suggestedActions: ['reconcile', 'openDiagnostics'],
    },
    {
      code: 'STALE_PLAN',
      retry: 'reconcile',
      suggestedActions: ['openDiagnostics', 'reconcile', 'openRecovery'],
    },
  ] as const)('rejects an action mapping the presenter cannot produce: %j', (error) => {
    expect(
      parseHostResponse({
        protocol: 1,
        requestId: 'request-1',
        ok: false,
        error: { ...presentedError, ...error },
      }),
    ).toMatchObject({ ok: false });
  });

  test.each([
    { operationId: 'operation id' },
    { diagnosticsId: 'diagnostics id' },
    { suggestedActions: ['retry', 'unknown', 'openDiagnostics'] },
    { suggestedActions: ['retry', 'retry', 'openDiagnostics'] },
  ])('rejects an invalid presented-error field: %j', (error) => {
    expect(
      parseHostResponse({
        protocol: 1,
        requestId: 'request-1',
        ok: false,
        error: { ...presentedError, ...error },
      }),
    ).toMatchObject({ ok: false });
  });

  test.each([
    {
      protocol: 1,
      requestId: 'request-1',
      ok: true,
      data: {},
      error: presentedError,
    },
    {
      protocol: 1,
      requestId: 'request-1',
      ok: false,
      error: {
        code: 'STALE_PLAN',
        message: 'Missing host-generated presentation fields.',
        repositoryChanged: true,
        retry: 'refresh',
      },
    },
    {
      protocol: 1,
      requestId: 'request-1',
      ok: false,
      error: presentedError,
      diagnosticsId: 'ui-created',
    },
  ])('rejects a response outside the discriminated envelope: %j', (input) => {
    expect(parseHostResponse(input)).toMatchObject({ ok: false });
  });
});
