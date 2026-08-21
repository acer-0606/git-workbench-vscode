import { createHash, randomUUID } from 'node:crypto';

import type { MutationPlan } from '@git-workbench/domain';

/**
 * Canonical JSON with recursively sorted keys: two plans that differ only in
 * key insertion order produce the same digest, and any change to effects or
 * configFingerprint changes the digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('unsupported plan value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sealPlan(plan: Omit<MutationPlan, 'operationId' | 'planDigest'>): MutationPlan {
  const operationId = randomUUID() as MutationPlan['operationId'];
  const planDigest = createHash('sha256').update(canonicalJson({ ...plan, operationId })).digest('hex');
  return { ...plan, operationId, planDigest };
}
