import { describe, expect, it } from 'vitest';

import { decodeIgnorePattern, encodeIgnorePattern } from './ignore.js';

describe('ignore pattern encoding', () => {
  it('escapes glob metacharacters so paths are ignored literally', () => {
    expect(encodeIgnorePattern('build/output.bin', false)).toBe('build/output.bin');
    expect(encodeIgnorePattern('a*b.txt', false)).toBe('a\\*b.txt');
    expect(encodeIgnorePattern('[debug].log', false)).toBe('\\[debug\\].log');
    expect(encodeIgnorePattern('q?mark', false)).toBe('q\\?mark');
    expect(encodeIgnorePattern('logs', true)).toBe('logs/');
  });

  it('round-trips through decode', () => {
    for (const path of ['plain/path.txt', 'a*b.txt', '中文/目录', '[x].md']) {
      const decoded = decodeIgnorePattern(encodeIgnorePattern(path, path.startsWith('[')));
      expect(decoded.path).toBe(path);
    }
    expect(decodeIgnorePattern('dir/').isDirectory).toBe(true);
  });

  it('rejects escapes and negation syntax', () => {
    expect(() => encodeIgnorePattern('../outside', false)).toThrow();
    expect(() => encodeIgnorePattern('/absolute', false)).toThrow();
    expect(() => encodeIgnorePattern('!important', false)).toThrow();
  });
});
