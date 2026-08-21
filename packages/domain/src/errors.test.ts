import { describe, expect, test } from 'vitest';

import {
  GitWorkbenchError,
  toPresentedError,
  type GitWorkbenchErrorCode,
  type GitWorkbenchErrorInput,
  type RetryAdvice,
  type SuggestedAction,
} from './errors.js';
import {
  asCommonRepositoryId,
  asObjectId,
  asOperationId,
  asRepoRelativePath,
  asRepositoryId,
} from './ids.js';

describe('identifier validators', () => {
  test.each([
    ['repository', asRepositoryId],
    ['common repository', asCommonRepositoryId],
  ] as const)('%s ids accept lowercase hex and reject non-lowercase variants', (
    _name,
    asId,
  ) => {
    expect(asId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => asId('A'.repeat(64))).toThrow(TypeError);
    expect(() => asId(`${'a'.repeat(63)}A`)).toThrow(TypeError);
  });

  test.each(['a', 'a'.repeat(128)])('accepts operation ids at length %s', (value) => {
    expect(asOperationId(value)).toBe(value);
  });

  test.each(['', 'a'.repeat(129), 'not valid'])
  ('rejects invalid operation ids', (value) => {
    expect(() => asOperationId(value)).toThrow(TypeError);
  });

  test.each(['a'.repeat(40), 'a'.repeat(64)])('accepts object ids of supported lengths', (value) => {
    expect(asObjectId(value)).toBe(value);
  });

  test.each(['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(65), 'A'.repeat(40)])
  ('rejects invalid object ids', (value) => {
    expect(() => asObjectId(value)).toThrow(TypeError);
  });

  test.each([
    '',
    'safe\0name',
    '/outside',
    'C:\\outside',
    'C:/outside',
    'c:\\outside',
    'c:/outside',
    'C:outside',
    'C:../outside',
    '../outside',
    'safe/../outside',
    '.',
    './file',
    'dir/./file',
    'dir//file',
    'dir/',
  ])('rejects escaping repository-relative path %j', (value) => {
    expect(() => asRepoRelativePath(value)).toThrow(TypeError);
  });

  test.each(['\\\\server\\share', '\\outside', '..\\outside', 'safe\\..\\outside'])
  ('handles literal backslash path %j for the host platform', (value) => {
    if (process.platform === 'win32') {
      expect(() => asRepoRelativePath(value)).toThrow(TypeError);
    } else {
      expect(asRepoRelativePath(value)).toBe(value);
    }
  });

  test('accepts a literal backslash filename outside Windows', () => {
    const value = 'literal\\backslash';

    if (process.platform === 'win32') {
      expect(() => asRepoRelativePath(value)).toThrow(TypeError);
    } else {
      expect(asRepoRelativePath(value)).toBe(value);
    }
  });

  test.each([
    'folder:stream',
    'folder/file:stream',
    'CON',
    'prn',
    'AUX',
    'nul',
    'COM1',
    'com9',
    'LPT1',
    'lpt9',
    'con.txt',
    'COM1.log',
    'file.',
    'file ',
    'dir./file',
    'dir /file',
  ])('rejects Windows-unsafe repository-relative path %j', (value) => {
    expect(() => asRepoRelativePath(value, 'win32')).toThrow(TypeError);
  });

  test.each(['normal.txt', 'COM10.txt', 'nested/normal-file'])
  ('accepts Windows-safe repository-relative path %s', (value) => {
    expect(asRepoRelativePath(value, 'win32')).toBe(value);
  });

  test.each(['file.txt', 'safe/nested-file_1.txt', 'folder with spaces/file'])
  ('accepts safe repository-relative path %s', (value) => {
    expect(asRepoRelativePath(value)).toBe(value);
  });
});

describe('GitWorkbenchError', () => {
  test('serializes only the structured stale-plan payload and presents refresh guidance', () => {
    const payload: GitWorkbenchErrorInput = {
      code: 'STALE_PLAN',
      operationId: 'operation_1',
      message: 'The planned repository state is stale.',
      repositoryChanged: true,
      retry: 'refresh',
    };
    const error = new GitWorkbenchError(payload);

    expect(error.toJSON()).toEqual(payload);
    expect(JSON.stringify(error)).not.toContain('stderr');
    expect(toPresentedError(error, 'diag-1').suggestedActions).toEqual([
      'refresh',
      'openDiagnostics',
    ]);
  });

  test('offers object fetching for missing local objects', () => {
    const error = new GitWorkbenchError({
      code: 'MISSING_LOCAL_OBJECT',
      message: 'Object is not available locally.',
      repositoryChanged: false,
      retry: 'none',
    });

    expect(toPresentedError(error, 'diag_1').suggestedActions).toEqual([
      'fetchMissingObjects',
      'openDiagnostics',
    ]);
  });

  test('does not serialize runtime fields outside the error payload contract', () => {
    const error = new GitWorkbenchError({
      code: 'INVALID_INPUT',
      message: 'Invalid input.',
      repositoryChanged: false,
      retry: 'none',
    });
    Object.assign(error, {
      stderr: 'sensitive command output',
      command: 'git status',
      env: { TOKEN: 'secret' },
      dynamic: 'sensitive dynamic field',
    });
    error.stack = 'sensitive stack trace';
    Object.defineProperty(error, 'cause', {
      configurable: true,
      enumerable: true,
      value: 'sensitive cause',
    });

    expect(error.toJSON()).toEqual({
      code: 'INVALID_INPUT',
      message: 'Invalid input.',
      repositoryChanged: false,
      retry: 'none',
    });
    const serialized = [
      JSON.stringify(error),
      JSON.stringify(toPresentedError(error, 'diag-1')),
    ].join('\n');
    for (const secret of [
      'sensitive command output',
      'git status',
      'secret',
      'sensitive stack trace',
      'sensitive cause',
      'sensitive dynamic field',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('validates operation ids before they enter an error payload', () => {
    const valid = new GitWorkbenchError({
      code: 'STALE_PLAN',
      operationId: 'op-1',
      message: 'The plan is stale.',
      repositoryChanged: true,
      retry: 'refresh',
    });

    expect(valid.toJSON().operationId).toBe('op-1');
    expect(() => new GitWorkbenchError({
      code: 'STALE_PLAN',
      operationId: 'not valid',
      message: 'The plan is stale.',
      repositoryChanged: true,
      retry: 'refresh',
    })).toThrow(TypeError);
  });

  test('rejects a diagnostics id outside the operation-id format', () => {
    const error = new GitWorkbenchError({
      code: 'INVALID_INPUT',
      message: 'Invalid input.',
      repositoryChanged: false,
      retry: 'none',
    });

    expect(() => toPresentedError(error, 'diag invalid')).toThrow(
      'Invalid diagnostics id',
    );
  });

  const presentedErrorCases: readonly {
    readonly code: GitWorkbenchErrorCode;
    readonly retry: RetryAdvice;
    readonly suggestedActions: readonly SuggestedAction[];
  }[] = [
    {
      code: 'INVALID_INPUT',
      retry: 'none',
      suggestedActions: ['openDiagnostics'],
    },
    {
      code: 'INVALID_INPUT',
      retry: 'retry',
      suggestedActions: ['retry', 'openDiagnostics'],
    },
    {
      code: 'INVALID_INPUT',
      retry: 'refresh',
      suggestedActions: ['refresh', 'openDiagnostics'],
    },
    {
      code: 'INVALID_INPUT',
      retry: 'reconcile',
      suggestedActions: ['reconcile', 'openRecovery', 'openDiagnostics'],
    },
    {
      code: 'INVALID_INPUT',
      retry: 'authenticate',
      suggestedActions: ['authenticate', 'openDiagnostics'],
    },
    {
      code: 'MISSING_LOCAL_OBJECT',
      retry: 'refresh',
      suggestedActions: ['fetchMissingObjects', 'openDiagnostics'],
    },
  ];

  test.each(presentedErrorCases)(
    'presents $code/$retry with only its mapped actions and diagnostics',
    ({ code, retry, suggestedActions }) => {
      const presented = toPresentedError(
        new GitWorkbenchError({
          code,
          message: 'Error.',
          repositoryChanged: false,
          retry,
        }),
        'diag-1',
      );

      expect(presented.suggestedActions).toEqual(suggestedActions);
      expect(
        presented.suggestedActions.filter((action) => action === 'openDiagnostics'),
      ).toHaveLength(1);
      expect(Object.isFrozen(presented.suggestedActions)).toBe(true);
      expect(() => (presented.suggestedActions as SuggestedAction[]).push('retry'))
        .toThrow(TypeError);
    },
  );
});
