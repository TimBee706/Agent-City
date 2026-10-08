import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentsResult } from '../../src/backend/ClaudeCliClient';
import {
  ClaudeArchiveMarkerReader,
  MarkerFs,
  decodeRecord,
  parseArchivedSessionIds,
  readItemTableValue,
  readVarint,
  stateDbPathFromGlobalStorage,
} from '../../src/backend/ClaudeArchiveMarker';
import { EventStore } from '../../src/backend/EventStore';
import type { HistoricalSessionInfo } from '../../src/backend/HistoricalSessions';
import { HistoryImporter } from '../../src/backend/HistoryImporter';
import { DAY_MS, DEFAULT_RECENT_DAYS, classifyHistoryTier, toHistorySession } from '../../src/backend/historyTiers';
import { SessionManager, SessionManagerConfig } from '../../src/backend/SessionManager';
import { WorkspaceRegistry } from '../../src/backend/WorkspaceRegistry';
import {
  HISTORY_INDEX_PER_WORKSPACE,
  HISTORY_INDEX_TOTAL,
  cityFingerprint,
  deriveAgents,
  mergeHistorySessions,
} from '../../src/backend/cityStateBuilder';
import { CityState, computeCounts } from '../../src/models/CityState';
import { Session, isArchived, isHistory, isRecent, normalizeSession, sessionPhase, sessionTier } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import { DEFAULT_FILTERS, applyFilters, isFilterActive, toggleTier } from '../../src/webview/filters';
import { BI, interiorFor } from '../../src/webview/buildingInterior';
import { FakeTimers, MemoryMemento, settle } from './helpers';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const info = (n: number, cwd: string, ageMs: number, extra: Partial<HistoricalSessionInfo> = {}): HistoricalSessionInfo => ({
  sessionId: id(n),
  cwd,
  lastActivityAt: NOW - ageMs,
  title: `title ${n}`,
  ...extra,
});
const recentS = (n: number, wsId: string, ageMs = 1000): Session => ({
  ...toHistorySession(info(n, 'C:\\w', ageMs), { tier: 'recent' }),
  workspaceId: wsId,
});
const archS = (n: number, wsId: string, ageMs = 30 * DAY_MS, by: 'claude' | 'age' = 'age'): Session => ({
  ...toHistorySession(info(n, 'C:\\w', ageMs), { tier: 'archived', archivedBy: by }),
  workspaceId: wsId,
});
const liveS = (sid: string, cwd: string, raw: Record<string, unknown> = { status: 'busy' }) => normalizeSession({ sessionId: sid, cwd, ...raw })!;

// ------------------------------------------------------------------ classification
describe('history tier classification', () => {
  it('age fallback: inclusive boundary at recentDays', () => {
    const o = { now: NOW, recentDays: 7 };
    expect(classifyHistoryTier(info(1, 'C:\\a', 0), o)).toEqual({ tier: 'recent' });
    expect(classifyHistoryTier(info(1, 'C:\\a', 7 * DAY_MS), o)).toEqual({ tier: 'recent' });
    expect(classifyHistoryTier(info(1, 'C:\\a', 7 * DAY_MS + 1), o)).toEqual({ tier: 'archived', archivedBy: 'age' });
    expect(classifyHistoryTier(info(1, 'C:\\a', -5000), o).tier).toBe('recent'); // clock skew: future = recent
  });

  it('recentDays = 0 archives everything that is not running', () => {
    expect(classifyHistoryTier(info(1, 'C:\\a', 0), { now: NOW, recentDays: 0 })).toEqual({ tier: 'archived', archivedBy: 'age' });
    expect(classifyHistoryTier(info(1, 'C:\\a', 0), { now: NOW, recentDays: -3 }).tier).toBe('archived');
    // invalid -> default (14)
    expect(DEFAULT_RECENT_DAYS).toBe(14);
    expect(classifyHistoryTier(info(1, 'C:\\a', 14 * DAY_MS), { now: NOW, recentDays: Number.NaN }).tier).toBe('recent');
    expect(classifyHistoryTier(info(1, 'C:\\a', 14 * DAY_MS + 1), { now: NOW, recentDays: Number.NaN }).tier).toBe('archived');
  });

  it("Claude Code's archive marker wins over age (case-insensitive ids)", () => {
    const archivedIds = new Set([id(1)]);
    expect(classifyHistoryTier(info(1, 'C:\\a', 1000), { now: NOW, recentDays: 7, archivedIds })).toEqual({
      tier: 'archived',
      archivedBy: 'claude',
    });
    expect(classifyHistoryTier({ sessionId: id(1).toUpperCase(), lastActivityAt: NOW }, { now: NOW, recentDays: 7, archivedIds }).archivedBy).toBe('claude');
    // not in the marker: recent regardless of age (Claude Code auto-archives on its own)
    expect(classifyHistoryTier(info(2, 'C:\\a', 1000), { now: NOW, recentDays: 7, archivedIds })).toEqual({ tier: 'recent' });
    expect(classifyHistoryTier(info(2, 'C:\\a', 30 * DAY_MS), { now: NOW, recentDays: 7, archivedIds })).toEqual({ tier: 'recent' });
    expect(classifyHistoryTier(info(2, 'C:\\a', 400 * DAY_MS), { now: NOW, recentDays: 0, archivedIds })).toEqual({ tier: 'recent' });
    // available but empty marker: nothing archived
    expect(classifyHistoryTier(info(3, 'C:\\a', 400 * DAY_MS), { now: NOW, recentDays: 7, archivedIds: new Set() }).tier).toBe('recent');
  });

  it('tier helpers and phases', () => {
    const r = recentS(1, 'w');
    const a = archS(2, 'w');
    const legacy: Session = { id: 'x', kind: 'history', state: 'unknown', status: 'unknown', origin: 'history' };
    const live = liveS('l', 'C:\\w');
    expect([sessionTier(r), sessionTier(a), sessionTier(legacy), sessionTier(live)]).toEqual(['recent', 'archived', 'archived', 'live']);
    expect([sessionPhase(r), sessionPhase(a), sessionPhase(legacy)]).toEqual(['resting', 'archived', 'archived']);
    expect([isRecent(r), isArchived(r), isHistory(r), isHistory(live)]).toEqual([true, false, true, false]);
    expect(r.archivedBy).toBeUndefined();
    expect(a.archivedBy).toBe('age');
  });
});

// ------------------------------------------------------------------ archive marker (SQLite)
let sqlite: { DatabaseSync: new (file: string, opts?: unknown) => any } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require('node:sqlite');
} catch {
  sqlite = undefined;
}
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeStateDb(rows: [string, string][], pageSize = 4096): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-state-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'state.vscdb');
  const db = new sqlite!.DatabaseSync(file);
  db.exec(`PRAGMA page_size = ${pageSize}`);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  db.exec('BEGIN');
  for (const [k, v] of rows) ins.run(k, v);
  db.exec('COMMIT');
  db.close();
  return file;
}

describe('Claude Code archive marker', () => {
  it('parses the archived ids from the extension state JSON', () => {
    expect([...parseArchivedSessionIds(JSON.stringify({ hiddenSessionIds: [id(1), 'bad id!', 5, id(2).toUpperCase()] }))!]).toEqual([
      id(1),
      id(2),
    ]);
    expect(parseArchivedSessionIds(JSON.stringify({ other: true }))!.size).toBe(0); // nothing archived yet
    expect(parseArchivedSessionIds(JSON.stringify({ hiddenSessionIds: 'x' }))).toBeUndefined();
    expect(parseArchivedSessionIds('[1,2]')).toBeUndefined();
    expect(parseArchivedSessionIds('{not json')).toBeUndefined();
    expect(parseArchivedSessionIds(undefined)).toBeUndefined();
  });

  it('varints and records', () => {
    expect(readVarint(Buffer.from([0x05]), 0)).toEqual([5, 1]);
    expect(readVarint(Buffer.from([0x81, 0x00]), 0)).toEqual([128, 2]);
    // header 3 bytes: [len=3, int8, text(len 2)], values: 7, "hi"
    expect(decodeRecord(Buffer.from([3, 1, 17, 7, 0x68, 0x69]))).toEqual([7, 'hi']);
  });

  it('rejects non-SQLite data without throwing', () => {
    expect(readItemTableValue(Buffer.from('hello world'), 'x')).toBeUndefined();
    const fake = Buffer.alloc(4096);
    fake.write('SQLite format 3\u0000', 0, 'latin1');
    fake.writeUInt16BE(4096, 16);
    expect(readItemTableValue(fake, 'x')).toBeUndefined();
  });

  it.skipIf(!sqlite)('reads values from a real SQLite database (interior pages, overflow pages, any key case)', () => {
    const big = JSON.stringify({ hiddenSessionIds: Array.from({ length: 400 }, (_, i) => id(i + 1)), pad: 'x'.repeat(20_000) });
    const rows: [string, string][] = Array.from({ length: 300 }, (_, i) => [`key.${i}`, JSON.stringify({ n: i, s: 'y'.repeat(i * 3) })]);
    rows.push(['Anthropic.claude-code', big]);
    const file = makeStateDb(rows, 1024);
    const buf = fs.readFileSync(file);
    expect(readItemTableValue(buf, 'anthropic.claude-code')).toBe(big);
    expect(readItemTableValue(buf, 'key.299')).toBe(rows[299][1]);
    expect(readItemTableValue(buf, 'missing')).toBeUndefined();
    expect(parseArchivedSessionIds(readItemTableValue(buf, 'anthropic.claude-code'))!.size).toBe(400);
  });

  it.skipIf(!sqlite)('reader: available with ids, re-reads only when the file changed', async () => {
    const file = makeStateDb([['Anthropic.claude-code', JSON.stringify({ hiddenSessionIds: [id(1)] })]]);
    let reads = 0;
    const counting: MarkerFs = {
      stat: (f) => fs.promises.stat(f),
      readFile: (f) => {
        reads++;
        return fs.promises.readFile(f);
      },
    };
    const r = new ClaudeArchiveMarkerReader(file, { fs: counting });
    const m = await r.read();
    expect(m.available).toBe(true);
    expect([...m.ids]).toEqual([id(1)]);
    await r.read();
    expect(reads).toBe(1);
    const noKey = makeStateDb([['other', '{}']]);
    expect((await new ClaudeArchiveMarkerReader(noKey).read()).available).toBe(false);
    expect((await new ClaudeArchiveMarkerReader(file, { maxBytes: 10 }).read()).reason).toBe('state database too large');
  });

  it('reader: unavailable for missing paths; db path next to our global storage', async () => {
    expect((await new ClaudeArchiveMarkerReader(undefined).read()).available).toBe(false);
    expect((await new ClaudeArchiveMarkerReader(path.join(os.tmpdir(), 'nope', 'state.vscdb')).read()).available).toBe(false);
    expect(stateDbPathFromGlobalStorage(path.join('U', 'globalStorage', 'local.claude-city'))).toBe(path.join('U', 'globalStorage', 'state.vscdb'));
    expect(stateDbPathFromGlobalStorage(undefined)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ importer
describe('HistoryImporter tiers', () => {
  const stats = { projectDirs: 1, candidates: 3, scanned: 3, parsed: 3, cacheHits: 0, failures: 0, skippedNoCwd: 0, imported: 3, bytesRead: 1, durationMs: 1 };
  const infos = [info(1, 'C:\\a', 1000, { title: 'SECRET' }), info(2, 'C:\\a', 1000), info(3, 'C:\\a', 30 * DAY_MS)];
  function run(cfg: { useClaudeArchive: boolean; recentDays?: number }, marker: () => Promise<any>) {
    const received: Session[][] = [];
    const logs: string[] = [];
    const imp = new HistoryImporter({
      scanner: { scan: async () => ({ sessions: infos, stats }), persist: async () => undefined, clear: async () => undefined },
      getConfig: () => ({ enabled: true, maxAgeDays: 90, recentDays: cfg.recentDays ?? 7, useClaudeArchive: cfg.useClaudeArchive }),
      readArchiveMarker: marker,
      onSessions: (s) => received.push(s),
      log: (m) => logs.push(m),
      timers: new FakeTimers(),
      now: () => NOW,
    });
    return { imp, received, logs };
  }

  it('uses only the marker when available (no age rule) and logs counts only', async () => {
    const t = run({ useClaudeArchive: true }, async () => ({ available: true, ids: new Set([id(2)]) }));
    await t.imp.refresh();
    expect(t.received[0].map((s) => [s.id, sessionTier(s), s.archivedBy])).toEqual([
      [id(1), 'recent', undefined],
      [id(2), 'archived', 'claude'],
      [id(3), 'recent', undefined],
    ]);
    expect(t.logs.join('\n')).toMatch(/2 recent, 1 archived \(1 archived in Claude Code\)/);
    expect(t.logs.join('\n')).not.toContain('SECRET');
    t.imp.dispose();
  });

  it('falls back to age when the marker is off, unavailable or throws', async () => {
    for (const [cfg, marker] of [
      [{ useClaudeArchive: false }, async () => ({ available: true, ids: new Set([id(1)]) })],
      [{ useClaudeArchive: true }, async () => ({ available: false, ids: new Set([id(1)]), reason: 'x' })],
      [{ useClaudeArchive: true }, async () => Promise.reject(new Error('boom'))],
    ] as const) {
      const t = run(cfg, marker as () => Promise<any>);
      await t.imp.refresh();
      expect(t.received[0].map(sessionTier)).toEqual(['recent', 'recent', 'archived']);
      t.imp.dispose();
    }
    const zero = run({ useClaudeArchive: false, recentDays: 0 }, async () => undefined);
    await zero.imp.refresh();
    expect(zero.received[0].map(sessionTier)).toEqual(['archived', 'archived', 'archived']);
    zero.imp.dispose();
  });
});

// ------------------------------------------------------------------ merge, limits, payload
describe('history merge with tiers', () => {
  it('limits recent and archived rooms separately; the index lists all archived + recent overflow', () => {
    const history = [
      ...[1, 2, 3].map((n) => recentS(n, 'w', n * 1000)),
      ...[4, 5, 6, 7].map((n) => archS(n, 'w', n * DAY_MS * 10)),
    ];
    const m = mergeHistorySessions([], history, { maxRecentPerWorkspace: 2, maxArchivedPerWorkspace: 1 });
    expect(m.sessions.map((s) => s.id)).toEqual([id(1), id(2), id(4)]);
    expect(m.recentOverflow.get('w')).toBe(1);
    expect(m.overflow.get('w')).toBe(3);
    expect(m.index).toHaveLength(1);
    expect(m.index[0].total).toBe(5);
    expect(m.index[0].items.map((x) => [x.id, x.tier])).toEqual([
      [id(3), 'recent'],
      [id(4), 'archived'],
      [id(5), 'archived'],
      [id(6), 'archived'],
      [id(7), 'archived'],
    ]);
    // summaries are lightweight: no cwd / workspace / phase fields
    expect(Object.keys(m.index[0].items[1]).sort()).toEqual(['archivedBy', 'id', 'lastActivityAt', 'tier', 'title']);
  });

  it('live entries win over history - including finished ones still reported by claude agents --all', () => {
    const done = { ...liveS(id(1), 'C:\\w', { state: 'done' }), workspaceId: 'w' };
    const stopped = { ...liveS(id(2), 'C:\\w', { state: 'stopped' }), workspaceId: 'w' };
    const m = mergeHistorySessions([done, stopped], [recentS(1, 'w'), archS(2, 'w'), recentS(3, 'w')], 12);
    expect(m.sessions.map((s) => [s.id, sessionTier(s), sessionPhase(s)])).toEqual([
      [id(1), 'live', 'done'],
      [id(2), 'live', 'stopped'],
      [id(3), 'recent', 'resting'],
    ]);
    expect(m.index).toEqual([]);
    const c = computeCounts({ workspaces: [], sessions: m.sessions });
    expect(c).toMatchObject({ sessions: 2, done: 1, stopped: 1, recent: 1, archived: 0 });
    expect(deriveAgents(m.sessions, []).map((a) => a.parentSessionId)).toEqual([id(1), id(2)]); // no agents for history
  });

  it('keeps the payload bounded (per workspace and global caps, newest kept)', () => {
    const history: Session[] = [];
    let n = 1;
    for (let w = 0; w < 12; w++) for (let i = 0; i < 250; i++) history.push(archS(n++, `w${String(w).padStart(2, '0')}`, n * 1000));
    const m = mergeHistorySessions([], history, { maxRecentPerWorkspace: 20, maxArchivedPerWorkspace: 12 });
    expect(m.sessions).toHaveLength(12 * 12);
    const items = m.index.flatMap((x) => x.items);
    expect(items.length).toBe(HISTORY_INDEX_TOTAL);
    expect(m.index.every((x) => x.items.length <= HISTORY_INDEX_PER_WORKSPACE && x.total === 250)).toBe(true);
    // newest (lowest n) survive the global cap
    expect(items.some((x) => x.id === id(1))).toBe(true);
    expect(items.some((x) => x.id === id(3000))).toBe(false);
    expect(JSON.stringify(m.index).length).toBeLessThan(400_000);
  });

  it('filters: tier chips, overflow badges and activity', () => {
    const live = { ...liveS('l1', 'C:\\w'), workspaceId: 'w' };
    const ws: CityWorkspace = {
      id: 'w', name: 'w', path: 'C:\\w', firstSeen: 0, lastSeen: 0, source: 'session', pinned: false, open: false,
      sessionIds: ['l1', id(1), id(2)], archivedOverflow: 3, recentOverflow: 2,
    };
    const input = { workspaces: [ws], sessions: [live, recentS(1, 'w'), archS(2, 'w')], agents: deriveAgents([live], []) };
    const all = applyFilters(input, DEFAULT_FILTERS);
    expect(all.sessions).toHaveLength(3);
    expect(all.workspaces[0]).toMatchObject({ archivedOverflow: 3, recentOverflow: 2 });
    const onlyRecent = applyFilters(input, toggleTier(DEFAULT_FILTERS, 'recent'));
    expect(onlyRecent.sessions.map((s) => s.id)).toEqual([id(1)]);
    expect(onlyRecent.workspaces[0].archivedOverflow).toBeUndefined();
    expect(onlyRecent.workspaces[0].recentOverflow).toBe(2);
    expect(isFilterActive(toggleTier(DEFAULT_FILTERS, 'recent'))).toBe(true);
    const liveArch = toggleTier(toggleTier(DEFAULT_FILTERS, 'live'), 'archived');
    expect(liveArch.tiers).toEqual(['live', 'archived']);
    expect(applyFilters(input, liveArch).sessions.map((s) => s.id)).toEqual(['l1', id(2)]);
    expect(toggleTier(liveArch, 'recent').tiers).toEqual([]); // all three = no filter
    // phase chips match live sessions only
    expect(applyFilters(input, { ...DEFAULT_FILTERS, phases: ['idle'] }).workspaces).toEqual([]);
    expect(computeCounts({ workspaces: [ws], sessions: input.sessions })).toMatchObject({ sessions: 1, recent: 3, archived: 4 });
  });

  it('building view: recent rooms come after the live ones, archived ones go to the basement', () => {
    const live = { ...liveS('l1', 'C:\\w'), workspaceId: 'w' };
    const ws: CityWorkspace = {
      id: 'w', name: 'w', path: 'C:\\w', firstSeen: 0, lastSeen: 0, source: 'session', pinned: false, open: false,
      sessionIds: ['l1', id(1), id(2), id(3)],
    };
    const { layout } = interiorFor(ws, [live, recentS(1, 'w', 5000), recentS(2, 'w', 1000), archS(3, 'w')], deriveAgents([live], []));
    expect(layout.rooms.map((r) => r.sessionId)).toEqual(['l1', id(2), id(1)]);
    expect(layout.rooms.map((r) => r.tier)).toEqual(['live', 'recent', 'recent']);
    expect(layout.rooms.every((r) => r.width === BI.ROOM_W && r.height === BI.ROOM_H)).toBe(true);
    expect(layout.rooms.find((r) => r.sessionId === id(1))!.desks).toEqual([]); // no agents: the sleeping character is drawn by the room
    expect(layout.basement.boxes.map((b) => [b.id, b.roomId])).toEqual([[id(3), id(3)]]);
  });
});

// ------------------------------------------------------------------ Wado / Wardow regression
describe('regression: "Wado" - non-running sessions all archived and grouped into a duplicate building', () => {
  /**
   * Reproduces the reported setup (synthetic ids/titles): root `C:\VSO` imported, project folder
   * `C:\VSO\Wardow`, Claude Code started in `c:\VSO\Wardow\Wardow` (lower-case drive, also some
   * subfolder cwds). 19 transcripts within 3 days, 9 of them archived in Claude Code.
   * Before: discovery re-registered `c:\VSO\Wardow\Wardow` as its own "Wardow" building, every
   * transcript became "archived" (12 rooms that were not even drawn + "+7 archived").
   */
  function setup() {
    const timers = new FakeTimers();
    const registry = new WorkspaceRegistry(new MemoryMemento(), { homeDir: 'C:\\Users\\me', now: () => NOW });
    registry.syncRoot('c:\\VSO', ['c:\\VSO\\Wardow', 'c:\\VSO\\Kisker']);
    const client = { listSessions: async (): Promise<AgentsResult> => ({ kind: 'ok', malformed: 0, sessions: [] }), version: async () => '2.1.0' };
    const cfg: SessionManagerConfig = { pollIntervalSeconds: 4, demoMode: 'off' };
    const mgr = new SessionManager({ client, registry, events: new EventStore(500), getConfig: () => cfg, timers, now: () => NOW });
    return { registry, mgr };
  }
  const cwds = ['c:\\VSO\\Wardow\\Wardow', 'C:\\VSO\\Wardow\\Wardow', 'C:\\VSO\\Wardow\\Wardow\\docs'];
  const infos = Array.from({ length: 19 }, (_, i) => info(i + 1, cwds[i % 3], (i + 1) * 3 * 3_600_000));
  const hidden = new Set(infos.filter((_, i) => i % 2 === 0 && i < 18).map((x) => x.sessionId)); // 9 archived in Claude Code

  it('discovery no longer creates a duplicate building below an imported one; stale duplicates are absorbed', () => {
    const { registry } = setup();
    registry.setHistoricalProjects(['c:\\VSO\\Wardow\\Wardow']);
    expect(registry.all().map((w) => w.path)).toEqual(expect.not.arrayContaining(['c:\\VSO\\Wardow\\Wardow']));
    // a stale entry from an older version (created before the import fix) is absorbed on the next rescan
    registry.register('c:\\VSO\\Wardow\\Wardow', 'history');
    expect(registry.findForPath('c:\\VSO\\Wardow\\Wardow')!.path).toBe('c:\\VSO\\Wardow\\Wardow');
    const res = registry.syncRoot('c:\\VSO', ['c:\\VSO\\Wardow', 'c:\\VSO\\Kisker']);
    expect(res.changed).toBe(1);
    expect(registry.findForPath('C:\\VSO\\Wardow\\Wardow\\docs')!.path).toBe('c:\\VSO\\Wardow');
    // pinned / open children are kept
    registry.register('c:\\VSO\\Kisker\\sub', 'history');
    registry.setPinned(registry.findByPath('c:\\VSO\\Kisker\\sub')!.id, true);
    registry.syncRoot('c:\\VSO', ['c:\\VSO\\Wardow', 'c:\\VSO\\Kisker']);
    expect(registry.findByPath('c:\\VSO\\Kisker\\sub')).toBeDefined();
  });

  it('shows 10 recent rooms and 9 archived rooms in the one Wardow building', async () => {
    const { registry, mgr } = setup();
    registry.setHistoricalProjects(['c:\\VSO\\Wardow\\Wardow']);
    mgr.start();
    await mgr.firstPoll;
    await settle();
    mgr.setHistorySessions(infos.map((x) => toHistorySession(x, classifyHistoryTier(x, { now: NOW, recentDays: 7, archivedIds: hidden }))));
    const st: CityState = mgr.state;
    const wardow = st.workspaces.filter((w) => w.name === 'Wardow');
    expect(wardow).toHaveLength(1);
    expect(wardow[0].path).toBe('c:\\VSO\\Wardow');
    const sessions = st.sessions.filter((s) => s.workspaceId === wardow[0].id);
    expect(sessions.filter(isRecent)).toHaveLength(10);
    expect(sessions.filter(isArchived)).toHaveLength(9);
    expect(sessions.filter(isArchived).every((s) => s.archivedBy === 'claude')).toBe(true);
    expect(wardow[0].archivedOverflow).toBeUndefined();
    expect(computeCounts(st)).toMatchObject({ sessions: 0, recent: 10, archived: 9 });
    expect(st.historyIndex!.find((x) => x.workspaceId === wardow[0].id)!.total).toBe(9);
    expect(st.agents).toEqual([]);

    // every session is drawn: 10 lit windows / rooms and 9 archive boxes (facade dots and basement)
    const wsHistory = st.historyIndex!.find((x) => x.workspaceId === wardow[0].id)!.items;
    const { layout, facade } = interiorFor(wardow[0], sessions, st.agents, wsHistory);
    expect(facade.windows).toHaveLength(10);
    expect(facade).toMatchObject({ recent: 10, archived: 9, dots: 9, dotsOverflow: 0 });
    expect(layout.rooms).toHaveLength(10);
    expect(layout.basement.boxes).toHaveLength(9);

    // the fingerprint reacts to tier changes (e.g. user archives a session in Claude Code)
    const fp = cityFingerprint(st);
    const more = new Set([...hidden, infos[1].sessionId]);
    mgr.setHistorySessions(infos.map((x) => toHistorySession(x, classifyHistoryTier(x, { now: NOW, recentDays: 7, archivedIds: more }))));
    expect(cityFingerprint(mgr.state)).not.toBe(fp);
    expect(computeCounts(mgr.state)).toMatchObject({ recent: 9, archived: 10 });
    mgr.dispose();
  });
});
