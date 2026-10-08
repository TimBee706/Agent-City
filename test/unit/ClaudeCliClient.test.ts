import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliClient, ExecError, ExecFn, createExec, killProcessTree } from '../../src/backend/ClaudeCliClient';
import type { LocateResult } from '../../src/backend/ClaudeCodeLocator';

const found = (path = 'C:\\bin\\claude.exe', needsShell = false): (() => LocateResult) => () => ({
  kind: 'found',
  exe: { path, needsShell },
});

function execError(props: Partial<ExecError>): ExecError {
  return Object.assign(new Error(props.message ?? 'fail'), props);
}

describe('ClaudeCliClient', () => {
  it('returns ok with parsed sessions and passes fixed args without shell', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify([{ sessionId: 'a', cwd: '/x', status: 'busy' }]), stderr: '' }));
    const c = new ClaudeCliClient({ locate: found(), exec });
    const r = await c.listSessions();
    expect(r).toMatchObject({ kind: 'ok', malformed: 0 });
    expect(r.kind === 'ok' && r.sessions[0].id).toBe('a');
    expect(exec).toHaveBeenCalledWith('C:\\bin\\claude.exe', ['agents', '--json', '--all'], expect.objectContaining({ shell: false, timeout: 10000 }));
  });

  it('uses shell mode only for .cmd shims', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '[]', stderr: '' }));
    const c = new ClaudeCliClient({ locate: found('C:\\npm\\claude.cmd', true), exec });
    await c.listSessions();
    expect(exec.mock.calls[0][2].shell).toBe(true);
  });

  it('is unavailable when the executable cannot be located', async () => {
    const exec = vi.fn<ExecFn>();
    const c = new ClaudeCliClient({ locate: () => ({ kind: 'notFound', reason: 'nope' }), exec });
    expect(await c.listSessions()).toEqual({ kind: 'unavailable', reason: 'nope' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('maps ENOENT to unavailable and re-locates next time', async () => {
    const locate = vi.fn(found());
    const exec = vi.fn<ExecFn>(async () => {
      throw execError({ code: 'ENOENT' });
    });
    const c = new ClaudeCliClient({ locate, exec });
    const r = await c.listSessions();
    expect(r.kind).toBe('unavailable');
    await c.listSessions();
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it('maps a timeout (killed) to error', async () => {
    const exec: ExecFn = async () => {
      throw execError({ killed: true, signal: 'SIGTERM', code: null });
    };
    const r = await new ClaudeCliClient({ locate: found(), exec, timeoutMs: 10_000 }).listSessions();
    expect(r).toEqual({ kind: 'error', message: 'claude agents --json timed out after 10s' });
  });

  it('maps maxBuffer overflow to error', async () => {
    const exec: ExecFn = async () => {
      throw execError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    };
    const r = await new ClaudeCliClient({ locate: found(), exec }).listSessions();
    expect(r.kind).toBe('error');
  });

  it('treats unknown subcommand as unavailable (old CLI)', async () => {
    const exec: ExecFn = async () => {
      throw execError({ code: 1, stderr: "error: unknown command 'agents'" });
    };
    const r = await new ClaudeCliClient({ locate: found(), exec }).listSessions();
    expect(r.kind).toBe('unavailable');
  });

  it('reports non-zero exit with stderr as error', async () => {
    const exec: ExecFn = async () => {
      throw execError({ code: 2, stderr: '\nboom happened\nmore' });
    };
    const r = await new ClaudeCliClient({ locate: found(), exec }).listSessions();
    expect(r).toEqual({ kind: 'error', message: 'claude agents failed (exit 2): boom happened' });
  });

  it('reports malformed (unrecognized) output as error', async () => {
    const exec: ExecFn = async () => ({ stdout: 'Welcome to Claude!', stderr: '' });
    const r = await new ClaudeCliClient({ locate: found(), exec }).listSessions();
    expect(r.kind).toBe('error');
  });

  it('never throws even if exec throws synchronously or locate throws', async () => {
    const exec: ExecFn = () => {
      throw new Error('sync boom');
    };
    await expect(new ClaudeCliClient({ locate: found(), exec }).listSessions()).resolves.toMatchObject({ kind: 'error' });
    const c2 = new ClaudeCliClient({
      locate: () => {
        throw new Error('locate boom');
      },
    });
    await expect(c2.listSessions()).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('reads and caches the version', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '2.1.289 (Claude Code)\n', stderr: '' }));
    const c = new ClaudeCliClient({ locate: found(), exec });
    expect(await c.version()).toBe('2.1.289 (Claude Code)');
    expect(await c.version()).toBe('2.1.289 (Claude Code)');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('createExec (timeouts)', () => {
  type Cb = (err: Error | null, stdout: string, stderr: string) => void;
  function fakeExecFile() {
    const calls: { file: string; args: string[]; opts: Record<string, unknown>; cb: Cb; child: { pid: number; kill: ReturnType<typeof vi.fn> } }[] = [];
    const fn = ((file: string, args: string[], opts: Record<string, unknown>, cb: Cb) => {
      const child = { pid: 4242, kill: vi.fn() };
      calls.push({ file, args, opts, cb, child });
      return child;
    }) as unknown as typeof import('child_process').execFile;
    return { fn, calls };
  }
  const OPTS = { timeout: 1000, maxBuffer: 1024, windowsHide: true };

  it('Windows + shell: own timeout kills the whole process tree and reports a timeout', async () => {
    vi.useFakeTimers();
    try {
      const { fn, calls } = fakeExecFile();
      const killTree = vi.fn();
      const exec = createExec({ execFile: fn, platform: 'win32', killTree });
      const p = exec('C:\\npm\\claude.cmd', ['agents'], { ...OPTS, shell: true });
      expect(calls[0].file).toBe('"C:\\npm\\claude.cmd"');
      expect(calls[0].opts.timeout).toBe(0); // Node's timeout would only kill cmd.exe
      vi.advanceTimersByTime(1000);
      expect(killTree).toHaveBeenCalledWith(4242);
      expect(calls[0].child.kill).toHaveBeenCalled();
      calls[0].cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
      const err = (await p.catch((e) => e)) as ExecError;
      expect(err.killed).toBe(true);
      const c = new ClaudeCliClient({ locate: found('C:\\npm\\claude.cmd', true), exec: () => p });
      expect(await c.listSessions()).toMatchObject({ kind: 'error', message: expect.stringContaining('timed out') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timeout is reported even if the killed process exits with code 0', async () => {
    vi.useFakeTimers();
    try {
      const { fn, calls } = fakeExecFile();
      const exec = createExec({ execFile: fn, platform: 'win32', killTree: () => undefined });
      const p = exec('C:\\x.cmd', [], { ...OPTS, shell: true });
      vi.advanceTimersByTime(1000);
      calls[0].cb(null, 'partial', '');
      await expect(p).rejects.toMatchObject({ killed: true, stdout: 'partial' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('no own timer without shell or off Windows; finished processes are not killed', async () => {
    vi.useFakeTimers();
    try {
      const { fn, calls } = fakeExecFile();
      const killTree = vi.fn();
      const execWin = createExec({ execFile: fn, platform: 'win32', killTree });
      const a = execWin('C:\\claude.exe', [], { ...OPTS, shell: false });
      expect(calls[0].opts.timeout).toBe(1000);
      const execLinux = createExec({ execFile: fn, platform: 'linux', killTree });
      const b = execLinux('/bin/claude', [], { ...OPTS, shell: true });
      expect(calls[1].opts.timeout).toBe(1000);
      const c = execWin('C:\\claude.cmd', [], { ...OPTS, shell: true });
      calls[2].cb(null, 'ok', '');
      vi.advanceTimersByTime(5000);
      expect(killTree).not.toHaveBeenCalled();
      calls[0].cb(null, '', '');
      calls[1].cb(null, '', '');
      await expect(Promise.all([a, b, c])).resolves.toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('killProcessTree runs taskkill /T /F without a shell and never throws', () => {
    const run = vi.fn();
    killProcessTree(77, run as unknown as typeof import('child_process').execFile);
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '77', '/T', '/F'], expect.not.objectContaining({ shell: true }), expect.any(Function));
    expect(() =>
      killProcessTree(1, (() => {
        throw new Error('boom');
      }) as unknown as typeof import('child_process').execFile),
    ).not.toThrow();
  });
});
