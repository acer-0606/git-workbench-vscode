import { describe, expect, it } from 'vitest';

import { GenerationCache } from './generationCache.js';

describe('GenerationCache', () => {
  it('returns values only for the exact generation', () => {
    const cache = new GenerationCache(1024);
    cache.set('log', 3, { rows: [] }, 10);
    expect(cache.get<object>('log', 3)).toEqual({ rows: [] });
    expect(cache.get('log', 4)).toBeUndefined();
  });

  it('evicts the least recently touched entries when the byte budget is exceeded', () => {
    const cache = new GenerationCache(100);
    cache.set('a', 1, 'a'.repeat(40), 40);
    cache.set('b', 1, 'b'.repeat(40), 40);
    cache.get('a', 1);
    cache.set('c', 1, 'c'.repeat(40), 40);
    expect(cache.get('c', 1)).toBeDefined();
    expect(cache.get('a', 1)).toBeDefined();
    expect(cache.get('b', 1)).toBeUndefined();
  });

  it('replacing a key accounts for the previous byte cost', () => {
    const cache = new GenerationCache(100);
    cache.set('a', 1, 'x', 10);
    cache.set('a', 2, 'y', 20);
    cache.set('b', 2, 'z', 80);
    expect(cache.get('a', 2)).toBe('y');
    expect(cache.get('b', 2)).toBe('z');
  });

  it('drops a value that alone exceeds the budget instead of keeping it over-committed', () => {
    const cache = new GenerationCache(10);
    cache.set('a', 1, 'old', 5);
    cache.set('a', 2, 'large', 50);
    expect(cache.get('a', 2)).toBeUndefined();
    expect(cache.get('a', 1)).toBeUndefined();
  });
});
