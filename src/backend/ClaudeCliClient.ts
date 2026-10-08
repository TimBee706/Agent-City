import { execFile } from 'child_process';
import { Session } from '../models/Session';
import { ClaudeExecutable, LocateResult, locateClaude } from './ClaudeCodeLocator';
import { parseAgentsOutput } from './claudeOutputParser';

export type AgentsResult =
  | { kind: 'ok'; sessions: Session[]; malformed: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string };

export interface ExecOptions {
  timeout: number;
  maxBuffer: number;
  shell: boolean;
  windowsHide: boolean;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

/** Error shape produced by child_process.execFile (subset). */
export interface ExecError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

export type ExecFn = (file: string, args: readonly string[], opts: ExecOptions) => Promise<ExecOutput>;

/** Kills a process and all of its children on Windows (no shell involved). Never throws. */
export function killProcessTree(pid: number, run: typeof execFile = execFile): void {
  try {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => undefined);
  } catch {
    /* best effort */
  }
}

export interface ExecDeps {
  execFile?: typeof execFile;
  platform?: NodeJS.Platform;
  killTree?: (pid: number) => void;
}

/**
 * Builds the exec function: child_process.execFile WITHOUT a shell. Only for Windows .cmd/.bat shims
 * `shell: true` is required (Node refuses to spawn them otherwise). In that case the
 * executable path is quoted and validated by the locator (no cmd metacharacters), and all
 * arguments are fixed constants of this module - no user-provided strings reach the shell.
 *
 * Timeout with a shell on Windows: Node's own timeout would only kill cmd.exe and leave the actual
 * claude (node) process running, so we time out ourselves and kill the whole tree via taskkill.
 */
export function createExec(deps: ExecDeps = {}): ExecFn {
  const run = deps.execFile ?? execFile;
  const platform = deps.platform ?? process.platform;
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid));
  return (file, args, opts) =>
    new Promise((resolve, reject) => {
      const command = opts.shell ? `"${file}"` : file;
      const ownTimeout = opts.shell && platform === 'win32' && opts.timeout > 0;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const child = run(
        command,
        [...args],
        {
          timeout: ownTimeout ? 0 : opts.timeout,
          maxBuffer: opts.maxBuffer,
          shell: opts.shell,
          windowsHide: opts.windowsHide,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (timer) clearTimeout(timer);
          if (err || timedOut) {
            const e = (err ?? new Error('timed out')) as ExecError;
            if (timedOut) e.killed = true; // classified as timeout
            e.stdout = String(stdout ?? '');
            e.stderr = String(stderr ?? '');
            reject(e);
          } else {
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        },
      );
      if (ownTimeout) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) killTree(child.pid);
          child.kill();
        }, opts.timeout);
        timer.unref?.();
      }
    });
}

export const defaultExec: ExecFn = createExec();

export interface ClaudeCliClientOptions {
  getOverride?: () => string | undefined;
  locate?: (override: string | undefined) => LocateResult;
  exec?: ExecFn;
  timeoutMs?: number;
  maxBuffer?: number;
}

const AGENTS_ARGS = ['agents', '--json', '--all'] as const;
const VERSION_ARGS = ['--version'] as const;

function firstLine(s: string | undefined, max = 300): string {
  const line = (s ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.trim().slice(0, max);
}

/**
 * Thin, never-throwing wrapper around `claude agents --json --all`.
 */
export class ClaudeCliClient {
  private exe: ClaudeExecutable | undefined;
  private cachedVersion: string | undefined;
  private readonly getOverride: () => string | undefined;
  private readonly locate: (override: string | undefined) => LocateResult;
  private readonly exec: ExecFn;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(opts: ClaudeCliClientOptions = {}) {
    this.getOverride = opts.getOverride ?? (() => undefined);
    this.locate = opts.locate ?? ((o) => locateClaude(o));
    this.exec = opts.exec ?? defaultExec;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  }

  /** Forget the located executable (e.g. after claudePath setting changed). */
  invalidate(): void {
    this.exe = undefined;
    this.cachedVersion = undefined;
  }

  get executablePath(): string | undefined {
    return this.exe?.path;
  }

  private resolveExe(): ClaudeExecutable | string {
    if (this.exe) return this.exe;
    let res: LocateResult;
    try {
      res = this.locate(this.getOverride());
    } catch (err) {
      return `locating claude failed: ${(err as Error)?.message ?? String(err)}`;
    }
    if (res.kind === 'notFound') return res.reason;
    this.exe = res.exe;
    return res.exe;
  }

  private opts(timeout: number): ExecOptions {
    return { timeout, maxBuffer: this.maxBuffer, shell: !!this.exe?.needsShell, windowsHide: true };
  }

  async version(): Promise<string | undefined> {
    if (this.cachedVersion) return this.cachedVersion;
    const exe = this.resolveExe();
    if (typeof exe === 'string') return undefined;
    try {
      const out = await this.exec(exe.path, VERSION_ARGS, this.opts(5_000));
      this.cachedVersion = firstLine(out.stdout, 80) || undefined;
    } catch {
      this.cachedVersion = undefined;
    }
    return this.cachedVersion;
  }

  async listSessions(): Promise<AgentsResult> {
    const exe = this.resolveExe();
    if (typeof exe === 'string') return { kind: 'unavailable', reason: exe };
    let out: ExecOutput;
    try {
      out = await this.exec(exe.path, AGENTS_ARGS, this.opts(this.timeoutMs));
    } catch (err) {
      return this.classifyError(err as ExecError);
    }
    try {
      const parsed = parseAgentsOutput(out.stdout);
      if (!parsed.recognized) {
        return { kind: 'error', message: `Unrecognized output from claude agents --json: ${firstLine(out.stdout, 120)}` };
      }
      return { kind: 'ok', sessions: parsed.sessions, malformed: parsed.malformed };
    } catch (err) {
      return { kind: 'error', message: `Failed to parse claude output: ${(err as Error)?.message ?? String(err)}` };
    }
  }

  private classifyError(err: ExecError | undefined): AgentsResult {
    const code = err?.code;
    const stderr = err?.stderr ?? '';
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      this.invalidate();
      return { kind: 'unavailable', reason: `claude could not be started (${code})` };
    }
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { kind: 'error', message: 'claude agents output exceeded the size limit' };
    }
    if (err?.killed || code === 'ETIMEDOUT') {
      return { kind: 'error', message: `claude agents --json timed out after ${Math.round(this.timeoutMs / 1000)}s` };
    }
    if (/unknown (command|option)|unrecognized|not recognized as an internal or external command/i.test(stderr)) {
      return { kind: 'unavailable', reason: `installed claude does not support "agents --json --all": ${firstLine(stderr, 160)}` };
    }
    const detail = firstLine(stderr) || err?.message || 'unknown error';
    return { kind: 'error', message: `claude agents failed (exit ${code ?? '?'}): ${detail}` };
  }
}
