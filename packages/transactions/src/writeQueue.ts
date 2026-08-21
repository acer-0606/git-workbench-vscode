export class RepositoryWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Serializes writers that share one common repository (primary worktree and
   * its linked worktrees). The queue only provides in-process fairness; the
   * cross-process lease is acquired by the coordinator after this turn starts.
   */
  run<T>(commonRepositoryId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(commonRepositoryId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(commonRepositoryId, tail);
    return result.finally(() => {
      if (this.tails.get(commonRepositoryId) === tail) this.tails.delete(commonRepositoryId);
    });
  }
}
