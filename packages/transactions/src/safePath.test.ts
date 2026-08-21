import { describe, expect, it } from 'vitest';

import { validateRepoRelativePath } from './safePath.js';

describe('validateRepoRelativePath', () => {
  it('accepts plain repo-relative paths including unicode and spaces', () => {
    expect(() => validateRepoRelativePath('src/a.ts')).not.toThrow();
    expect(() => validateRepoRelativePath('中文 目录/文件 name.txt')).not.toThrow();
    expect(() => validateRepoRelativePath('deep/nested/dir/file.bin')).not.toThrow();
  });

  it('rejects escapes and unsafe bytes', () => {
    expect(() => validateRepoRelativePath('/etc/passwd')).toThrow();
    expect(() => validateRepoRelativePath('C:\\Windows\\system32')).toThrow();
    expect(() => validateRepoRelativePath('a/../../outside')).toThrow();
    expect(() => validateRepoRelativePath('a\0b')).toThrow();
    expect(() => validateRepoRelativePath('')).toThrow();
    expect(() => validateRepoRelativePath('a//b')).toThrow();
  });
});
