export type ConflictKind = 'text' | 'binary' | 'deleteModify' | 'addAdd' | 'submodule' | 'modeChange' | 'rename';

export interface ConflictEntry {
  readonly path: string;
  readonly kind: ConflictKind;
  readonly stages: readonly { readonly stage: 1 | 2 | 3; readonly oid: string; readonly mode: string }[];
}

/**
 * Classifies an unmerged index entry from its stage set: three blob stages
 * are a plain text (or binary-by-content) conflict; missing base means
 * add/add; stage 1 only means delete/modify; a gitlink stage is a submodule.
 */
export function classifyConflict(stages: readonly { stage: 1 | 2 | 3; oid: string; mode: string }[], path: string): ConflictEntry {
  const has = (stage: 1 | 2 | 3): boolean => stages.some((entry) => entry.stage === stage);
  const isGitlink = stages.some((entry) => entry.mode === '160000');
  if (isGitlink) return { path, kind: 'submodule', stages };
  if (has(1) && !has(2)) return { path, kind: 'deleteModify', stages };
  if (has(1) && !has(3)) return { path, kind: 'deleteModify', stages };
  if (!has(1) && has(2) && has(3)) return { path, kind: 'addAdd', stages };
  if (!has(2) || !has(3)) return { path, kind: 'text', stages };
  return { path, kind: 'text', stages };
}
