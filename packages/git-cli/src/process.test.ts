import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server } from 'node:net';
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitProcessRunner } from './process.js';

let fixtureDirectory = '';
let localRemote = '';
let helperDirectory = '';
let helperMarker = '';
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'git-process-runner-'));
  await execFileAsync('git', ['init', fixtureDirectory]);
  localRemote = join(fixtureDirectory, 'local-remote.git');
  await execFileAsync('git', ['init', '--bare', localRemote]);
  await execFileAsync('git', ['-C', fixtureDirectory, 'remote', 'add', 'counter', 'count::ignored']);
  helperDirectory = join(fixtureDirectory, 'helpers');
  await mkdir(helperDirectory);
  if (process.platform === 'win32') {
    helperMarker = join(fixtureDirectory, 'remote-helper-invoked');
    await writeFile(join(helperDirectory, 'git-remote-count.cmd'), `@echo invoked>"${helperMarker}"\r\n`);
  } else {
    helperMarker = join(fixtureDirectory, 'counter');
    await symlink('/usr/bin/touch', join(helperDirectory, 'git-remote-count'));
  }
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected a TCP address');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

const limits = { maxStdoutBytes: 64, maxStderrBytes: 64 } as const;

describe('GitProcessRunner transport isolation', () => {
  it('blocks query and default mutation file transport but permits explicit network profiles', async () => {
    const git = new GitProcessRunner('git');
    const query = await git.run({ args: ['ls-remote', localRemote], cwd: fixtureDirectory, kind: 'query', ...limits });
    const blocked = await git.run({ args: ['ls-remote', localRemote], cwd: fixtureDirectory, kind: 'mutation', ...limits });
    const userInitiated = await git.run({ args: ['ls-remote', localRemote], cwd: fixtureDirectory, kind: 'mutation', profile: 'userInitiatedNetwork', ...limits });
    const materialized = await git.run({ args: ['ls-remote', localRemote], cwd: fixtureDirectory, kind: 'mutation', profile: 'materializeMissingObjects', ...limits });

    expect(query.exitCode).not.toBe(0);
    expect(blocked.exitCode).not.toBe(0);
    expect(userInitiated.exitCode).toBe(0);
    expect(materialized.exitCode).toBe(0);
  });

  it('blocks query HTTP and SSH transports before they connect', async () => {
    let connections = 0;
    const http = createHttpServer((_request, response) => { connections += 1; response.end(); });
    const ssh = createNetServer(() => { connections += 1; });
    const [httpPort, sshPort] = await Promise.all([listen(http), listen(ssh)]);
    const git = new GitProcessRunner('git');

    try {
      const [httpResult, sshResult] = await Promise.all([
        git.run({ args: ['ls-remote', `http://127.0.0.1:${httpPort}/repo`], cwd: fixtureDirectory, kind: 'query', ...limits }),
        git.run({ args: ['ls-remote', `ssh://127.0.0.1:${sshPort}/repo`], cwd: fixtureDirectory, kind: 'query', ...limits }),
      ]);
      expect(httpResult.exitCode).not.toBe(0);
      expect(sshResult.exitCode).not.toBe(0);
      expect(connections).toBe(0);
    } finally {
      await Promise.all([close(http), close(ssh)]);
    }
  });

  it('runs a custom helper only for an explicit network profile', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = `${helperDirectory}${delimiter}${originalPath ?? ''}`;
    try {
      const git = new GitProcessRunner('git');
      const explicit = await git.run({
        args: ['-c', 'protocol.count.allow=always', 'ls-remote', 'counter'], cwd: fixtureDirectory,
        kind: 'mutation', profile: 'userInitiatedNetwork', ...limits,
      });
      expect(explicit.exitCode).not.toBe(0);
      await expect(access(helperMarker)).resolves.toBeUndefined();
      await unlink(helperMarker);

      const query = await git.run({
        args: ['-c', 'protocol.count.allow=always', 'ls-remote', 'counter'], cwd: fixtureDirectory,
        kind: 'query', ...limits,
      });
      expect(query.exitCode).not.toBe(0);
      await expect(access(helperMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
