import type { CommonRepositoryId, RepositoryDescriptor, RepositoryId } from '@git-workbench/domain';

function compareRepositories(left: RepositoryDescriptor, right: RepositoryDescriptor): number {
  return left.worktreeUri.localeCompare(right.worktreeUri) || left.id.localeCompare(right.id);
}

/** A replace-only registry keeps the primary and common-repository indexes coherent. */
export class RepositoryRegistry {
  private byId = new Map<RepositoryId, RepositoryDescriptor>();
  private byCommonId = new Map<CommonRepositoryId, Set<RepositoryId>>();

  replace(descriptors: readonly RepositoryDescriptor[]): void {
    const nextById = new Map<RepositoryId, RepositoryDescriptor>();
    const nextByCommonId = new Map<CommonRepositoryId, Set<RepositoryId>>();
    const worktreeUris = new Set<string>();
    for (const descriptor of descriptors) {
      if (nextById.has(descriptor.id)) throw new TypeError('Duplicate repository descriptor id');
      if (worktreeUris.has(descriptor.worktreeUri)) throw new TypeError('Duplicate repository descriptor worktree');
      nextById.set(descriptor.id, descriptor);
      worktreeUris.add(descriptor.worktreeUri);
      const group = nextByCommonId.get(descriptor.commonRepositoryId) ?? new Set<RepositoryId>();
      group.add(descriptor.id);
      nextByCommonId.set(descriptor.commonRepositoryId, group);
    }
    // Commit both indexes only after all descriptors have passed validation.
    this.byId = nextById;
    this.byCommonId = nextByCommonId;
  }

  get(id: RepositoryId): RepositoryDescriptor | undefined {
    return this.byId.get(id);
  }

  list(): readonly RepositoryDescriptor[] {
    return [...this.byId.values()].sort(compareRepositories);
  }

  listByCommonRepositoryId(commonRepositoryId: CommonRepositoryId): readonly RepositoryDescriptor[] {
    const ids = this.byCommonId.get(commonRepositoryId);
    if (ids === undefined) return [];
    return [...ids].map((id) => this.byId.get(id)).filter((value): value is RepositoryDescriptor => value !== undefined).sort(compareRepositories);
  }

  listAssociated(id: RepositoryId): readonly RepositoryDescriptor[] {
    const descriptor = this.byId.get(id);
    return descriptor === undefined ? [] : this.listByCommonRepositoryId(descriptor.commonRepositoryId);
  }
}
