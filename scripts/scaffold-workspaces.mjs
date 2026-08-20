import { mkdir, readFile, writeFile } from 'node:fs/promises';

const packageNames = ['domain', 'protocol', 'config', 'git-cli', 'transactions', 'testkit'];
const rootManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

if (process.argv.length !== 2) {
  throw new Error('scaffold-workspaces does not accept arguments');
}

const packageDependencies = {
  domain: {},
  protocol: { ajv: rootManifest.dependencies.ajv },
  config: {},
  'git-cli': { '@git-workbench/domain': '0.0.1' },
  transactions: {
    '@git-workbench/domain': '0.0.1',
    '@git-workbench/git-cli': '0.0.1',
  },
  testkit: { '@git-workbench/git-cli': '0.0.1' },
};

const packageReferences = {
  domain: [],
  protocol: [],
  config: [],
  'git-cli': [{ path: '../domain' }],
  transactions: [{ path: '../domain' }, { path: '../git-cli' }],
  testkit: [{ path: '../git-cli' }],
};

for (const packageName of packageNames) {
  const packageDirectory = new URL(`../packages/${packageName}/`, import.meta.url);
  await mkdir(new URL('src/', packageDirectory), { recursive: true });
  await writeFile(
    new URL('package.json', packageDirectory),
    `${JSON.stringify({
      name: `@git-workbench/${packageName}`,
      version: '0.0.1',
      private: true,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      dependencies: packageDependencies[packageName],
    }, null, 2)}\n`,
  );
  await writeFile(
    new URL('tsconfig.json', packageDirectory),
    `${JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        composite: true,
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: './dist/.tsbuildinfo',
      },
      references: packageReferences[packageName],
      include: ['src/**/*.ts'],
    }, null, 2)}\n`,
  );
  await writeFile(new URL('src/index.ts', packageDirectory), 'export {};\n');
}
