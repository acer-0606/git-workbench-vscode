import { describe, expect, it } from 'vitest';

import { redactDiagnostics } from '../../src/extension/diagnostics/redactor.js';

describe('diagnostics redaction', () => {
  it.each([true, false])('removes credentials even when redactPaths=%s', (redactPaths) => {
    const value = redactDiagnostics({
      version: '0.0.1',
      remoteUrls: ['https://user:secret@example.com/org/repo.git'],
      notes: 'token: ghp_value123456789012345 in a log line',
      paths: ['/Users/alice/private/repo'],
    }, { redactPaths });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toMatch(/secret|ghp_value123456789012345/);
    if (redactPaths) expect(serialized).not.toContain('/Users/alice');
    if (!redactPaths) expect(serialized).toContain('/Users/alice');
  });

  it('drops URL credentials and query strings through the URL parser', () => {
    const value = redactDiagnostics({ version: '1', remoteUrls: ['https://bob:hunter2@example.com/org/repo.git?token=abc'] }, { redactPaths: true });
    expect(value.remoteUrls[0]).toBe('https://example.com/org/repo.git');
  });

  it('only exports allowlisted fields and normalizes durations', () => {
    const value = redactDiagnostics({
      version: '1.2.3',
      capabilities: ['noLazyFetch'],
      errorCodes: ['STALE_PLAN'],
      operationStates: ['Committed'],
      durationsMs: [12, -5, Number.POSITIVE_INFINITY, 30],
    }, { redactPaths: true });
    expect(value.durationsMs).toEqual([12, 30]);
    expect(Object.keys(value).sort()).toEqual(['capabilities', 'durationsMs', 'errorCodes', 'notes', 'operationStates', 'pathHashes', 'paths', 'remoteUrls', 'schema', 'version']);
  });

  it('hashes paths for stable correlation without revealing them', () => {
    const value = redactDiagnostics({ version: '1', paths: ['/Users/alice/repo'] }, { redactPaths: true });
    expect(value.paths).toEqual([]);
    expect(value.pathHashes[0]).toMatch(/^[0-9a-f]{16}$/);
  });
});
