import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
});

await build({
  entryPoints: ['webview/workbench/src/index.tsx'],
  outfile: 'dist-webview/workbench.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  sourcemap: false,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
