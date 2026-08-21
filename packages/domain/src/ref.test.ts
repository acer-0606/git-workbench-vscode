import { describe, expect, it } from 'vitest';

import { effectiveCompareMode, type CompareEndpoint } from './ref.js';

const endpoint = (kind: CompareEndpoint['kind'], value: string = kind): CompareEndpoint => ({ kind, value, label: value });

describe('effectiveCompareMode', () => {
  it('uses mergeBase only for two branches', () => {
    expect(effectiveCompareMode('auto', endpoint('branch'), endpoint('branch', 'topic'))).toBe('mergeBase');
    expect(effectiveCompareMode('auto', endpoint('commit'), endpoint('commit', 'b'))).toBe('direct');
    expect(effectiveCompareMode('auto', endpoint('branch'), endpoint('workingTree'))).toBe('direct');
    expect(effectiveCompareMode('auto', endpoint('tag'), endpoint('branch', 'topic'))).toBe('direct');
    expect(effectiveCompareMode('auto', endpoint('stash'), endpoint('branch', 'topic'))).toBe('direct');
    expect(effectiveCompareMode('auto', endpoint('index'), endpoint('workingTree'))).toBe('direct');
  });

  it('never rewrites an explicitly requested mode', () => {
    expect(effectiveCompareMode('direct', endpoint('branch'), endpoint('branch', 'topic'))).toBe('direct');
    expect(effectiveCompareMode('mergeBase', endpoint('commit'), endpoint('commit', 'b'))).toBe('mergeBase');
  });
});
