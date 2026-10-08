import { describe, expect, it } from 'vitest';
import { AgentsResult } from '../../src/backend/ClaudeCliClient';
import { EventStore } from '../../src/backend/EventStore';
import { toArchivedSession } from '../../src/backend/HistoricalSessions';
import { SessionManager, SessionManagerConfig } from '../../src/backend/SessionManager';
import { WorkspaceRegistry } from '../../src/backend/WorkspaceRegistry';
import { cityFingerprint, deriveAgents, mergeHistorySessions } from '../../src/backend/cityStateBuilder';
import { CityState, computeCounts, summaryText } from '../../src/models/CityState';
import { Session, normalizeSession, sessionPhase } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import { DEFAULT_FILTERS, applyFilters, isFilterActive } from '../../src/webview/filters';
import { interiorFor } from '../../src/webview/buildingInterior';
import { computeFacade } from '../../src/webview/facade';
import { FakeTimers, MemoryMemento, settle } from './helpers';

const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const hist = (n: number, cwd: string, lastActivityAt: number, extra: Partial<Session> = {}): Session => ({
  ...toArchivedSession({ sessionId: id(n), cwd, lastActivityAt, title: `title ${n}`, gitBranch: `branch-${n}` }),
  ...extra,
});
const liveS = (sid: string, cwd: string, status = 'busy') => normalizeSession({ sessionId: sid, cwd, status })!;

describe('history merge', () => {
  it('live and hook-only sessions win over archived ones with the same id', () => {
    const live = { ...liveS(id(1), 'C:\\r'), workspaceId: 'w' };
    const hook: Session = { id: id(2), sessionId: id(2), kind: 'hook', state: 'unknown', status: 'unknown', transient: true, workspaceId: 'w' };
    const history = [hist(1, 'C:\\r', 5, { workspaceId: 'w' }), hist(2, 'C:\\r', 4, { workspaceId: 'w' }), hist(3, 'C:\\r', 3, { workspaceId: 'w' })];
    const m = mergeHistorySessions([live, hook], history, 12);
    expect(m.sessions.map((s) => [s.id, s.origin ?? 'live'])).toEqual([
      [id(1), 'live'],
      [id(2), 'live'],
      [id(3), 'history'],
    ]);
    expect(m.overflow.size).toBe(0);
  });

  it('keeps the most recent archived sessions per workspace and reports overflow', () => {
    const history = [
      ...[1, 2, 3, 4].map((n) => hist(n, 'C:\\a', n * 10, { workspaceId: 'wa' })),
      hist(5, 'C:\\b', 1, { workspaceId: 'wb' }),
      hist(6, 'C:\\c', 1), // ungrouped -> ignored
    ];
    const m = mergeHistorySessions([], history, 2);
    expect(m.sessions.map((s) => s.id)).toEqual([id(4), id(3), id(5)]);
    expect([...m.overflow]).toEqual([['wa', 2]]);
    expect(mergeHistorySessions([], history, 0).sessions).toEqual([]);
    expect(mergeHistorySessions([], history, 0).overflow.get('wa')).toBe(4);
  });

  it('archived sessions are excluded from counters and get no characters', () => {
    const sessions = [liveS('l1', 'C:\\a', 'busy'), liveS('l2', 'C:\\a', 'idle'), hist(1, 'C:\\a', 1), hist(2, 'C:\\a', 2)];
    expect(sessionPhase(sessions[2])).toBe('archived');
    const c = computeCounts({ workspaces: [], sessions });
    expect(c).toMatchObject({ sessions: 2, working: 1, idle: 1, done: 0, failed: 0, stopped: 0, archived: 2 });
    expect(summaryText(c)).toBe('1 working');
    expect(summaryText(computeCounts({ workspaces: [], sessions: [hist(1, 'C:\\a', 1)] }))).toBe('no sessions');
    expect(deriveAgents(sessions, []).map((a) => a.parentSessionId)).toEqual(['l1', 'l2']);
  });
});

describe('SessionManager with imported history', () => {
  function setup(results: AgentsResult[], config: Partial<SessionManagerConfig> = {}) {
    const timers = new FakeTimers();
    let calls = 0;
    const client = {
      listSessions: async () => results[Math.min(calls++, results.length - 1)],
      version: async () => '2.1.0',
    };
    const cfg: SessionManagerConfig = { pollIntervalSeconds: 4, demoMode: 'off', ...config };
    const registry = new WorkspaceRegistry(new MemoryMemento(), { homeDir: 'C:\\Users\\me' });
    const mgr = new SessionManager({ client, registry, events: new EventStore(500), getConfig: () => cfg, timers, now: () => 1_000_000 });
    const states: CityState[] = [];
    let events = 0;
    mgr.onDidChangeState((s) => states.push(s));
    mgr.onDidAddEvents((e) => (events += e.length));
    return { mgr, states, cfg, registry, timers, events: () => events };
  }
  const ok = (...sessions: Session[]): AgentsResult => ({ kind: 'ok', malformed: 0, sessions });

  it('merges archived rooms into workspaces (longest prefix), dedupes and creates no feed events', async () => {
    const t = setup([ok(liveS(id(1), 'C:\\repo\\a'))]);
    t.mgr.start();
    await t.mgr.firstPoll;
    await settle();
    const eventsAfterPoll = t.events();
    expect(eventsAfterPoll).toBe(1); // the live session appeared

    t.mgr.setHistorySessions([
      hist(1, 'C:\\repo\\a', 50), // same id as the live session -> live wins
      hist(2, 'C:\\repo\\a\\sub', 40), // grouped into C:\repo\a
      hist(3, 'C:\\other', 30), // new workspace
      hist(4, 'C:\\Users\\me', 20), // home: exact match only
      hist(5, 'C:\\Users\\me\\proj', 10), // not grouped under home
    ]);
    const st = t.mgr.state;
    expect(t.events()).toBe(eventsAfterPoll);
    expect(st.events.every((e) => !e.message.includes('title'))).toBe(true);
    const a = st.workspaces.find((w) => w.name === 'a')!;
    expect(a.sessionIds.sort()).toEqual([id(1), id(2)].sort());
    expect(st.sessions.find((s) => s.id === id(1))?.origin).toBeUndefined();
    expect(st.sessions.find((s) => s.id === id(2))?.origin).toBe('history');
    const names = st.workspaces.map((w) => w.name).sort();
    expect(names).toEqual(['a', 'me', 'other', 'proj']);
    expect(st.agents.map((x) => x.parentSessionId)).toEqual([id(1)]);
    expect(computeCounts(st)).toMatchObject({ sessions: 1, working: 1, archived: 4 });
  });

  it('applies the per-workspace limit as overflow and changes the fingerprint', async () => {
    const t = setup([ok(liveS(id(9), 'C:\\repo'))], { historyMaxPerWorkspace: 1 });
    t.mgr.start();
    await t.mgr.firstPoll;
    await settle();
    const before = cityFingerprint(t.mgr.state);
    t.mgr.setHistorySessions([hist(1, 'C:\\repo', 3), hist(2, 'C:\\repo', 2), hist(3, 'C:\\repo', 1)]);
    const ws = t.mgr.state.workspaces[0];
    expect(ws.sessionIds.sort()).toEqual([id(1), id(9)].sort());
    expect(ws.archivedOverflow).toBe(2);
    expect(cityFingerprint(t.mgr.state)).not.toBe(before);
    t.mgr.setHistorySessions([]);
    expect(t.mgr.state.workspaces[0].archivedOverflow).toBeUndefined();
    t.mgr.dispose();
  });

  it('does not show history in demo mode', async () => {
    const t = setup([ok()], { demoMode: 'on' });
    t.mgr.start();
    await t.mgr.firstPoll;
    await settle();
    t.mgr.setHistorySessions([hist(1, 'C:\\repo', 3)]);
    expect(t.mgr.state.source).toBe('demo');
    expect(t.mgr.state.sessions.some((s) => s.origin === 'history')).toBe(false);
    t.mgr.dispose();
  });
});

describe('basement (archive) layout', () => {
  const ws = (wsId: string, ids: string[], overflow = 0): CityWorkspace => ({
    id: wsId,
    name: wsId,
    path: `C:\\${wsId}`,
    firstSeen: 0,
    lastSeen: 0,
    source: 'session',
    pinned: false,
    open: false,
    sessionIds: ids,
    ...(overflow ? { archivedOverflow: overflow } : {}),
  });

  it('counts archived sessions on the facade: archive boxes + "+N"', () => {
    const live = [liveS('l1', 'C:\\w'), liveS('l2', 'C:\\w')];
    const archived = [1, 2, 3, 4, 5].map((n) => hist(n, 'C:\\w', n * 100));
    expect(computeFacade([...live, ...archived], { archivedOverflow: 7 })).toMatchObject({ live: 2, archived: 12, dots: 12, dotsOverflow: 0 });
    const onlyArchive = computeFacade(archived, { archivedOverflow: 20 });
    expect(onlyArchive).toMatchObject({ live: 0, archived: 25, dots: 12, dotsOverflow: 13, quiet: false, floors: 1 });
    expect(onlyArchive.windows).toEqual([]);
    expect(computeFacade([], {})).toMatchObject({ archived: 0, dots: 0, quiet: true });
  });

  it('puts archived sessions as boxes in the basement below the lobby, newest first, deterministic', () => {
    const live = [liveS('l1', 'C:\\w'), liveS('l2', 'C:\\w')].map((s) => ({ ...s, workspaceId: 'w' }));
    const archived = [1, 2, 3, 4, 5].map((n) => hist(n, 'C:\\w', n * 100, { workspaceId: 'w' }));
    const w = ws('w', [...live, ...archived].map((s) => s.id), 7);
    const a = interiorFor(w, [...live, ...archived], deriveAgents(live, []));
    const b = interiorFor({ ...w }, [...archived, ...live].reverse(), [...deriveAgents(live, [])].reverse());
    expect(b.layout).toEqual(a.layout);

    const L = a.layout;
    expect(L.basement.boxes.map((x) => x.id)).toEqual([5, 4, 3, 2, 1].map(id));
    expect(L.basement.boxes.every((x) => x.roomId === x.id)).toBe(true);
    expect(L.basement).toMatchObject({ total: 12, overflow: 7 });
    for (const box of L.basement.boxes) {
      expect(box.y).toBeGreaterThan(L.groundY);
      expect(box.y + box.height).toBeLessThanOrEqual(L.basement.y + L.basement.height);
    }
    for (const r of L.rooms) {
      expect(r.y + r.height).toBeLessThanOrEqual(L.lobby.y);
      expect(r.x).toBeGreaterThanOrEqual(L.building.x);
      expect(r.x + r.width).toBeLessThanOrEqual(L.building.x + L.building.width);
    }
    const overlaps = (p: { x: number; y: number; width: number; height: number }, q: typeof p) =>
      p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    const all = [...L.rooms, ...L.basement.boxes];
    for (let i = 0; i < all.length; i++) for (let k = i + 1; k < all.length; k++) expect(overlaps(all[i], all[k])).toBe(false);

    // a building with only archived sessions: empty offices, one box in the basement
    const v = interiorFor(ws('v', [id(9)]), [hist(9, 'C:\\v', 1, { workspaceId: 'v' })], []);
    expect(v.layout.rooms).toEqual([]);
    expect(v.layout.emptyRoom).toBeDefined();
    expect(v.layout.basement.boxes).toHaveLength(1);
  });
});

describe('archive filters', () => {
  const live = liveS('l1', 'C:\\w');
  const a1 = hist(1, 'C:\\w', 10, { workspaceId: 'w', name: 'Refactor billing module', gitBranch: 'feature/invoice' });
  const a2 = hist(2, 'C:\\w', 5, { workspaceId: 'w' });
  const input = {
    workspaces: [
      { id: 'w', name: 'w', path: 'C:\\w', firstSeen: 0, lastSeen: 0, source: 'session' as const, pinned: false, open: false, sessionIds: ['l1', id(1), id(2)], archivedOverflow: 3 },
    ],
    sessions: [{ ...live, workspaceId: 'w' }, a1, a2],
    agents: deriveAgents([live], []),
  };

  it('shows archived by default and hides them with the toggle', () => {
    const on = applyFilters(input, DEFAULT_FILTERS);
    expect(on.sessions).toHaveLength(3);
    expect(on.workspaces[0].archivedOverflow).toBe(3);
    expect(on.active).toBe(false);
    const off = applyFilters(input, { ...DEFAULT_FILTERS, tiers: ['live', 'recent'] });
    expect(off.sessions.map((s) => s.id)).toEqual(['l1']);
    expect(off.workspaces[0].archivedOverflow).toBeUndefined();
    expect(off.hiddenSessions).toBe(2);
    expect(isFilterActive({ ...DEFAULT_FILTERS, tiers: ['live', 'recent'] })).toBe(true);
  });

  it('search matches archived titles and branches; phase chips exclude archived', () => {
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'billing' }).sessions.map((s) => s.id)).toEqual([id(1)]);
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'feature/invoice' }).sessions.map((s) => s.id)).toEqual([id(1)]);
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'billing' }).workspaces[0].archivedOverflow).toBeUndefined();
    expect(applyFilters(input, { ...DEFAULT_FILTERS, phases: ['working'] }).sessions.map((s) => s.id)).toEqual(['l1']);
  });
});
