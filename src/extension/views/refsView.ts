import * as vscode from 'vscode';

export interface RefsSnapshot {
  readonly branches: readonly { readonly name: string; readonly isHead: boolean }[];
  readonly tags: readonly { readonly name: string }[];
  readonly stashes: readonly { readonly subject: string }[];
  readonly worktrees: readonly { readonly path: string }[];
}

const groups = (snapshot: RefsSnapshot): readonly { readonly label: string; readonly children: readonly string[] }[] => [
  { label: 'Branches', children: snapshot.branches.map((branch) => `${branch.isHead ? '* ' : ''}${branch.name}`) },
  { label: 'Tags', children: snapshot.tags.map((tag) => tag.name) },
  { label: 'Stashes', children: snapshot.stashes.map((stash) => stash.subject) },
  { label: 'Worktrees', children: snapshot.worktrees.map((worktree) => worktree.path) },
];

/**
 * Grouped ref tree (Branches/Tags/Stashes/Worktrees). The refs query is only
 * issued when the view expands a repository node.
 */
export class RefsTreeDataProvider implements vscode.TreeDataProvider<string> {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  private snapshot: RefsSnapshot | undefined;

  constructor(private readonly loadRefs: () => Promise<RefsSnapshot>, private readonly reportError?: (message: string) => void) {}

  get onDidChangeTreeData(): vscode.Event<string | undefined> {
    return this.emitter.event;
  }

  async refresh(): Promise<void> {
    this.snapshot = undefined;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: string): vscode.TreeItem {
    const group = this.snapshot ? groups(this.snapshot).find((entry) => entry.label === element) : undefined;
    return new vscode.TreeItem(
      element,
      group ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
  }

  async getChildren(element?: string): Promise<string[]> {
    if (!this.snapshot) {
      try {
        this.snapshot = await this.loadRefs();
      } catch (error) {
        // Keep the group skeleton visible and surface the reason instead of
        // silently rendering nothing at all.
        this.reportError?.(`Refs 加载失败：${String(error)}`);
        this.snapshot = { branches: [], tags: [], stashes: [], worktrees: [] };
      }
    }
    if (element === undefined) return groups(this.snapshot).map((group) => group.label);
    return [...(groups(this.snapshot).find((group) => group.label === element)?.children ?? [])];
  }
}
