export interface FileVersion {
  readonly path: string;
  readonly hash: string;
  readonly mode: string;
  readonly exists: boolean;
  readonly documentVersion?: number;
  readonly documentDirty?: boolean;
}

export type { PausedOperationKind } from './pausedOperation.js';
type VersionVectorPausedOperation = import('./pausedOperation.js').PausedOperationKind | 'none';

export interface RefVersion {
  readonly ref: string;
  readonly oid?: string;
  readonly symbolicTarget?: string;
}

export interface VersionVector {
  readonly generation: number;
  readonly commonGeneration: number;
  readonly headOid?: string;
  readonly headName?: string;
  readonly indexFingerprint: string;
  readonly pausedOperation: VersionVectorPausedOperation;
  readonly refs: readonly RefVersion[];
  readonly files: readonly FileVersion[];
}

/**
 * Returns one mismatch token per changed fact. An empty result means the
 * plan's baseline still matches reality; any entry makes the plan stale.
 */
export function compareVersionVectors(expected: VersionVector, actual: VersionVector): string[] {
  const mismatches: string[] = [];
  if (expected.generation !== actual.generation) mismatches.push('generation');
  if (expected.commonGeneration !== actual.commonGeneration) mismatches.push('commonGeneration');
  if (expected.headOid !== actual.headOid || expected.headName !== actual.headName) mismatches.push('head');
  if (expected.indexFingerprint !== actual.indexFingerprint) mismatches.push('index');
  if (expected.pausedOperation !== actual.pausedOperation) mismatches.push('pausedOperation');
  const actualRefs = new Map(actual.refs.map((ref) => [ref.ref, ref]));
  for (const ref of expected.refs) {
    const current = actualRefs.get(ref.ref);
    if (!current || ref.oid !== current.oid || ref.symbolicTarget !== current.symbolicTarget) mismatches.push(`ref:${ref.ref}`);
  }
  const actualFiles = new Map(actual.files.map((file) => [file.path, file]));
  for (const file of expected.files) {
    const current = actualFiles.get(file.path);
    if (!current || file.hash !== current.hash || file.mode !== current.mode || file.exists !== current.exists || file.documentVersion !== current.documentVersion || file.documentDirty !== current.documentDirty) mismatches.push(`file:${file.path}`);
  }
  return mismatches;
}
