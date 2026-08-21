import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const allowlist = new Set([
  '.gitignore',
  'CHANGELOG.md',
  'README.md',
  'dist/extension.cjs',
  'dist/extension.cjs.map',
  'dist-webview/workbench.js',
  'media/workbench.svg',
  'package.json',
  'package.nls.json',
  'package.nls.zh-cn.json',
]);

const { stdout } = await execFileAsync(process.execPath, [
  'node_modules/@vscode/vsce/vsce',
  'ls',
  '--no-dependencies',
]);
const files = stdout.trim().split(/\r?\n/).filter(Boolean).sort();
const unexpected = files.filter((file) => !allowlist.has(file));
const missing = [...allowlist].filter((file) => !files.includes(file));

if (unexpected.length > 0 || missing.length > 0) {
  throw new Error(`VSIX allowlist mismatch; unexpected: ${unexpected.join(', ') || '(none)'}; missing: ${missing.join(', ') || '(none)'}`);
}
