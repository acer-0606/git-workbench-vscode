import { describe, expect, test } from 'vitest';

import { parseHostRequest } from './validate.js';

const base = {
  protocol: 1,
  requestId: 'request-1',
  repositoryId: 'repo-a',
  generation: 3,
} as const;

describe('read-model request whitelist', () => {
  test('accepts each bounded read-model request', () => {
    expect(parseHostRequest({ ...base, type: 'refs.list' }).ok).toBe(true);
    expect(parseHostRequest({ ...base, type: 'log.page', order: 'topo', limit: 200 }).ok).toBe(true);
    expect(parseHostRequest({ ...base, type: 'log.page', order: 'date', limit: 1, cursor: 'YWJj', filter: { message: 'fix', path: 'src/a.ts', sinceEpochSeconds: 0, untilEpochSeconds: 1700000000 } }).ok).toBe(true);
    expect(parseHostRequest({
      ...base,
      type: 'compare.open',
      left: { kind: 'branch', value: 'main', label: 'main' },
      right: { kind: 'branch', value: 'topic', label: 'topic' },
      mode: 'auto',
      ignoreWhitespace: 'none',
    }).ok).toBe(true);
    expect(parseHostRequest({ ...base, type: 'compare.file', digest: 'a'.repeat(64), path: 'src/a.ts', ignoreWhitespace: 'eol', pageStart: 0, pageLimit: 500 }).ok).toBe(true);
    expect(parseHostRequest({ ...base, type: 'content.read', endpoint: { kind: 'commit', value: 'a'.repeat(40), label: 'commit' }, path: 'src/a.ts' }).ok).toBe(true);
    expect(parseHostRequest({ ...base, type: 'query.cancel', cancelRequestId: 'request-2' }).ok).toBe(true);
  });

  test.each([
    ['rejects a free-form args field', { ...base, type: 'refs.list', args: ['log', '--all'] }],
    ['rejects a git.exec request type', { ...base, type: 'git.exec', command: 'log' }],
    ['rejects a negative generation', { ...base, generation: -1, type: 'refs.list' }],
    ['rejects an oversized log page', { ...base, type: 'log.page', order: 'topo', limit: 1001 }],
    ['rejects an unknown log order', { ...base, type: 'log.page', order: 'reverse', limit: 10 }],
    ['rejects a malformed cursor', { ...base, type: 'log.page', order: 'topo', limit: 10, cursor: 'not base64url!!' }],
    ['rejects an unknown endpoint kind', { ...base, type: 'compare.open', left: { kind: 'remote', value: 'origin', label: 'origin' }, right: { kind: 'branch', value: 'main', label: 'main' }, mode: 'auto', ignoreWhitespace: 'none' }],
    ['rejects an unknown whitespace state', { ...base, type: 'compare.file', digest: 'a'.repeat(64), path: 'a.ts', ignoreWhitespace: 'trailing', pageStart: 0, pageLimit: 10 }],
    ['rejects a short digest', { ...base, type: 'compare.file', digest: 'abc', path: 'a.ts', ignoreWhitespace: 'none', pageStart: 0, pageLimit: 10 }],
    ['rejects regex-capable filter fields', { ...base, type: 'log.page', order: 'topo', limit: 10, filter: { pattern: '^fix' } }],
  ])('%s', (_name, input) => {
    expect(parseHostRequest(input).ok).toBe(false);
  });
});
