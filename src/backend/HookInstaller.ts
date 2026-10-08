/**
 * Installs / uninstalls Claude City's `type: "http"` hooks in a Claude Code settings file.
 *
 * Settings schema (https://code.claude.com/docs/en/hooks):
 *   { "hooks": { "<EventName>": [ { "matcher"?: "...", "hooks": [ { "type": "http", "url": "...",
 *     "headers": {...}, "allowedEnvVars"?: [...], "timeout"?: <seconds> } ] } ] } }
 *
 * Safety rules:
 *  - invalid JSON or unexpected shapes -> abort, never overwrite
 *  - foreign hooks are never modified or reordered; we only append our own matcher groups
 *  - our entries are identified by an http handler whose url points to 127.0.0.1/localhost + HOOK_PATH
 *  - idempotent: installing twice does not create duplicates (outdated entries are replaced)
 *  - backup before every write (only the newest MAX_BACKUPS are kept), atomic write (temp file next
 *    to the real target + rename; symlinks are followed), 2-space JSON, original mode and BOM kept
 *
 * Events deliberately NOT installed:
 *  - SessionStart: per the docs it supports only `type: "command"` and `"mcp_tool"` hooks, not
 *    `"http"`. Older Claude City versions installed it; such entries are still recognized as ours,
 *    removed on (re)install / uninstall, and make the install state "outdated". Resumes are detected
 *    from the first hook event after a SessionEnd instead (see hookActivity.ts).
 *  - WorktreeCreate: a configured hook REPLACES Claude's git worktree creation and must return a path.
 *  - WorktreeRemove: a 2xx answer makes Claude treat the worktree as removed (no git fallback).
 *  - PreToolUse/PostToolUse: would add an HTTP round trip to every tool call.
 */
import { constants as fsConstants, promises as fsp } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

export const HOOK_PATH = '/claude-city/hook';
export const TOKEN_HEADER_NAME = 'X-Claude-City-Token';

export const INSTALLED_EVENTS = [
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'Notification',
  'TeammateIdle',
] as const;

/** Seconds; connection refused (VS Code closed) fails immediately anyway. */
export const HOOK_TIMEOUT_SECONDS = 3;

export interface HookSpec {
  port: number;
  token: string;
  events?: readonly string[];
  timeoutSeconds?: number;
}

export type Settings = Record<string, unknown>;

export type InstallState = 'none' | 'current' | 'outdated';

export class SettingsShapeError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}${HOOK_PATH}`;
}

export function ourHandler(spec: HookSpec): Record<string, unknown> {
  return {
    type: 'http',
    url: hookUrl(spec.port),
    headers: { [TOKEN_HEADER_NAME]: spec.token },
    timeout: spec.timeoutSeconds ?? HOOK_TIMEOUT_SECONDS,
  };
}

/** True for handlers created by Claude City (any port/token). */
export function isOurHandler(h: unknown): boolean {
  if (!isPlainObject(h) || h.type !== 'http' || typeof h.url !== 'string') return false;
  try {
    const u = new URL(h.url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname === HOOK_PATH;
  } catch {
    return false;
  }
}

function sameHandler(h: unknown, spec: HookSpec): boolean {
  if (!isOurHandler(h)) return false;
  const o = h as Record<string, unknown>;
  const headers = isPlainObject(o.headers) ? o.headers : {};
  return (
    o.url === hookUrl(spec.port) &&
    headers[TOKEN_HEADER_NAME] === spec.token &&
    o.timeout === (spec.timeoutSeconds ?? HOOK_TIMEOUT_SECONDS)
  );
}

/** Parses settings file text. Empty text counts as `{}`; non-object JSON is rejected. */
export function parseSettingsText(text: string): { ok: true; settings: Settings } | { ok: false; error: string } {
  const t = text.replace(/^﻿/, '');
  if (!t.trim()) return { ok: true, settings: {} };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!isPlainObject(v)) return { ok: false, error: 'settings file does not contain a JSON object' };
  return { ok: true, settings: v };
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

function hooksObject(settings: Settings): Record<string, unknown> | undefined {
  if (settings.hooks === undefined) return undefined;
  if (!isPlainObject(settings.hooks)) throw new SettingsShapeError('"hooks" is not an object');
  return settings.hooks;
}

function eventGroups(hooks: Record<string, unknown>, event: string): unknown[] | undefined {
  const v = hooks[event];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new SettingsShapeError(`"hooks.${event}" is not an array`);
  return v;
}

/** Whether our hooks are installed with exactly this spec, installed but outdated, or absent. */
export function installState(settings: Settings, spec: HookSpec): InstallState {
  let hooks: Record<string, unknown> | undefined;
  try {
    hooks = hooksObject(settings);
  } catch {
    return 'none';
  }
  if (!hooks) return 'none';
  const events = spec.events ?? INSTALLED_EVENTS;
  let found = 0;
  let current = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (!isOurHandler(h)) continue;
        found++;
        if (events.includes(event) && sameHandler(h, spec)) current++;
      }
    }
  }
  if (found === 0) return 'none';
  return found === events.length && current === events.length ? 'current' : 'outdated';
}

/**
 * Removes every Claude City handler. Groups / event arrays / the hooks object are removed only if
 * they become empty because of that removal. Everything else is left untouched (same order).
 */
export function unmergeHooks(settings: Settings): { settings: Settings; changed: boolean; removed: number } {
  const hooks = hooksObject(settings);
  if (!hooks) return { settings, changed: false, removed: 0 };
  let removed = 0;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[event] = value;
      continue;
    }
    const nextGroups: unknown[] = [];
    for (const g of value) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        nextGroups.push(g);
        continue;
      }
      const kept = g.hooks.filter((h) => !isOurHandler(h));
      const n = g.hooks.length - kept.length;
      if (n === 0) {
        nextGroups.push(g);
        continue;
      }
      removed += n;
      if (kept.length > 0) nextGroups.push({ ...g, hooks: kept });
    }
    if (nextGroups.length > 0 || value.length === 0) nextHooks[event] = nextGroups;
  }
  if (removed === 0) return { settings, changed: false, removed: 0 };
  const next: Settings = {};
  for (const [k, v] of Object.entries(settings)) {
    if (k !== 'hooks') next[k] = v;
    else if (Object.keys(nextHooks).length > 0) next[k] = nextHooks;
  }
  return { settings: next, changed: true, removed };
}

/** Appends our handlers (one matcher-less group per event). Idempotent. */
export function mergeHooks(settings: Settings, spec: HookSpec): { settings: Settings; changed: boolean } {
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw new Error('invalid port');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(spec.token)) throw new Error('invalid token');
  // Validate shapes up-front (throws SettingsShapeError).
  const existing = hooksObject(settings);
  const events = spec.events ?? INSTALLED_EVENTS;
  if (existing) for (const e of events) eventGroups(existing, e);
  if (installState(settings, spec) === 'current') return { settings, changed: false };

  const base = unmergeHooks(settings).settings;
  const baseHooks = hooksObject(base);
  const hooks: Record<string, unknown> = baseHooks ? { ...baseHooks } : {};
  for (const e of events) {
    const groups = eventGroups(hooks, e) ?? [];
    hooks[e] = [...groups, { hooks: [ourHandler(spec)] }];
  }
  const next: Settings = { ...base };
  next.hooks = hooks; // keeps key position if it existed, appends otherwise
  return { settings: next, changed: true };
}

// ------------------------------------------------------------------------------------ fs layer

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; settings: Settings; mtimeMs: number; mode: number; bom: boolean }
  | { kind: 'invalid'; error: string };

export async function readSettingsFile(file: string): Promise<ReadResult> {
  let text: string;
  let mtimeMs: number;
  let mode: number;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return { kind: 'invalid', error: `${file} is not a regular file` };
    if (st.size > 5 * 1024 * 1024) return { kind: 'invalid', error: `${file} is unexpectedly large` };
    mtimeMs = st.mtimeMs;
    mode = st.mode;
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', error: `cannot read ${file}: ${(err as Error).message}` };
  }
  const parsed = parseSettingsText(text);
  return parsed.ok
    ? { kind: 'ok', settings: parsed.settings, mtimeMs, mode, bom: text.startsWith('﻿') }
    : { kind: 'invalid', error: parsed.error };
}

export type ApplyResult =
  | { kind: 'unchanged' }
  | { kind: 'written'; backupPath?: string; removed?: number }
  | { kind: 'error'; error: string };

/** Injectable I/O primitives (tests simulate transient Windows rename failures with them). */
export interface SettingsIo {
  rename(from: string, to: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const defaultIo: SettingsIo = {
  rename: (from, to) => fsp.rename(from, to),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Only this many Claude City backups are kept per settings file. */
export const MAX_BACKUPS = 5;
/**
 * Backoff between rename attempts. On Windows, virus scanners / indexers / editors briefly holding the
 * target open make MoveFileEx fail with EPERM/EBUSY/EACCES; retrying shortly after usually succeeds.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKUP_INFIX = '.claude-city-backup-';

function timestamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`
  );
}

/** `<file>.claude-city-backup-YYYYMMDD-HHMMSS-mmm[-<counter>]` */
export function backupPathFor(file: string, now: Date, counter = 0): string {
  return `${file}${BACKUP_INFIX}${timestamp(now)}${counter > 0 ? `-${counter}` : ''}`;
}

/** Copies `file` to a fresh backup name; never overwrites an existing backup (COPYFILE_EXCL). */
async function createBackup(file: string, now: Date): Promise<string> {
  for (let counter = 0; counter < 100; counter++) {
    const backup = backupPathFor(file, now, counter);
    try {
      await fsp.copyFile(file, backup, fsConstants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('no free backup file name');
}

/**
 * Deletes all but the newest `keep` Claude City backups of `file` (including the older
 * second-precision names). Best effort: never throws. Returns the deleted paths.
 */
export async function pruneBackups(file: string, keep = MAX_BACKUPS): Promise<string[]> {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + BACKUP_INFIX;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const backups: { name: string; key: string; counter: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = /^(\d{8}-\d{6})(?:-(\d{3}))?(?:-(\d+))?$/.exec(name.slice(prefix.length));
    if (!m) continue;
    backups.push({ name, key: `${m[1]}-${m[2] ?? '000'}`, counter: Number(m[3] ?? 0) });
  }
  // newest first
  backups.sort((a, b) => (a.key === b.key ? b.counter - a.counter : a.key < b.key ? 1 : -1));
  const deleted: string[] = [];
  for (const b of backups.slice(Math.max(0, keep))) {
    const p = path.join(dir, b.name);
    try {
      await fsp.rm(p, { force: true });
      deleted.push(p);
    } catch {
      /* best effort */
    }
  }
  return deleted;
}

/**
 * Follows a symlinked settings file (e.g. dotfiles kept in a repo) so that temp file + rename
 * replace the real target instead of turning the link into a regular file. Dangling links throw.
 */
async function resolveWriteTarget(file: string): Promise<string> {
  try {
    const st = await fsp.lstat(file);
    if (!st.isSymbolicLink()) return file;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return file;
    throw err;
  }
  return fsp.realpath(file);
}

async function renameWithRetry(io: SettingsIo, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await io.sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Read -> transform -> backup -> atomic write. Aborts (without writing) on invalid JSON, on
 * unexpected shapes, or if the file changed while we were working. A symlinked file is resolved
 * first; backup, temp file and rename then all happen next to the real target.
 */
export async function updateSettingsFile(
  file: string,
  transform: (s: Settings) => { settings: Settings; changed: boolean; removed?: number },
  now: () => Date = () => new Date(),
  ioOverrides: Partial<SettingsIo> = {},
): Promise<ApplyResult> {
  const io: SettingsIo = { ...defaultIo, ...ioOverrides };
  let target: string;
  try {
    target = await resolveWriteTarget(file);
  } catch (err) {
    return { kind: 'error', error: `cannot resolve ${file}: ${(err as Error).message} - file left untouched` };
  }
  const read = await readSettingsFile(target);
  if (read.kind === 'invalid') return { kind: 'error', error: `${read.error} - file left untouched` };
  const before = read.kind === 'ok' ? read.settings : {};
  let result: { settings: Settings; changed: boolean; removed?: number };
  try {
    result = transform(before);
  } catch (err) {
    return { kind: 'error', error: `${(err as Error).message} - file left untouched` };
  }
  if (!result.changed) return { kind: 'unchanged' };

  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.claude-city-tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  // POSIX: keep the original permission bits (new files: user-only). Windows: mode only maps to the
  // read-only flag, and a read-only temp file could neither replace the target nor be cleaned up.
  const posix = process.platform !== 'win32';
  const mode = posix && read.kind === 'ok' ? read.mode & 0o777 : 0o600;
  const text = (read.kind === 'ok' && read.bom ? '﻿' : '') + serializeSettings(result.settings);
  let backupPath: string | undefined;
  try {
    await fsp.mkdir(dir, { recursive: true });
    if (read.kind === 'ok') backupPath = await createBackup(target, now());
    await fsp.writeFile(tmp, text, { encoding: 'utf8', mode, flag: 'wx' });
    if (posix) await fsp.chmod(tmp, mode); // writeFile's mode is filtered by the umask
    // Concurrent modification check right before the swap. A TOCTOU window remains between this
    // check and the rename (including the rename retries below): a writer landing exactly in those
    // milliseconds would be overwritten. Closing it would need OS-level locking that Claude Code
    // does not use; the backup written above still holds the pre-update content.
    const check = await readSettingsFile(target);
    const changedMeanwhile =
      (read.kind === 'missing' && check.kind !== 'missing') ||
      (read.kind === 'ok' && (check.kind !== 'ok' || check.mtimeMs !== read.mtimeMs));
    if (changedMeanwhile) {
      await fsp.rm(tmp, { force: true });
      return { kind: 'error', error: `${file} changed while updating - nothing written, please retry` };
    }
    await renameWithRetry(io, tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return { kind: 'error', error: `writing ${file} failed: ${(err as Error).message}` };
  }
  if (backupPath) await pruneBackups(target);
  const out: ApplyResult = { kind: 'written' };
  if (backupPath) out.backupPath = backupPath;
  if (result.removed !== undefined) out.removed = result.removed;
  return out;
}

export function installHooksInFile(
  file: string,
  spec: HookSpec,
  now?: () => Date,
  io?: Partial<SettingsIo>,
): Promise<ApplyResult> {
  return updateSettingsFile(file, (s) => mergeHooks(s, spec), now, io);
}

export function uninstallHooksFromFile(file: string, now?: () => Date, io?: Partial<SettingsIo>): Promise<ApplyResult> {
  return updateSettingsFile(file, (s) => unmergeHooks(s), now, io);
}

export async function fileInstallState(file: string, spec: HookSpec): Promise<InstallState> {
  const r = await readSettingsFile(file);
  return r.kind === 'ok' ? installState(r.settings, spec) : 'none';
}

export function userSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

export function workspaceSettingsPath(folder: string): string {
  return path.join(folder, '.claude', 'settings.local.json');
}
