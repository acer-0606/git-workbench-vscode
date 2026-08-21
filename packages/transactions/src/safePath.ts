import { GitWorkbenchError } from '@git-workbench/domain';

/**
 * Validates repo-relative paths coming from Git output or the raw diff.
 * Absolute paths, NUL bytes, `..` segments and Windows drive letters are
 * rejected; the bytes must be exactly what Git emitted, never re-encoded.
 */
export function validateRepoRelativePath(path: string): void {
  const failure = (message: string): GitWorkbenchError => new GitWorkbenchError({ code: 'INVALID_INPUT', message, repositoryChanged: false, retry: 'none' });
  if (path.length === 0 || path.length > 4096) throw failure('路径为空或过长');
  if (path.includes('\0')) throw failure('路径包含 NUL');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw failure('路径不能是绝对路径');
  if (path.includes('\\')) throw failure('路径不能包含反斜杠');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw failure('路径包含越界段');
  }
}
