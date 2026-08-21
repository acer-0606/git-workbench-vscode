export interface RawDiffToken {
  readonly id: string;
  readonly repositoryId: string;
  readonly generation: number;
  readonly leftIdentity: string;
  readonly rightIdentity: string;
  readonly rawDigest: string;
  readonly viewDigest: string;
}

export type PatchTarget =
  | { readonly kind: 'index' }
  | { readonly kind: 'workingTree' }
  | { readonly kind: 'newWorktree'; readonly branchOid: string; readonly directoryUri: string };

export type PatchSelectionItem =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'hunk'; readonly path: string; readonly rawHunkId: string }
  | { readonly kind: 'lines'; readonly path: string; readonly rawHunkId: string; readonly lineIds: readonly string[] };

export interface PatchSelection {
  readonly tokenId: string;
  readonly generation: number;
  readonly viewDigest: string;
  readonly items: readonly PatchSelectionItem[];
}

/**
 * A selection is only valid against the exact raw token, generation and view
 * digest it was made in. The whitespace view can never become the write
 * source, and an empty or oversized selection is rejected outright.
 */
export function validatePatchSelection(token: RawDiffToken, selection: PatchSelection): string[] {
  const errors: string[] = [];
  if (token.id !== selection.tokenId) errors.push('token');
  if (token.generation !== selection.generation) errors.push('generation');
  if (token.viewDigest !== selection.viewDigest) errors.push('view');
  if (selection.items.length === 0) errors.push('empty');
  if (selection.items.length > 10_000) errors.push('selection-size');
  return errors;
}
