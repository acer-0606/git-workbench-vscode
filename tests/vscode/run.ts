import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const execFileAsync = promisify(execFile);
const root = resolve(__dirname, '../../..');
const extensionTestsPath = join(root, 'tests/vscode/out/suite/index.js');
const cachePath = join(root, '.vscode-test');

type TrustState = 'trusted' | 'untrusted';

interface WorkspaceFixture {
  readonly path: string;
  readonly dangerousCommandMarker: string;
}

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const path = await mkdtemp(join(tmpdir(), 'git-workbench-vscode-'));
  const vscodeDirectory = join(path, '.vscode');
  const dangerousCommandMarker = join(path, '.git-workbench-dangerous-command');
  const dangerousGit = join(path, process.platform === 'win32' ? 'dangerous-git.cmd' : 'dangerous-git');
  await mkdir(vscodeDirectory, { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(dangerousGit, `@echo unsafe > "${dangerousCommandMarker}"\r\n`);
  } else {
    await writeFile(dangerousGit, `#!/bin/sh\nprintf unsafe > '${dangerousCommandMarker.replace(/'/g, "'\\\"'\\\"'")}'\n`);
    await chmod(dangerousGit, 0o700);
  }
  await writeFile(join(vscodeDirectory, 'settings.json'), `${JSON.stringify({
    'gitWorkbench.git.path': dangerousGit,
    'git.path': dangerousGit,
    'gitWorkbench.repositories.autoDetect': 'subFolders',
    'gitWorkbench.repositories.scanDepth': 5,
    'gitWorkbench.safety.mode': 'strict',
    'gitWorkbench.safety.protectedBranches': ['workspace-only/*'],
  }, null, 2)}\n`);
  await execFileAsync('git', ['init', '--quiet'], { cwd: path });
  return { path, dangerousCommandMarker };
}

async function createUserData(state: TrustState): Promise<string> {
  const userData = await mkdtemp(join(tmpdir(), `git-workbench-vscode-${state}-user-data-`));
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(join(userData, 'User', 'settings.json'), `${JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
  }, null, 2)}\n`);
  return userData;
}

function runUntrustedHost(executable: string, workspace: WorkspaceFixture, userData: string): Promise<void> {
  const args = [
    workspace.path,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${join(cachePath, 'extensions-untrusted')}`,
  ];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        GIT_WORKBENCH_EXPECTED_TRUST: 'untrusted',
        GIT_WORKBENCH_DANGEROUS_MARKER: workspace.dangerousCommandMarker,
        GIT_WORKBENCH_TEST_GREP: 'Workspace Trust',
      },
      shell: process.platform === 'win32' && executable.endsWith('.cmd'),
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Untrusted VS Code test host exited with ${code ?? signal ?? 'an unknown status'}`));
    });
  });
}

async function runTrustState(state: TrustState, executable: string): Promise<void> {
  const [workspace, userData] = await Promise.all([createWorkspaceFixture(), createUserData(state)]);
  try {
    if (state === 'trusted') {
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: root,
        extensionTestsPath,
        extensionTestsEnv: {
          GIT_WORKBENCH_EXPECTED_TRUST: 'trusted',
          GIT_WORKBENCH_DANGEROUS_MARKER: workspace.dangerousCommandMarker,
        },
        launchArgs: [workspace.path, '--disable-workspace-trust', `--user-data-dir=${userData}`, `--extensions-dir=${join(cachePath, 'extensions-trusted')}`],
      });
    } else {
      await runUntrustedHost(executable, workspace, userData);
    }
  } finally {
    await Promise.all([rm(workspace.path, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
}

async function main(): Promise<void> {
  const grepIndex = process.argv.indexOf('--grep');
  const grep = grepIndex >= 0 ? process.argv[grepIndex + 1] : undefined;
  if (grepIndex >= 0 && !grep) throw new Error('--grep requires a value');

  const executable = await downloadAndUnzipVSCode({ version: '1.96.0', cachePath });
  if (grep) process.env.GIT_WORKBENCH_TEST_GREP = grep;
  await runTrustState('trusted', executable);
  await runTrustState('untrusted', executable);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
