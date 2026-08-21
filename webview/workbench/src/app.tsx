import { useMemo, useState } from 'react';
import type * as React from 'react';

import { CommitGraph, type GraphCommit } from './graph/commitGraph.js';
import { assignLanes } from './graph/layout.worker.js';

const rowHeight = 28;
const viewportHeight = 560;

export function App({ commits = [] }: { readonly commits?: readonly GraphCommit[] }): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const lanes = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 12);
    const count = Math.ceil(viewportHeight / rowHeight) + 24;
    return new Map(assignLanes({ commits, fromIndex: first, toIndex: first + count, maxLanes: 8 }).map((entry) => [entry.oid, entry.lane] as const));
  }, [commits, scrollTop]);
  return (
    <main
      onScroll={(event) => setScrollTop((event.target as HTMLElement).scrollTop)}
      style={{ height: viewportHeight, overflowY: 'auto' }}
    >
      <CommitGraph commits={commits} rowHeight={rowHeight} viewportHeight={viewportHeight} scrollTop={scrollTop} laneByOid={lanes} />
    </main>
  );
}
