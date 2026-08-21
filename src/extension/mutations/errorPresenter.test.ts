import { describe, expect, it } from 'vitest';

import { GitWorkbenchError } from '@git-workbench/domain';

import { presentMutationFailure, redactMessage } from './errorPresenter.js';

describe('errorPresenter', () => {
  it('redacts credentials and home paths', () => {
    expect(redactMessage('push https://user:secret@github.com/org/repo failed', '/Users/demo')).toBe('push https://***@github.com/org/repo failed');
    expect(redactMessage('cannot read /Users/demo/project/file.ts', '/Users/demo')).toBe('cannot read ~/project/file.ts');
    expect(redactMessage('bad\x00\x01bytes', '/x')).toBe('badbytes');
  });

  it('presents operation id, repository change and retry advice for typed errors', () => {
    const error = new GitWorkbenchError({ code: 'STALE_PLAN', operationId: 'op-1', message: '计划已过期', repositoryChanged: true, retry: 'refresh' });
    const presented = presentMutationFailure(error, '/home');
    expect(presented.operationId).toBe('op-1');
    expect(presented.repositoryChanged).toBe(true);
    expect(presented.retryAdvice).toContain('刷新');
  });

  it('falls back to a safe presentation for unknown errors', () => {
    const presented = presentMutationFailure(new Error('boom'), '/home');
    expect(presented.operationId).toBeUndefined();
    expect(presented.retryAdvice).toContain('无法重试');
  });
});
