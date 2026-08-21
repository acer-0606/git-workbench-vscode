import * as vscode from 'vscode';

import type { ConflictEntry } from '@git-workbench/domain';

const kindLabels: Readonly<Record<string, string>> = {
  text: '文本冲突',
  binary: '二进制冲突',
  deleteModify: '删除/修改冲突',
  addAdd: '双方新增冲突',
  submodule: 'Submodule 冲突',
  modeChange: '模式变更冲突',
  rename: '重命名冲突',
};

/**
 * Native conflicts tree: one node per conflicted path, grouped visually by
 * label; binary/special kinds carry a description so they can never be
 * mistaken for plain text conflicts.
 */
export class ConflictTreeDataProvider implements vscode.TreeDataProvider<string> {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  private entries: readonly ConflictEntry[] = [];

  constructor(private readonly onActivate: (path: string) => void) {}

  get onDidChangeTreeData(): vscode.Event<string | undefined> {
    return this.emitter.event;
  }

  update(entries: readonly ConflictEntry[]): void {
    this.entries = entries;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: string): vscode.TreeItem {
    const entry = this.entries.find((candidate) => candidate.path === element);
    const item = new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
    if (entry) item.description = kindLabels[entry.kind] ?? entry.kind;
    item.command = { command: 'gitWorkbench.conflicts.open', title: '打开冲突', arguments: [element] };
    return item;
  }

  getChildren(element?: string): string[] {
    if (element !== undefined) return [];
    return this.entries.map((entry) => entry.path);
  }

  activate(path: string): void {
    this.onActivate(path);
  }
}
