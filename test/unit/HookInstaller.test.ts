import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_PATH,
  HookSpec,
  INSTALLED_EVENTS,
  MAX_BACKUPS,
  RENAME_RETRY_DELAYS_MS,
  TOKEN_HEADER_NAME,
  backupPathFor,
  hookUrl,
  installHooksInFile,
  installState,
  isOurHandler,
  mergeHooks,
  parseSettingsText,
  pruneBackups,
  serializeSettings,
  uninstallHooksFromFile,
  unmergeHooks,
} from '../../src/backend/HookInstaller';

const SPEC: HookSpec = { port: 47821, token: 'tok_0123456789abcdefABCDEF' };

const foreign = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    Notification: [{ matcher: '', hooks: [{ type: 'http', url: 'https://example.com/hook' }] }],
  },
  env: { FOO: '1' },
});

function countOurs(s: Record<string, unknown>): number {
  let n = 0;
  for (const groups of Object.values((s.hooks ?? {}) as Record<string, unknown[]>)) {
    for (const g of groups as { hooks: unknown[] }[]) n += g.hooks.filter(isOurHandler).length;
  }
  return n;
}

describe('mergeHooks / unmergeHooks (pure)', () => {
  it('installs into an empty object with one group per event', () => {
    const { settings, changed } = mergeHooks({}, SPEC);
    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
    expect(Object.keys(hooks)).toEqual([...INSTALLED_EVENTS]);
    expect(hooks.Stop[0].hooks[0]).toEqual({
      type: 'http',
      url: hookUrl(47821),
      headers: { [TOKEN_HEADER_NAME]: SPEC.token },
      timeout: 3,
    });
    expect(hooks.Stop[0]).not.toHaveProperty('matcher');
    expect(installState(settings, SPEC)).toBe('current');
  });

  it('never installs behavior-changing or http-unsupported events', () => {
    const { settings } = mergeHooks({}, SPEC);
    const keys = Object.keys(settings.hooks as object);
    for (const e of ['SessionStart', 'WorktreeCreate', 'WorktreeRemove', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
      expect(keys).not.toContain(e);
    }
  });

  it('preserves foreign hooks, their order and all unrelated keys', () => {
    const before = foreign();
    const { settings } = mergeHooks(before, SPEC);
    expect(Object.keys(settings)).toEqual(['model', 'permissions', 'hooks', 'env']);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
    expect(hooks.Stop[0]).toEqual(before.hooks.Stop[0]);
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Notification[0]).toEqual(before.hooks.Notification[0]);
    expect(Object.keys(hooks).slice(0, 3)).toEqual(['PreToolUse', 'Stop', 'Notification']);
    expect(before).toEqual(foreign()); // input not mutated
  });

  it('is idempotent', () => {
    const once = mergeHooks(foreign(), SPEC).settings;
    const twice = mergeHooks(once, SPEC);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toBe(once);
    expect(countOurs(once)).toBe(INSTALLED_EVENTS.length);
  });

  it('replaces outdated entries (port/token change) without duplicates', () => {
    const old = mergeHooks(foreign(), { port: 40000, token: 'old_token_0123456789' }).settings;
    expect(installState(old, SPEC)).toBe('outdated');
    const next = mergeHooks(old, SPEC);
    expect(next.changed).toBe(true);
    expect(countOurs(next.settings)).toBe(INSTALLED_EVENTS.length);
    expect(installState(next.settings, SPEC)).toBe('current');
    expect(JSON.stringify(next.settings)).not.toContain('40000');
  });

  it('legacy SessionStart entry: install state outdated, replaced on install, removed on uninstall', () => {
    const legacySpec = { ...SPEC, events: ['SessionStart', ...INSTALLED_EVENTS] };
    const legacy = mergeHooks(foreign(), legacySpec).settings;
    const legacyHooks = legacy.hooks as Record<string, unknown[]>;
    expect(legacyHooks.SessionStart).toHaveLength(1);
    expect(installState(legacy, SPEC)).toBe('outdated');

    const next = mergeHooks(legacy, SPEC);
    expect(next.changed).toBe(true);
    expect(next.settings.hooks).not.toHaveProperty('SessionStart');
    expect(installState(next.settings, SPEC)).toBe('current');

    const removed = unmergeHooks(legacy);
    expect(removed.removed).toBe(INSTALLED_EVENTS.length + 1);
    expect(removed.settings).toEqual(foreign());
  });

  it('uninstall keeps a foreign SessionStart command hook next to our legacy entry', () => {
    const s = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo hi' }] },
          { hooks: [{ type: 'http', url: hookUrl(47821), headers: { [TOKEN_HEADER_NAME]: SPEC.token }, timeout: 3 }] },
        ],
      },
    };
    expect(unmergeHooks(s).settings).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
  });

  it('uninstall restores an equivalent structure', () => {
    const before = foreign();
    const installed = mergeHooks(before, SPEC).settings;
    const { settings, removed, changed } = unmergeHooks(installed);
    expect(changed).toBe(true);
    expect(removed).toBe(INSTALLED_EVENTS.length);
    expect(settings).toEqual(before);
    expect(serializeSettings(settings)).toBe(serializeSettings(before));
  });

  it('uninstall from a file that only had our hooks removes the hooks object entirely', () => {
    const { settings } = unmergeHooks(mergeHooks({ theme: 'dark' }, SPEC).settings);
    expect(settings).toEqual({ theme: 'dark' });
  });

  it('uninstall keeps foreign handlers that share a group with ours', () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'a' },
              { type: 'http', url: `http://localhost:1234${HOOK_PATH}` },
            ],
          },
        ],
      },
    };
    const { settings, removed } = unmergeHooks(mixed);
    expect(removed).toBe(1);
    expect(settings).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } });
  });

  it('uninstall without our hooks is a no-op', () => {
    const f = foreign();
    expect(unmergeHooks(f)).toEqual({ settings: f, changed: false, removed: 0 });
    expect(unmergeHooks({})).toEqual({ settings: {}, changed: false, removed: 0 });
  });

  it('identifies only our handlers', () => {
    expect(isOurHandler({ type: 'http', url: `http://127.0.0.1:1${HOOK_PATH}` })).toBe(true);
    expect(isOurHandler({ type: 'http', url: `https://evil.example${HOOK_PATH}` })).toBe(false);
    expect(isOurHandler({ type: 'command', command: `curl http://127.0.0.1${HOOK_PATH}` })).toBe(false);
    expect(isOurHandler({ type: 'http', url: 'not a url' })).toBe(false);
    expect(isOurHandler(null)).toBe(false);
  });

  it('refuses unexpected shapes', () => {
    expect(() => mergeHooks({ hooks: [] }, SPEC)).toThrow(/not an object/);
    expect(() => mergeHooks({ hooks: { Stop: {} } }, SPEC)).toThrow(/not an array/);
    expect(() => mergeHooks({}, { port: 0, token: SPEC.token })).toThrow(/port/);
    expect(() => mergeHooks({}, { port: 1, token: 'bad token "x"' })).toThrow(/token/);
  });

  it('parseSettingsText handles empty, BOM, invalid and non-object JSON', () => {
    expect(parseSettingsText('')).toEqual({ ok: true, settings: {} });
    expect(parseSettingsText('﻿{"a":1}')).toEqual({ ok: true, settings: { a: 1 } });
    expect(parseSettingsText('{ "a": 1, }').ok).toBe(false);
    expect(parseSettingsText('[1]').ok).toBe(false);
    expect(parseSettingsText('null').ok).toBe(false);
  });
});

describe('installHooksInFile / uninstallHooksFromFile (temp dir)', () => {
  let dir: string;
  let file: string;
  const fixed = () => new Date(2026, 9, 8, 13, 5, 9);

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-city-hooks-'));
    file = path.join(dir, '.claude', 'settings.json');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('creates a missing file (and directory) without a backup', async () => {
    const r = await installHooksInFile(file, SPEC, fixed);
    expect(r).toEqual({ kind: 'written' });
    const text = await fsp.readFile(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "hooks": {');
    expect(installState(JSON.parse(text), SPEC)).toBe('current');
  });

  it('backs up the existing file, writes atomically and leaves no temp files', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify(foreign(), null, 4);
    await fsp.writeFile(file, original);
    const r = await installHooksInFile(file, SPEC, fixed);
    expect(r.kind).toBe('written');
    const backup = backupPathFor(file, fixed());
    expect(r).toMatchObject({ backupPath: backup });
    expect(backup).toMatch(/settings\.json\.claude-city-backup-20261008-130509-000$/);
    expect(await fsp.readFile(backup, 'utf8')).toBe(original);
    const entries = await fsp.readdir(path.dirname(file));
    expect(entries.filter((e) => e.includes('tmp'))).toEqual([]);
    const after = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(after.hooks.PreToolUse).toEqual(foreign().hooks.PreToolUse);
  });

  it('second install is unchanged (no new backup)', async () => {
    await installHooksInFile(file, SPEC, fixed);
    const r = await installHooksInFile(file, SPEC, () => new Date(2027, 0, 1));
    expect(r).toEqual({ kind: 'unchanged' });
    expect((await fsp.readdir(path.dirname(file))).filter((e) => e.includes('backup'))).toEqual([]);
  });

  it('never overwrites invalid JSON', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{ "hooks": { oops ');
    const r = await installHooksInFile(file, SPEC, fixed);
    expect(r.kind).toBe('error');
    expect((r as { error: string }).error).toMatch(/invalid JSON.*untouched/);
    expect(await fsp.readFile(file, 'utf8')).toBe('{ "hooks": { oops ');
    expect(await fsp.readdir(path.dirname(file))).toEqual(['settings.json']);
  });

  it('never overwrites unexpected shapes', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{"hooks": []}');
    const r = await installHooksInFile(file, SPEC, fixed);
    expect(r.kind).toBe('error');
    expect(await fsp.readFile(file, 'utf8')).toBe('{"hooks": []}');
  });

  it('uninstall round trip restores the original content', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, serializeSettings(foreign()));
    await installHooksInFile(file, SPEC, fixed);
    const r = await uninstallHooksFromFile(file, () => new Date(2026, 9, 8, 14, 0, 0));
    expect(r).toMatchObject({ kind: 'written', removed: INSTALLED_EVENTS.length });
    expect(await fsp.readFile(file, 'utf8')).toBe(serializeSettings(foreign()));
    expect(await uninstallHooksFromFile(file)).toEqual({ kind: 'unchanged' });
  });

  const backupsOf = async () =>
    (await fsp.readdir(path.dirname(file))).filter((e) => e.startsWith('settings.json.claude-city-backup-')).sort();

  it('never overwrites a backup with the same timestamp (counter suffix)', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{"a":1}');
    const r1 = await installHooksInFile(file, SPEC, fixed);
    const r2 = await uninstallHooksFromFile(file, fixed);
    expect(r1).toMatchObject({ backupPath: backupPathFor(file, fixed()) });
    expect(r2).toMatchObject({ backupPath: backupPathFor(file, fixed(), 1) });
    expect(await fsp.readFile(backupPathFor(file, fixed()), 'utf8')).toBe('{"a":1}');
    expect(await backupsOf()).toHaveLength(2);
  });

  it(`keeps only the newest ${MAX_BACKUPS} backups`, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{}');
    // an old-format (second precision) backup and an unrelated file must be handled correctly
    await fsp.writeFile(`${file}.claude-city-backup-20200101-000000`, 'old');
    await fsp.writeFile(`${file}.claude-city-backup-notes`, 'keep me');
    for (let i = 0; i < 7; i++) {
      const at = () => new Date(2026, 9, 8, 13, 0, i, 5);
      expect((await installHooksInFile(file, { ...SPEC, port: 40000 + i }, at)).kind).toBe('written');
    }
    const left = await backupsOf();
    expect(left).toHaveLength(MAX_BACKUPS + 1);
    expect(left).toContain('settings.json.claude-city-backup-notes');
    expect(left).not.toContain('settings.json.claude-city-backup-20200101-000000');
    expect(left).toContain(path.basename(backupPathFor(file, new Date(2026, 9, 8, 13, 0, 6, 5))));
    expect(left).not.toContain(path.basename(backupPathFor(file, new Date(2026, 9, 8, 13, 0, 1, 5))));
  });

  it('pruneBackups orders by timestamp, then counter', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const t = new Date(2026, 0, 1, 0, 0, 0, 0);
    for (const c of [0, 1, 2, 10]) await fsp.writeFile(backupPathFor(file, t, c), '');
    await fsp.writeFile(backupPathFor(file, new Date(2026, 0, 2)), '');
    const deleted = await pruneBackups(file, 2);
    expect(deleted.map((d) => path.basename(d)).sort()).toEqual(
      [0, 1, 2].map((c) => path.basename(backupPathFor(file, t, c))).sort(),
    );
    expect(await pruneBackups(path.join(dir, 'missing', 'x.json'))).toEqual([]);
  });

  it('preserves a UTF-8 BOM (and does not add one)', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '\uFEFF{"theme":"dark"}');
    await installHooksInFile(file, SPEC, fixed);
    const text = await fsp.readFile(file, 'utf8');
    expect(text.startsWith('\uFEFF{')).toBe(true);
    expect(text.indexOf('\uFEFF', 1)).toBe(-1);
    const parsed = parseSettingsText(text);
    expect(parsed.ok && installState(parsed.settings, SPEC)).toBe('current');
    await fsp.writeFile(file, '{}');
    await installHooksInFile(file, { ...SPEC, port: 40000 }, fixed);
    expect((await fsp.readFile(file, 'utf8')).startsWith('{')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('preserves the original file mode (POSIX)', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{}');
    await fsp.chmod(file, 0o640);
    await installHooksInFile(file, SPEC, fixed);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o640);
  });

  it('follows a symlinked settings file and keeps the link', async (ctx) => {
    const realDir = path.join(dir, 'dotfiles');
    const real = path.join(realDir, 'claude-settings.json');
    await fsp.mkdir(realDir, { recursive: true });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(real, '{"theme":"dark"}');
    try {
      await fsp.symlink(real, file, 'file');
    } catch {
      ctx.skip(); // creating symlinks needs Developer Mode / admin on Windows
      return;
    }
    const r = await installHooksInFile(file, SPEC, fixed);
    expect(r.kind).toBe('written');
    expect((await fsp.lstat(file)).isSymbolicLink()).toBe(true);
    const after = JSON.parse(await fsp.readFile(real, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(installState(after, SPEC)).toBe('current');
    expect((r as { backupPath?: string }).backupPath).toBe(backupPathFor(await fsp.realpath(real), fixed()));
    expect((await fsp.readdir(realDir)).filter((e) => e.includes('tmp'))).toEqual([]);
    expect(await fsp.readdir(path.dirname(file))).toEqual(['settings.json']);
  });

  it('refuses a dangling symlink', async (ctx) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await fsp.symlink(path.join(dir, 'nowhere.json'), file, 'file');
    } catch {
      ctx.skip();
      return;
    }
    const r = await installHooksInFile(file, SPEC, fixed);
    expect(r.kind).toBe('error');
    expect((await fsp.lstat(file)).isSymbolicLink()).toBe(true);
  });

  it('retries a rename that fails transiently (Windows EPERM/EBUSY/EACCES)', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const rename = async (a: string, b: string) => {
      calls++;
      if (calls <= 3) throw Object.assign(new Error('locked'), { code: ['EPERM', 'EBUSY', 'EACCES'][calls - 1] });
      await fsp.rename(a, b);
    };
    const r = await installHooksInFile(file, SPEC, fixed, { rename, sleep: async (ms) => void sleeps.push(ms) });
    expect(r.kind).toBe('written');
    expect(calls).toBe(4);
    expect(sleeps).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 3));
    expect(installState(JSON.parse(await fsp.readFile(file, 'utf8')), SPEC)).toBe('current');
  });

  it('gives up after the retries / on other errors and cleans up the temp file', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{"a":1}');
    let calls = 0;
    const busy = async () => {
      calls++;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    const r = await installHooksInFile(file, SPEC, fixed, { rename: busy, sleep: async () => undefined });
    expect(r.kind).toBe('error');
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
    expect(await fsp.readFile(file, 'utf8')).toBe('{"a":1}');
    expect((await fsp.readdir(path.dirname(file))).filter((e) => e.includes('tmp'))).toEqual([]);

    calls = 0;
    const other = async () => {
      calls++;
      throw Object.assign(new Error('nope'), { code: 'EXDEV' });
    };
    expect((await installHooksInFile(file, SPEC, fixed, { rename: other })).kind).toBe('error');
    expect(calls).toBe(1);
  });

  it('uninstall of a missing file is unchanged and creates nothing', async () => {
    expect(await uninstallHooksFromFile(file)).toEqual({ kind: 'unchanged' });
    await expect(fsp.stat(file)).rejects.toThrow();
  });
});
