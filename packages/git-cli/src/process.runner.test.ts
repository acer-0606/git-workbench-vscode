import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { GitProcessRunner } from './process.js';

interface FakeChild extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  kill(): boolean;
}

function fakeChild(onStart: (child: FakeChild) => void): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }),
  }) as FakeChild;
  queueMicrotask(() => onStart(child));
  return child;
}

function complete(child: FakeChild, exitCode = 0): void {
  child.stdout.end();
  child.stderr.end();
  queueMicrotask(() => child.emit('close', exitCode));
}

const request = { args: ['status'], cwd: '/fixture', kind: 'query' as const, maxStdoutBytes: 64, maxStderrBytes: 64 };

describe('GitProcessRunner process launch', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('unconditionally prepends --no-pager and passes literal arguments without a shell', async () => {
    spawnMock.mockImplementationOnce((executable: string, args: readonly string[], options: { readonly shell: boolean }) => {
      expect(executable).toBe(process.execPath);
      expect(args).toEqual(['--no-pager', 'status', '$(touch injected)']);
      expect(options.shell).toBe(false);
      return fakeChild((child) => { child.stdout.write(JSON.stringify(args)); complete(child); });
    });

    const result = await new GitProcessRunner(process.execPath).run({ ...request, args: ['status', '$(touch injected)'] });
    expect(JSON.parse(result.stdoutText())).toEqual(['--no-pager', 'status', '$(touch injected)']);
  });

  it('rejects pagination options before spawning', async () => {
    for (const option of ['-p', '--paginate', '--paginate=true', '-p=true']) {
      expect(() => new GitProcessRunner('git').run({ ...request, args: ['status', option] })).toThrow('Pagination is not allowed');
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it('enforces safe query environment after call-site values', async () => {
    spawnMock.mockImplementationOnce((_executable: string, _args: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => fakeChild((child) => {
      child.stdout.write(JSON.stringify({
        GIT_TERMINAL_PROMPT: options.env.GIT_TERMINAL_PROMPT,
        GIT_OPTIONAL_LOCKS: options.env.GIT_OPTIONAL_LOCKS,
        GIT_NO_LAZY_FETCH: options.env.GIT_NO_LAZY_FETCH,
        GIT_ALLOW_PROTOCOL: options.env.GIT_ALLOW_PROTOCOL,
        GIT_PAGER: options.env.GIT_PAGER,
        GIT_DIR: options.env.GIT_DIR,
        NODE_OPTIONS: options.env.NODE_OPTIONS,
      }));
      complete(child);
    }));

    const result = await new GitProcessRunner(process.execPath).run({
      ...request, maxStdoutBytes: 1024,
      env: { GIT_TERMINAL_PROMPT: '1', GIT_DIR: '/unsafe', NODE_OPTIONS: '--trace-warnings' } as never,
    });
    expect(JSON.parse(result.stdoutText())).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PAGER: 'cat' });
    expect(JSON.parse(result.stdoutText())).not.toHaveProperty('GIT_DIR');
    expect(JSON.parse(result.stdoutText())).not.toHaveProperty('NODE_OPTIONS');
  });

  it('terminates oversized query stdout and stderr with TOO_LARGE', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      spawnMock.mockImplementationOnce(() => fakeChild((child) => { child[stream].write(Buffer.alloc(2048)); }));
      await expect(new GitProcessRunner('git').run(request)).rejects.toMatchObject({ payload: { code: 'TOO_LARGE' } });
    }
  });

  it('streams query output to a sink without a captured copy', async () => {
    const chunks: Uint8Array[] = [];
    spawnMock.mockImplementationOnce(() => fakeChild((child) => { child.stdout.write('four'); complete(child); }));
    const result = await new GitProcessRunner('git').run({ ...request, stdoutSink: { push: (chunk) => chunks.push(chunk), finish: () => undefined } });
    expect(Buffer.concat(chunks).toString()).toBe('four');
    expect(result.stdout.byteLength).toBe(0);
  });

  it('cancels queries but never kills an oversized mutation', async () => {
    let queryChild: FakeChild | undefined;
    spawnMock.mockImplementationOnce(() => {
      queryChild = fakeChild(() => undefined);
      return queryChild;
    });
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = new GitProcessRunner('git').run({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
    expect(queryChild?.kill).toHaveBeenCalledOnce();
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));

    let mutationChild: FakeChild | undefined;
    spawnMock.mockImplementationOnce(() => {
      mutationChild = fakeChild((child) => { child.stderr.write(Buffer.alloc(2048)); complete(child); });
      return mutationChild;
    });
    const mutation = await new GitProcessRunner('git').run({ ...request, kind: 'mutation' });
    expect(mutation.exitCode).toBe(0);
    expect(mutation.stderrTruncated).toBe(true);
    expect(mutationChild?.kill).not.toHaveBeenCalled();
  });

  it('rejects mutation stdout sinks before spawning', async () => {
    await expect(new GitProcessRunner('git').run({ ...request, kind: 'mutation', stdoutSink: { push: () => undefined, finish: () => undefined } })).rejects.toThrow('stdoutSink is query-only');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects non-EPIPE stdin failures but ignores EPIPE', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild((child) => child.stdin.emit('error', new Error('stdin failed'))));
    await expect(new GitProcessRunner('git').run(request)).rejects.toThrow('stdin failed');

    spawnMock.mockImplementationOnce(() => fakeChild((child) => {
      const error = Object.assign(new Error('closed stdin'), { code: 'EPIPE' });
      child.stdin.emit('error', error);
      complete(child);
    }));
    await expect(new GitProcessRunner('git').run(request)).resolves.toMatchObject({ exitCode: 0 });
  });

  it('rejects and kills a query when its stdout sink throws', async () => {
    let pushChild: FakeChild | undefined;
    spawnMock.mockImplementationOnce(() => {
      pushChild = fakeChild((child) => child.stdout.write('data'));
      return pushChild;
    });
    await expect(new GitProcessRunner('git').run({ ...request, stdoutSink: { push: () => { throw new Error('push failed'); }, finish: () => undefined } })).rejects.toThrow('push failed');
    expect(pushChild?.kill).toHaveBeenCalledOnce();

    let finishChild: FakeChild | undefined;
    spawnMock.mockImplementationOnce(() => {
      finishChild = fakeChild((child) => complete(child));
      return finishChild;
    });
    await expect(new GitProcessRunner('git').run({ ...request, stdoutSink: { push: () => undefined, finish: () => { throw new Error('finish failed'); } } })).rejects.toThrow('finish failed');
    expect(finishChild?.kill).toHaveBeenCalledOnce();
  });
});
