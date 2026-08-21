export interface LaneAssignment { readonly oid: string; readonly lane: number }

export interface LayoutRequest {
  readonly commits: readonly { readonly oid: string; readonly parents: readonly string[] }[];
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly maxLanes: number;
}

/**
 * Assigns each visible commit to a lane using first-parent continuation: the
 * parent keeps the child's lane when free, otherwise the next free lane is
 * used. Lanes beyond `maxLanes` collapse into the last lane so a pathological
 * DAG cannot exhaust the rendering budget.
 */
export function assignLanes(request: LayoutRequest): readonly LaneAssignment[] {
  const active = new Map<string, number>();
  const free: number[] = [];
  let laneCount = 0;
  const assignments: LaneAssignment[] = [];
  const clamp = (lane: number): number => Math.min(lane, request.maxLanes - 1);
  for (let index = request.fromIndex; index < Math.min(request.toIndex, request.commits.length); index += 1) {
    const commit = request.commits[index];
    if (!commit) continue;
    const existing = active.get(commit.oid);
    const lane = existing === undefined ? clamp(laneCount++) : clamp(existing);
    if (existing === undefined && lane === laneCount - 1 && laneCount < request.maxLanes) free.push(lane);
    assignments.push({ oid: commit.oid, lane });
    active.delete(commit.oid);
    for (const parent of commit.parents) {
      if (!active.has(parent)) {
        const reused = free.pop();
        active.set(parent, reused === undefined ? clamp(laneCount++) : reused);
      }
    }
  }
  return assignments;
}

if (typeof self !== 'undefined' && 'onmessage' in self) {
  self.onmessage = (event: MessageEvent<LayoutRequest>): void => {
    (self as unknown as Worker).postMessage(assignLanes(event.data));
  };
}
