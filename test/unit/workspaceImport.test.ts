import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsResult } from '../../src/backend/ClaudeCliClient';
import { EventStore } from '../../src/backend/EventStore';
import { toArchivedSession } from '../../src/backend/HistoricalSessions';
import { HistoryImporter } from '../../src/backend/HistoryImporter';
import { dedupeRoots, isProjectMarker, isProtectedFolder, isSkippedDirName, scanRoot } from '../../src/backend/FolderImport';
import { SessionManager, SessionManagerConfig } from '../../src/backend/SessionManager';
import { WorkspaceImporter, formatImportSummary } from '../../src/backend/WorkspaceImporter';
import {
  EXCLUSIONS_KEY,
  MAX_ENTRIES,
  REGISTRY_KEY,
  WorkspaceRegistry,
  migrateStoredWorkspace,
  workspaceIdForPath,
} from '../../src/backend/WorkspaceRegistry';
import { Session, normalizeSession } from '../../src/models/Session';
import { FakeTimers, MemoryMemento, settle } from './helpers';

let tmp: string;

function mkdirs(...rel: string[]): void {
  for (const r of rel) fs.mkdirSync(path.join(tmp, r), { recursive: true });
}
function touch(rel: string): void {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), '{}');
}
const p = (...rel: string[]) => path.join(tmp, ...rel);
const names = (paths: readonly string[]) => paths.map((x) => path.basename(x));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-import-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('FolderImport helpers', () => {
  it('skip list and hidden folders (case-insensitive)', () => {
    for (const n of ['.git', '.vscode', 'node_modules', 'Node_Modules', '$RECYCLE.BIN', 'System Volume Information', 'bin', 'OBJ', 'out', 'dist']) {
      expect(isSkippedDirName(n)).toBe(true);
    }
    for (const n of ['app', 'binary', 'src', 'output', 'distribution']) expect(isSkippedDirName(n)).toBe(false);
  });

  it('project markers', () => {
    for (const n of ['.git', '.claude', 'app.json', 'package.json', 'Package.JSON', 'My.sln']) expect(isProjectMarker(n)).toBe(true);
    for (const n of ['readme.md', 'app.json.bak', 'sln']) expect(isProjectMarker(n)).toBe(false);
  });

  it('drive roots, UNC share roots and the home folder are protected', () => {
    for (const x of ['C:\\', 'c:', 'D:/', '/', '\\\\server\\share', '\\\\server\\share\\', '//server']) expect(isProtectedFolder(x)).toBe(true);
    expect(isProtectedFolder('C:\\Users\\Me', 'c:/users/me/')).toBe(true);
    for (const x of ['C:\\VSO', '\\\\server\\share\\repos', '/home/me/src']) expect(isProtectedFolder(x, '/home/me')).toBe(false);
  });

  it('dedupes roots case- and slash-insensitively on Windows paths', () => {
    expect(dedupeRoots(['C:\\VSO', 'c:/vso/', ' C:\\Other ', '', 'C:\\other'])).toEqual(['C:\\VSO', 'C:\\Other']);
  });
});

describe('scanRoot', () => {
  it('imports every direct subfolder except hidden and skip-listed ones, sorted', async () => {
    mkdirs('zeta', 'Alpha', 'beta/nested', '.hidden', 'node_modules', 'bin', 'obj', 'out', 'dist', '.vscode');
    touch('file.txt');
    const r = await scanRoot(tmp);
    expect(r).toMatchObject({ exists: true, mode: 'children', truncated: 0 });
    expect(names(r.projects)).toEqual(['Alpha', 'beta', 'zeta']);
    expect(r.projects[0]).toBe(path.join(tmp, 'Alpha'));
  });

  it('single-project heuristic: a repo picked directly is imported as one workspace', async () => {
    touch('package.json');
    mkdirs('src', 'docs', '.git', 'node_modules/x');
    const r = await scanRoot(tmp);
    expect(r.mode).toBe('single');
    expect(r.projects).toEqual([tmp]);
  });

  it('a root with markers but project subfolders imports the subfolders', async () => {
    mkdirs('.git');
    touch('repoA/app.json');
    mkdirs('repoB');
    const r = await scanRoot(tmp);
    expect(r.mode).toBe('children');
    expect(names(r.projects)).toEqual(['repoA', 'repoB']);
  });

  it('*.sln marks a project', async () => {
    touch('Solution.sln');
    mkdirs('ProjA', 'ProjB');
    expect((await scanRoot(tmp)).mode).toBe('single');
  });

  it('never imports the home folder itself as one workspace (subfolders are fine)', async () => {
    touch('.claude/settings.json');
    mkdirs('src', 'Documents');
    // Windows paths compare case-insensitively; POSIX paths do not, so only vary the case there.
    const homeDir = process.platform === 'win32' ? tmp.toUpperCase() : tmp;
    const r = await scanRoot(tmp, { homeDir });
    expect(r.mode).toBe('children');
    expect(names(r.projects)).toEqual(['Documents', 'src']);
  });

  it('skips the home folder when it is a subfolder of the root', async () => {
    mkdirs('me', 'shared');
    const r = await scanRoot(tmp, { homeDir: p('me') });
    expect(names(r.projects)).toEqual(['shared']);
  });

  it('caps the number of projects per root', async () => {
    mkdirs('a', 'b', 'c', 'd', 'e');
    const r = await scanRoot(tmp, { maxPerRoot: 3 });
    expect(names(r.projects)).toEqual(['a', 'b', 'c']);
    expect(r.truncated).toBe(2);
  });

  it('missing roots and files do not throw', async () => {
    const r = await scanRoot(p('does-not-exist'));
    expect(r).toMatchObject({ exists: false, projects: [] });
    touch('f.txt');
    expect((await scanRoot(p('f.txt'))).exists).toBe(false);
  });
});

describe('WorkspaceRegistry (import, migration, pruning, exclusions)', () => {
  it('migrates entries from older versions without loss', async () => {
    const m = new MemoryMemento();
    m.data.set(REGISTRY_KEY, [
      { id: 'wold', path: 'C:\\Old\\Repo', name: 'Repo', firstSeen: 5, lastSeen: 7 },
      { id: 'wimp', path: 'C:\\Root\\X', name: 'X', firstSeen: 1, lastSeen: 2, source: 'imported', pinned: false, root: 'C:\\Root' },
      { id: 'wbad', path: 'C:\\Bad', name: 'Bad', firstSeen: 1, lastSeen: 2, source: 'nonsense', missing: 'yes' },
    ]);
    const r = new WorkspaceRegistry(m);
    expect(r.findById('wold')).toEqual({ id: 'wold', path: 'C:\\Old\\Repo', name: 'Repo', firstSeen: 5, lastSeen: 7, source: 'session', pinned: false });
    expect(r.findById('wimp')).toMatchObject({ source: 'imported', pinned: true, root: 'C:\\Root' });
    expect(r.findById('wbad')).toMatchObject({ source: 'session', pinned: false });
    expect(r.findById('wbad')!.missing).toBeUndefined();
    expect(r.isDirty).toBe(true); // migrated shape is persisted
    await r.flush();
    const stored = m.data.get(REGISTRY_KEY) as Record<string, unknown>[];
    expect(stored.find((w) => w.id === 'wold')).toMatchObject({ source: 'session', pinned: false, firstSeen: 5 });
    expect(migrateStoredWorkspace({ id: 'x', path: '  ', name: 'x', firstSeen: 1, lastSeen: 1 })).toBeUndefined();
  });

  it('imported workspaces are pinned, Windows paths match case-/slash-insensitively', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    r.register('c:/projects/app');
    const res = r.registerImported('C:\\Projects\\App\\', 'C:\\Projects')!;
    expect(res.added).toBe(false);
    expect(res.ws).toMatchObject({ id: workspaceIdForPath('c:/projects/app'), source: 'imported', pinned: true, root: 'C:\\Projects' });
    expect(r.size).toBe(1);
  });

  it('import absorbs unpinned session sub-workspaces so sessions land in the imported building', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    r.register('C:\\P\\app\\src'); // auto-created from a session cwd earlier
    r.setOpenFolders(['C:\\P\\app\\packages\\ui']); // open folders are kept
    r.registerImported('C:\\P\\app', 'C:\\P');
    expect(r.all().map((w) => w.name).sort()).toEqual(['app', 'ui']);
    const [s] = r.groupSessions([normalizeSession({ sessionId: 's', cwd: 'C:\\P\\app\\src\\x' })!]);
    expect(s.workspaceId).toBe(workspaceIdForPath('C:\\P\\app'));
  });

  it('never prunes pinned / imported workspaces; prunes unpinned session-less auto entries oldest first', () => {
    let now = 1;
    const r = new WorkspaceRegistry(new MemoryMemento(), { now: () => now });
    for (let i = 0; i < 20; i++) r.registerImported(`C:\\Root\\imp${i}`, 'C:\\Root');
    const pinnedAuto = r.register('C:\\auto\\pinned');
    r.setPinned(pinnedAuto.id, true);
    for (let i = 0; i < MAX_ENTRIES; i++) {
      now++;
      r.register(`C:\\auto\\a${String(i).padStart(4, '0')}`);
    }
    expect(r.size).toBe(MAX_ENTRIES);
    const all = r.all();
    expect(all.filter((w) => w.source === 'imported')).toHaveLength(20);
    expect(all.some((w) => w.path === 'C:\\auto\\pinned')).toBe(true);
    // the oldest auto entries went first
    expect(all.some((w) => w.path === 'C:\\auto\\a0000')).toBe(false);
    expect(all.some((w) => w.path === `C:\\auto\\a${String(MAX_ENTRIES - 1).padStart(4, '0')}`)).toBe(true);
  });

  it('setPinned cannot unpin imported workspaces', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    const { ws } = r.registerImported('C:\\R\\a', 'C:\\R')!;
    r.setPinned(ws.id, false);
    expect(r.findById(ws.id)!.pinned).toBe(true);
    expect(r.setPinned('nope', true)).toBe(false);
  });

  it('syncRoot: adds new folders, marks vanished ones missing, unmarks re-appearing ones, respects exclusions', async () => {
    const m = new MemoryMemento();
    const r = new WorkspaceRegistry(m);
    expect(r.syncRoot('C:\\R', ['C:\\R\\a', 'C:\\R\\b'])).toMatchObject({ added: 2, missing: 0 });
    expect(r.syncRoot('C:\\R', ['C:\\R\\a', 'C:\\R\\b'])).toMatchObject({ added: 0, known: 2, changed: 0 });
    const res = r.syncRoot('C:\\R', ['C:\\R\\a', 'C:\\R\\c']);
    expect(res).toMatchObject({ added: 1, missing: 1, changed: 2 });
    expect(r.findByPath('C:\\R\\b')!.missing).toBe(true);
    expect(r.syncRoot('c:/r/', ['c:/r/a', 'C:\\R\\b', 'C:\\R\\c'])).toMatchObject({ added: 0, missing: 0, changed: 1 });
    expect(r.findByPath('C:\\R\\b')!.missing).toBeUndefined();

    // Remove from City -> excluded, the rescan does not re-add it (persisted)
    r.remove(r.findByPath('C:\\R\\c')!.id);
    await r.flush();
    expect(m.data.get(EXCLUSIONS_KEY)).toEqual(['c:/r/c']);
    const r2 = new WorkspaceRegistry(m);
    expect(r2.syncRoot('C:\\R', ['C:\\R\\a', 'C:\\R\\b', 'C:\\R\\c'])).toMatchObject({ added: 0, excluded: 1 });
    expect(r2.findByPath('C:\\R\\c')).toBeUndefined();
    // explicit import (force) undoes the exclusion
    expect(r2.registerImported('C:\\R\\c', 'C:\\R', { force: true })!.added).toBe(true);
    expect(r2.isExcluded('C:\\R\\c')).toBe(false);
  });

  it('archived sessions do not re-create a removed workspace, live sessions do', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    const ws = r.register('C:\\gone');
    r.remove(ws.id);
    const hist = { ...toArchivedSession({ sessionId: '00000001-aaaa-4bbb-8ccc-dddddddddddd', cwd: 'C:\\gone\\src', lastActivityAt: 1 }) };
    expect(r.groupSessions([hist], { touch: false })).toEqual([]);
    expect(r.findByPath('C:\\gone')).toBeUndefined();
    const [live] = r.groupSessions([normalizeSession({ sessionId: 'l', cwd: 'C:\\gone' })!]);
    expect(r.findById(live.workspaceId!)!.path).toBe('C:\\gone');
  });

  it('markRootMissing and removeByRoot', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    r.syncRoot('C:\\R', ['C:\\R\\a', 'C:\\R\\b']);
    r.registerImported('C:\\S\\x', 'C:\\S');
    expect(r.markRootMissing('c:/r')).toBe(2);
    expect(r.markRootMissing('c:/r')).toBe(0);
    expect(r.removeByRoot('C:\\R')).toBe(2);
    expect(r.all().map((w) => w.name)).toEqual(['x']);
  });
});

describe('WorkspaceImporter', () => {
  function setup(initialRoots: string[] = []) {
    const registry = new WorkspaceRegistry(new MemoryMemento(), { homeDir: 'C:\\Users\\nobody-cc-test' });
    let roots = [...initialRoots];
    const warnings: string[] = [];
    let changes = 0;
    const importer = new WorkspaceImporter({
      registry,
      getRoots: () => roots,
      setRoots: async (r) => {
        roots = r;
      },
      warn: (m) => warnings.push(m),
      onChanged: () => changes++,
    });
    return { registry, importer, roots: () => roots, warnings, changes: () => changes };
  }

  it('imports subfolders, reports already known ones and stores the root once', async () => {
    mkdirs('root/a', 'root/b', 'root/c', 'root/.cache', 'root/node_modules');
    const t = setup();
    t.registry.register(p('root', 'b')); // already known from a session
    const s1 = await t.importer.importFolders([p('root')]);
    expect(s1).toMatchObject({ roots: 1, imported: 2, alreadyKnown: 1 });
    expect(t.registry.findByPath(p('root', 'b'))).toMatchObject({ source: 'imported', pinned: true });
    expect(t.roots()).toEqual([p('root')]);
    const s2 = await t.importer.importFolders([p('root'), p('root').toUpperCase()]);
    expect(s2).toMatchObject({ imported: 0, alreadyKnown: 3 });
    expect(t.roots()).toHaveLength(1);
    expect(formatImportSummary({ roots: 1, imported: 12, alreadyKnown: 3, truncated: 0, single: 0, failed: [] })).toBe(
      '12 workspaces imported, 3 already known',
    );
    expect(t.changes()).toBe(2);
  });

  it('caps a single import and reports the overflow', async () => {
    mkdirs('big/a', 'big/b', 'big/c');
    const registry = new WorkspaceRegistry(new MemoryMemento());
    const importer = new WorkspaceImporter({ registry, getRoots: () => [], setRoots: async () => undefined, maxPerRoot: 2 });
    const s = await importer.importFolders([p('big')]);
    expect(s).toMatchObject({ imported: 2, truncated: 1 });
    expect(formatImportSummary(s)).toContain('1 skipped');
  });

  it('rescan: new subfolders appear, vanished ones are marked missing, missing roots warn once', async () => {
    mkdirs('r1/a', 'r1/b');
    const t = setup([p('r1'), p('gone')]);
    await t.importer.rescan();
    expect(t.registry.all().map((w) => w.name).sort()).toEqual(['a', 'b']);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('gone');

    mkdirs('r1/c');
    fs.rmSync(p('r1', 'a'), { recursive: true });
    await t.importer.rescan();
    expect(t.registry.findByPath(p('r1', 'c'))).toBeDefined();
    expect(t.registry.findByPath(p('r1', 'a'))!.missing).toBe(true);
    expect(t.warnings).toHaveLength(1); // still missing, no second warning

    // root vanishes completely -> all its workspaces missing, nothing deleted
    fs.rmSync(p('r1'), { recursive: true });
    await t.importer.rescan();
    expect(t.registry.workspacesOfRoot(p('r1')).every((w) => w.missing)).toBe(true);
    expect(t.registry.size).toBe(3);
  });

  it('removeRoot optionally removes the imported workspaces', async () => {
    mkdirs('r/a', 'r/b', 's/x');
    const t = setup();
    await t.importer.importFolders([p('r'), p('s')]);
    expect(await t.importer.removeRoot(p('r'), false)).toBe(0);
    expect(t.roots()).toEqual([p('s')]);
    expect(t.registry.size).toBe(3);
    expect(await t.importer.removeRoot(p('s'), true)).toBe(1);
    expect(t.registry.size).toBe(2);
  });

  it('rescan runs on the history importer cadence even when history import is off', async () => {
    mkdirs('r/a');
    const t = setup([p('r')]);
    const timers = new FakeTimers();
    let sessions = -1;
    const hi = new HistoryImporter({
      scanner: { scan: async () => ({ sessions: [], stats: {} as never }), persist: async () => undefined, clear: async () => undefined },
      getConfig: () => ({ enabled: false, maxAgeDays: 1, recentDays: 7, useClaudeArchive: false }),
      onSessions: (s) => (sessions = s.length),
      beforeScan: () => t.importer.rescan(),
      timers,
    });
    await hi.refresh();
    expect(t.registry.size).toBe(1);
    expect(sessions).toBe(0);
    expect(timers.delays()).toEqual([120_000]);
    hi.dispose();
  });
});

describe('city with imported workspaces', () => {
  const ok = (...sessions: Session[]): AgentsResult => ({ kind: 'ok', malformed: 0, sessions });
  it('shows all registry workspaces without sessions and groups live + archived sessions into imported buildings', async () => {
    const timers = new FakeTimers();
    const registry = new WorkspaceRegistry(new MemoryMemento(), { homeDir: 'C:\\Users\\me' });
    registry.syncRoot('C:\\Repos', ['C:\\Repos\\api', 'C:\\Repos\\web', 'C:\\Repos\\tools']);
    const cfg: SessionManagerConfig = { pollIntervalSeconds: 4, demoMode: 'off' };
    const live = normalizeSession({ sessionId: 'live1', cwd: 'c:\\repos\\api\\src', status: 'busy' })!;
    const mgr = new SessionManager({
      client: { listSessions: async () => ok(live), version: async () => '2' },
      registry,
      events: new EventStore(100),
      getConfig: () => cfg,
      timers,
      now: () => 1_000_000,
    });
    mgr.start();
    await settle();
    mgr.setHistorySessions([
      toArchivedSession({ sessionId: '00000001-aaaa-4bbb-8ccc-dddddddddddd', cwd: 'C:\\Repos\\web', lastActivityAt: 5 }),
    ]);
    const st = mgr.state;
    expect(st.workspaces.map((w) => w.name).sort()).toEqual(['api', 'tools', 'web']);
    const byName = new Map(st.workspaces.map((w) => [w.name, w]));
    expect(byName.get('api')!.sessionIds).toEqual(['live1']);
    expect(byName.get('web')!.sessionIds).toEqual(['00000001-aaaa-4bbb-8ccc-dddddddddddd']);
    expect(byName.get('tools')).toMatchObject({ sessionIds: [], source: 'imported', pinned: true });

    // regroupHistory moves archived sessions after a registry change
    registry.registerImported('C:\\Repos\\web\\sub', 'C:\\Repos');
    mgr.setHistorySessions([
      toArchivedSession({ sessionId: '00000002-aaaa-4bbb-8ccc-dddddddddddd', cwd: 'C:\\Repos\\web\\sub\\x', lastActivityAt: 5 }),
    ]);
    expect(mgr.state.workspaces.find((w) => w.name === 'sub')!.sessionIds).toEqual(['00000002-aaaa-4bbb-8ccc-dddddddddddd']);
    mgr.dispose();
  });
});
