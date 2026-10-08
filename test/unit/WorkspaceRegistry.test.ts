import { describe, expect, it } from 'vitest';
import { REGISTRY_KEY, UNASSIGNED_WORKSPACE_ID, WorkspaceRegistry, workspaceIdForPath } from '../../src/backend/WorkspaceRegistry';
import { displayName, isSameOrChildKey, normalizePathKey } from '../../src/backend/pathUtils';
import { normalizeSession } from '../../src/models/Session';
import { MemoryMemento } from './helpers';

const sess = (id: string, cwd?: string) => normalizeSession({ sessionId: id, cwd })!;

describe('pathUtils', () => {
  it('normalizes Windows paths case-insensitively with slash and trailing separator handling', () => {
    expect(normalizePathKey('C:\\VSO\\Agent City\\')).toBe('c:/vso/agent city');
    expect(normalizePathKey('c:/vso//Agent City')).toBe('c:/vso/agent city');
    expect(normalizePathKey('C:\\')).toBe('c:/');
    expect(normalizePathKey('C:')).toBe('c:/');
    expect(normalizePathKey('\\\\server\\share\\x\\')).toBe('//server/share/x');
    expect(normalizePathKey('C:\\a\\.\\b')).toBe('c:/a/b');
  });
  it('keeps posix paths case-sensitive', () => {
    expect(normalizePathKey('/Users/Me/Repo/')).toBe('/Users/Me/Repo');
    expect(normalizePathKey('/')).toBe('/');
  });
  it('prefix check respects segment boundaries', () => {
    expect(isSameOrChildKey('c:/vso/a', 'c:/vso/a/b')).toBe(true);
    expect(isSameOrChildKey('c:/vso/a', 'c:/vso/ab')).toBe(false);
    expect(isSameOrChildKey('c:/', 'c:/x')).toBe(true);
  });
  it('display name', () => {
    expect(displayName('C:\\VSO\\Agent City\\')).toBe('Agent City');
    expect(displayName('/')).toBe('/');
  });
});

describe('WorkspaceRegistry', () => {
  it('groups sessions by longest prefix', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    r.register('C:\\VSO');
    r.register('C:\\VSO\\Agent City');
    const [a, b, c] = r.groupSessions([sess('a', 'c:\\vso\\agent city\\src'), sess('b', 'C:/VSO/Other'), sess('c', 'C:\\VSO\\Agent City')]);
    expect(a.workspaceId).toBe(workspaceIdForPath('C:\\VSO\\Agent City'));
    expect(c.workspaceId).toBe(a.workspaceId);
    expect(b.workspaceId).toBe(workspaceIdForPath('C:\\VSO'));
  });

  it('creates a workspace from cwd when no prefix matches', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    const [s] = r.groupSessions([sess('a', 'D:\\work\\proj')]);
    const ws = r.findById(s.workspaceId!)!;
    expect(ws.name).toBe('proj');
    expect(ws.path).toBe('D:\\work\\proj');
  });

  it('treats differently-cased / slashed Windows paths as the same workspace', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    r.register('C:\\VSO\\Repo\\');
    r.register('c:/vso/repo');
    expect(r.all()).toHaveLength(1);
    expect(workspaceIdForPath('C:\\VSO\\Repo\\')).toBe(workspaceIdForPath('c:/vso/repo'));
  });

  it('never uses the home directory or a drive root as a prefix anchor', () => {
    const r = new WorkspaceRegistry(new MemoryMemento(), { homeDir: 'C:\\Users\\me' });
    r.register('C:\\Users\\me');
    r.register('C:\\');
    const [s] = r.groupSessions([sess('a', 'C:\\Users\\me\\projects\\x')]);
    expect(r.findById(s.workspaceId!)!.name).toBe('x');
    const [h] = r.groupSessions([sess('h', 'c:\\users\\me')]);
    expect(h.workspaceId).toBe(workspaceIdForPath('C:\\Users\\me'));
  });

  it('assigns sessions without cwd to the unassigned workspace', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    const grouped = r.groupSessions([sess('a')]);
    expect(grouped[0].workspaceId).toBe(UNASSIGNED_WORKSPACE_ID);
    const city = r.buildCityWorkspaces(grouped);
    expect(city.map((w) => w.id)).toEqual([UNASSIGNED_WORKSPACE_ID]);
  });

  it('city workspaces: every registry workspace is shown (always visible), open first', () => {
    const r = new WorkspaceRegistry(new MemoryMemento());
    r.register('C:\\old\\unused');
    r.setOpenFolders(['C:\\zeta']);
    const grouped = r.groupSessions([sess('a', 'C:\\alpha'), sess('b', 'C:\\zeta\\sub')]);
    const city = r.buildCityWorkspaces(grouped);
    expect(city.map((w) => w.name)).toEqual(['zeta', 'alpha', 'unused']);
    expect(city[2]).toMatchObject({ sessionIds: [], open: false });
    expect(city[0]).toMatchObject({ open: true, sessionIds: ['b'] });
  });

  it('persists to and restores from the memento', async () => {
    let now = 1000;
    const m = new MemoryMemento();
    const r1 = new WorkspaceRegistry(m, { now: () => now });
    r1.register('C:\\VSO\\A');
    r1.groupSessions([sess('x', 'C:\\VSO\\B')]);
    await r1.flush();
    expect(m.updates).toBe(1);
    await r1.flush(); // not dirty -> no write
    expect(m.updates).toBe(1);

    now = 5000;
    const r2 = new WorkspaceRegistry(m, { now: () => now });
    expect(r2.all().map((w) => w.name).sort()).toEqual(['A', 'B']);
    expect(r2.all().every((w) => w.firstSeen === 1000)).toBe(true);
    // lastSeen only rewritten after >= 60s
    r2.register('C:\\VSO\\A');
    expect(r2.isDirty).toBe(false);
    now = 70_000;
    r2.register('C:\\VSO\\A');
    expect(r2.isDirty).toBe(true);
  });

  it('ignores corrupt stored entries', () => {
    const m = new MemoryMemento();
    m.data.set(REGISTRY_KEY, [{ id: 1 }, null, 'x', { id: 'w', path: 'C:\\ok', name: 'ok', firstSeen: 1, lastSeen: 1 }]);
    expect(new WorkspaceRegistry(m).all().map((w) => w.name)).toEqual(['ok']);
    m.data.set(REGISTRY_KEY, 'garbage');
    expect(new WorkspaceRegistry(m).all()).toEqual([]);
  });

  it('flush never rejects when the memento fails', async () => {
    const r = new WorkspaceRegistry({
      get: () => undefined,
      update: () => Promise.reject(new Error('disk full')),
    });
    r.register('C:\\x');
    const spy = console.error;
    console.error = () => undefined;
    await expect(r.flush()).resolves.toBeUndefined();
    console.error = spy;
    expect(r.isDirty).toBe(true);
  });
});
