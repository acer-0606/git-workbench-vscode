import { GitWorkbenchError } from '@git-workbench/domain';

function validateRepoRelativePath(path: string): void {
  if (path.length === 0 || path.length > 4096 || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '非法仓库相对路径', repositoryChanged: false, retry: 'none' });
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: '路径包含越界段', repositoryChanged: false, retry: 'none' });
    }
  }
}

const globSpecial = /[\\*?[\]]/g;

/**
 * Encodes a repo-relative path as a literal .gitignore entry: glob special
 * characters are backslash-escaped so a file literally named `a*b.txt` or
 * `[x].md` is ignored exactly, never as a pattern. Directory entries keep a
 * trailing slash only when the path is a directory.
 */
export function encodeIgnorePattern(path: string, isDirectory: boolean): string {
  validateRepoRelativePath(path);
  const escaped = path.replace(globSpecial, (character) => `\\${character}`);
  if (escaped.includes('!')) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Ignore 条目不能以否定语法开始', repositoryChanged: false, retry: 'none' });
  }
  if (escaped.trim() !== escaped || escaped.length > 1024) {
    throw new GitWorkbenchError({ code: 'INVALID_INPUT', message: 'Ignore 条目包含首尾空白或过长', repositoryChanged: false, retry: 'none' });
  }
  return isDirectory ? `${escaped}/` : escaped;
}

export function decodeIgnorePattern(entry: string): { readonly path: string; readonly isDirectory: boolean } {
  const isDirectory = entry.endsWith('/');
  const withoutSlash = isDirectory ? entry.slice(0, -1) : entry;
  const path = withoutSlash.replace(/\\(.)/g, '$1');
  validateRepoRelativePath(path);
  return { path, isDirectory };
}
