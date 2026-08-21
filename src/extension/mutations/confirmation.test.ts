import { canonicalJson } from './confirmation.js';
import { describe, expect, it } from 'vitest';

describe('sealPlan digest', () => {
  const base = {
    repositoryId: 'a'.repeat(64),
    commonRepositoryId: 'a'.repeat(64),
    intent: { type: 'commit.create', message: 'msg' },
    baseline: { generation: 1, commonGeneration: 1, indexFingerprint: 'x', pausedOperation: 'none', refs: [], files: [] },
    summary: 's',
    effects: ['refs/heads/main advances'],
    risk: 'normal' as const,
    configFingerprint: 'c'.repeat(64),
  };

  it('is order-insensitive for semantically equal plans', () => {
    const left = canonicalJson({ effects: base.effects, summary: base.summary, intent: base.intent });
    const right = canonicalJson({ intent: base.intent, summary: base.summary, effects: base.effects });
    expect(left).toBe(right);
  });

  it('changes when effects or configuration change', () => {
    const original = canonicalJson(base);
    expect(canonicalJson({ ...base, effects: ['different'] })).not.toBe(original);
    expect(canonicalJson({ ...base, configFingerprint: 'd'.repeat(64) })).not.toBe(original);
  });
});
