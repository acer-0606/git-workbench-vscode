import * as vscode from 'vscode';

/** Structural seam so the tree can be unit-tested without the VS Code runtime. */
export interface TreeItemFactory<TItem> {
  (element: TItem): { readonly label: string; readonly collapsibleState?: vscode.TreeItemCollapsibleState };
}

/**
 * Lazy repository tree: nothing is read from Git until the view actually
 * becomes visible and asks for children.
 */
export class RepositoriesTreeDataProvider implements vscode.TreeDataProvider<string> {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();

  constructor(private readonly listRepositories: () => readonly { readonly id: string; readonly name: string }[]) {}

  get onDidChangeTreeData(): vscode.Event<string | undefined> {
    return this.emitter.event;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: string): vscode.TreeItem {
    return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
  }

  getChildren(_element?: string): string[] {
    return this.listRepositories().map((repository) => repository.name);
  }
}
