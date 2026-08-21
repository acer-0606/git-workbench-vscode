// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';

import { CommitGraph } from './commitGraph.js';

it('keeps the rendered row count bounded', () => {
  const commits = Array.from({ length: 100_000 }, (_, index) => ({ oid: `${index}`, parents: index ? [`${index - 1}`] : [], subject: `commit ${index}` }));
  const view = render(<CommitGraph commits={commits} rowHeight={28} viewportHeight={560} scrollTop={50_000} />);
  expect(view.container.querySelectorAll('[data-commit-row]').length).toBeLessThanOrEqual(60);
});

it('exposes tree semantics and per-row lanes for assistive technology', () => {
  const commits = [{ oid: 'a', parents: [], subject: 'root' }, { oid: 'b', parents: ['a'], subject: 'child' }];
  const view = render(<CommitGraph commits={commits} rowHeight={28} viewportHeight={56} scrollTop={0} laneByOid={new Map([['a', 0], ['b', 1]])} />);
  expect(view.container.querySelector('[role="tree"]')).toBeTruthy();
  expect(view.container.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  expect(view.container.querySelector('[data-lane-for="b"]')?.getAttribute('data-lane')).toBe('1');
});
