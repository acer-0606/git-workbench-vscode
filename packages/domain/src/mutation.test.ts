import { describe, expect, it } from 'vitest';

import { compareVersionVectors, type VersionVector } from './versionVector.js';

const base: VersionVector = {
  generation: 3,
  commonGeneration: 7,
  headOid: 'a'.repeat(40),
  headName: 'main',
  indexFingerprint: 'i1',
  pausedOperation: 'none',
  refs: [{ ref: 'refs/heads/topic', oid: 'b'.repeat(40) }],
  files: [{ path: 'a.ts', hash: 'h1', mode: '100644', exists: true }],
};

describe('compareVersionVectors', () => {
  it('rejects a plan when HEAD, index or an affected file changed', () => {
    expect(compareVersionVectors(base, { ...base, generation: 4 })).toContain('generation');
    expect(compareVersionVectors(base, { ...base, commonGeneration: 8 })).toContain('commonGeneration');
    expect(compareVersionVectors(base, { ...base, headOid: 'c'.repeat(40) })).toContain('head');
    expect(compareVersionVectors(base, { ...base, headName: 'develop' })).toContain('head');
    expect(compareVersionVectors(base, { ...base, indexFingerprint: 'i2' })).toContain('index');
    expect(compareVersionVectors(base, { ...base, pausedOperation: 'merge' })).toContain('pausedOperation');
    expect(compareVersionVectors(base, { ...base, refs: [{ ref: 'refs/heads/topic', oid: 'c'.repeat(40) }] })).toContain('ref:refs/heads/topic');
    expect(compareVersionVectors(base, { ...base, refs: [] })).toContain('ref:refs/heads/topic');
    expect(compareVersionVectors(base, { ...base, files: [{ ...base.files[0]!, hash: 'h2' }] })).toContain('file:a.ts');
    expect(compareVersionVectors(base, { ...base, files: [{ ...base.files[0]!, exists: false }] })).toContain('file:a.ts');
    expect(compareVersionVectors(base, { ...base, files: [{ ...base.files[0]!, documentVersion: 4, documentDirty: true }] })).toContain('file:a.ts');
  });

  it('accepts an unchanged baseline and ignores facts the plan did not record', () => {
    expect(compareVersionVectors(base, base)).toEqual([]);
    expect(compareVersionVectors(base, { ...base, refs: [...base.refs, { ref: 'refs/heads/other', oid: 'd'.repeat(40) }], files: [...base.files, { path: 'b.ts', hash: 'x', mode: '100644', exists: true }] })).toEqual([]);
  });
});
