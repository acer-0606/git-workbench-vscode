import type * as React from 'react';
import type { ConflictEntry } from '@git-workbench/domain';

export interface SpecialConflictProps {
  readonly conflict: ConflictEntry;
  readonly onDecision: (decision: { readonly kind: 'binary' | 'deleteModify' | 'submodule'; readonly choice: 'ours' | 'theirs' | 'keepBoth' | 'keepModified' | 'confirmDelete' | 'gitlink'; readonly newPath?: string }) => void;
}

const formatOid = (oid: string | undefined): string => oid ? `${oid.slice(0, 12)}…` : '—';

const bytesOfStage = (conflict: ConflictEntry, stage: 1 | 2 | 3) => conflict.stages.find((entry) => entry.stage === stage);

/**
 * Binary / Delete-Modify / Submodule decision UI. Every variant shows the
 * exact stage OIDs it will act on and only offers actions the conflict kind
 * supports — binary never reaches a text editor by construction.
 */
export function SpecialConflictDecision({ conflict, onDecision }: SpecialConflictProps): React.JSX.Element {
  const ours = bytesOfStage(conflict, 2);
  const theirs = bytesOfStage(conflict, 3);
  const base = bytesOfStage(conflict, 1);

  if (conflict.kind === 'binary' || conflict.kind === 'addAdd') {
    return (
      <section aria-label={`二进制冲突 ${conflict.path}`}>
        <h3>{conflict.path}</h3>
        <dl>
          <dt>当前（Stage 2）</dt><dd data-stage-2>{formatOid(ours?.oid)}</dd>
          <dt>传入（Stage 3）</dt><dd data-stage-3>{formatOid(theirs?.oid)}</dd>
        </dl>
        <button type="button" onClick={() => onDecision({ kind: 'binary', choice: 'ours' })}>使用当前</button>
        <button type="button" onClick={() => onDecision({ kind: 'binary', choice: 'theirs' })}>使用传入</button>
        <button type="button" onClick={() => onDecision({ kind: 'binary', choice: 'keepBoth', newPath: `${conflict.path}.theirs` })}>两份都保留</button>
      </section>
    );
  }

  if (conflict.kind === 'deleteModify') {
    return (
      <section aria-label={`删除/修改冲突 ${conflict.path}`}>
        <h3>{conflict.path}</h3>
        <p>一方删除了该文件，另一方修改了它。</p>
        <button type="button" onClick={() => onDecision({ kind: 'deleteModify', choice: 'keepModified' })}>保留修改内容</button>
        <button type="button" onClick={() => onDecision({ kind: 'deleteModify', choice: 'confirmDelete' })}>确认删除</button>
      </section>
    );
  }

  return (
    <section aria-label={`Submodule 冲突 ${conflict.path}`}>
      <h3>{conflict.path}</h3>
      <dl>
        <dt>Base</dt><dd data-stage-1>{formatOid(base?.oid)}</dd>
        <dt>Current</dt><dd data-stage-2>{formatOid(ours?.oid)}</dd>
        <dt>Incoming</dt><dd data-stage-3>{formatOid(theirs?.oid)}</dd>
      </dl>
      <button type="button" onClick={() => onDecision({ kind: 'submodule', choice: 'gitlink' })}>使用当前指针</button>
      <button type="button" onClick={() => onDecision({ kind: 'submodule', choice: 'gitlink' })}>使用传入指针</button>
    </section>
  );
}
