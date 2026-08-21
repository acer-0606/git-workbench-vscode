export interface GraphCommit { readonly oid: string; readonly parents: readonly string[]; readonly subject: string }

interface Props {
  readonly commits: readonly GraphCommit[];
  readonly rowHeight: number;
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly laneByOid?: ReadonlyMap<string, number>;
}

/**
 * Deterministic-window virtualized commit list. Rendering cost stays bounded
 * by the viewport regardless of repository size; lanes are provided by the
 * layout worker and attached per visible row.
 */
export function CommitGraph({ commits, rowHeight, viewportHeight, scrollTop, laneByOid }: Props): React.JSX.Element {
  const overscan = 12;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const visible = commits.slice(first, first + count);
  return (
    <div role="tree" style={{ height: commits.length * rowHeight, position: 'relative' }}>
      {visible.map((commit, offset) => (
        <div
          role="treeitem"
          data-commit-row
          data-lane-for={commit.oid}
          data-lane={laneByOid?.get(commit.oid)}
          key={commit.oid}
          style={{ position: 'absolute', top: (first + offset) * rowHeight, height: rowHeight }}
        >
          <span aria-hidden="true">{String(first + offset)}</span>
          <span>{commit.subject}</span>
        </div>
      ))}
    </div>
  );
}
