import { describe, expect, it } from 'vitest';
import { normalizeSession, Session } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import { parseExtensionMessage, parseWebviewMessage } from '../../src/shared/protocol';
import { DEFAULT_FILTERS, applyFilters } from '../../src/webview/filters';
import { computeCityLayout } from '../../src/webview/cityLayout';
import { orderWorkspaces } from '../../src/webview/layout';
import { UI_STATE_VERSION, migrateUiState } from '../../src/webview/uiState';

describe('protocol: workspace management messages', () => {
  it('accepts the new messages with ids only and strips extra fields (never paths)', () => {
    expect(parseWebviewMessage({ type: 'importWorkspaces', path: 'C:\\evil' })).toEqual({ type: 'importWorkspaces' });
    expect(parseWebviewMessage({ type: 'removeWorkspace', workspaceId: 'w1', path: 'C:\\x' })).toEqual({
      type: 'removeWorkspace',
      workspaceId: 'w1',
    });
    expect(parseWebviewMessage({ type: 'setWorkspacePinned', workspaceId: 'w1', pinned: false })).toEqual({
      type: 'setWorkspacePinned',
      workspaceId: 'w1',
      pinned: false,
    });
  });

  it('rejects malformed workspace messages', () => {
    for (const bad of [
      { type: 'removeWorkspace' },
      { type: 'removeWorkspace', workspaceId: '' },
      { type: 'removeWorkspace', workspaceId: 7 },
      { type: 'removeWorkspace', workspaceId: 'x'.repeat(201) },
      { type: 'setWorkspacePinned', workspaceId: 'w' },
      { type: 'setWorkspacePinned', workspaceId: 'w', pinned: 'yes' },
      { type: 'importWorkspacesFromFolder' },
      { type: 'addWorkspaceRoot', path: 'C:\\' },
    ]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
  });

  it('fitCity is a valid extension message', () => {
    expect(parseExtensionMessage({ type: 'fitCity', extra: 1 })).toEqual({ type: 'fitCity' });
  });
});

function ws(i: number, sessionIds: string[] = []): CityWorkspace {
  const id = `w${String(i).padStart(3, '0')}`;
  return { id, name: `project-${String((i * 37) % 150).padStart(3, '0')}`, path: `C:\\Repos\\${id}`, firstSeen: 0, lastSeen: 0, source: 'imported', pinned: true, open: false, sessionIds };
}

function bigCity(n: number): { workspaces: CityWorkspace[]; sessions: Session[] } {
  const workspaces: CityWorkspace[] = [];
  const sessions: Session[] = [];
  for (let i = 0; i < n; i++) {
    const ids: string[] = [];
    if (i % 10 === 0) {
      const s = { ...normalizeSession({ sessionId: `s${i}`, cwd: `C:\\Repos\\w${i}`, status: i % 20 === 0 ? 'busy' : 'idle', startedAt: 1_000 + i })!, workspaceId: `w${i}` };
      sessions.push(s);
      ids.push(s.id);
    }
    workspaces.push(ws(i, ids));
  }
  return { workspaces, sessions };
}

describe('layout at scale', () => {
  it('orders buildings: active first, then last activity desc, then name', () => {
    const sessions = new Map(
      [
        { id: 'busy', status: 'busy' as const, startedAt: 1 },
        { id: 'waiting', state: 'blocked' as const, startedAt: 2 },
        { id: 'recent', status: 'idle' as const, startedAt: 500 },
        { id: 'old', status: 'idle' as const, startedAt: 10 },
        { id: 'arch', origin: 'history' as const, lastActivityAt: 900 },
      ].map((s) => [s.id, s]),
    );
    const list = [
      { id: 'a', name: 'zzz-empty', sessionIds: [] },
      { id: 'b', name: 'aaa-empty', sessionIds: [] },
      { id: 'c', name: 'old', sessionIds: ['old'] },
      { id: 'd', name: 'recent', sessionIds: ['recent'] },
      { id: 'e', name: 'archive-only', sessionIds: ['arch'] },
      { id: 'f', name: 'working', sessionIds: ['busy'] },
      { id: 'g', name: 'waiting', sessionIds: ['waiting'] },
    ];
    expect(orderWorkspaces(list, sessions).map((w) => w.id)).toEqual(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
  });

  it('150 buildings: deterministic, one plot each, important ones first and fast', () => {
    const { workspaces, sessions } = bigCity(150);
    const input = { workspaces, sessions };
    computeCityLayout(input); // warm-up (JIT)
    const t0 = performance.now();
    const a = computeCityLayout(input);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(80);
    expect(a.buildings).toHaveLength(150);
    const b = computeCityLayout({ workspaces: [...workspaces].reverse(), sessions: [...sessions].reverse() });
    expect(b).toEqual(a);
    // busy workspaces first (newest start first), then idle ones with sessions, then the rest
    const pad = (i: number) => `w${String(i).padStart(3, '0')}`;
    expect(a.buildings.slice(0, 8).map((x) => x.workspaceId)).toEqual([140, 120, 100, 80, 60, 40, 20, 0].map(pad));
    expect(a.buildings.slice(8, 15).map((x) => x.workspaceId)).toEqual([130, 110, 90, 70, 50, 30, 10].map(pad));
    expect(new Set(a.buildings.map((x) => x.cell)).size).toBe(150);
    // the city is a roughly square grid (a 2:1 diamond on screen)
    expect(Math.abs(a.grid.cols - a.grid.rows)).toBeLessThanOrEqual(1);
    // filters do not hide buildings without sessions by default
    expect(applyFilters({ workspaces, sessions, agents: [] }, DEFAULT_FILTERS).workspaces).toHaveLength(150);
  });
});

describe('UI state migration', () => {
  it('defaults: filters off', () => {
    expect(DEFAULT_FILTERS.hideInactive).toBe(false);
    expect(DEFAULT_FILTERS.onlyWithSessions).toBe(false);
    expect(migrateUiState(undefined)).toEqual({ v: UI_STATE_VERSION, filters: DEFAULT_FILTERS, selection: undefined, nav: { level: 'city' } });
  });

  it('resets the hiding filters and the zoom once for states from older versions', () => {
    const old = {
      filters: { query: 'api', phases: ['working'], hideInactive: true, onlyWithSessions: true, showArchived: false },
      zoom: { k: 2, x: 10, y: 10 },
      selection: { kind: 'workspace', id: 'w1' },
    };
    const m = migrateUiState(old);
    expect(m.v).toBe(UI_STATE_VERSION);
    expect(m.filters).toEqual({ query: 'api', phases: ['working'], hideInactive: false, onlyWithSessions: false, tiers: ['live', 'recent'] });
    expect(m.zoom).toBeUndefined();
    expect(m.selection).toEqual({ kind: 'workspace', id: 'w1' });
  });

  it('migrates v2 (showArchived toggle) to tiers, keeping the other filters', () => {
    const v2 = {
      v: 2,
      filters: { query: 'x', phases: [], hideInactive: true, onlyWithSessions: false, showArchived: false },
      zoom: { k: 2, x: 10, y: 10 },
    };
    const m = migrateUiState(v2);
    expect(m.v).toBe(UI_STATE_VERSION);
    expect(m.filters).toEqual({ query: 'x', phases: [], hideInactive: true, onlyWithSessions: false, tiers: ['live', 'recent'] });
    const shown = migrateUiState({ ...v2, filters: { ...v2.filters, showArchived: true } });
    expect(shown.filters!.tiers).toEqual([]);
    // unknown future version: sanitized filters, no zoom
    expect(migrateUiState({ ...v2, v: 99 }).zoom).toBeUndefined();
  });

  it('v3 -> v4: drops the flat-map camera once (isometric city is fitted), keeps filters + selection, starts in the city', () => {
    const v3 = {
      v: 3,
      filters: { ...DEFAULT_FILTERS, query: 'api' },
      zoom: { k: 2, x: 10, y: 10 },
      selection: { kind: 'session', id: 's1' },
      nav: { level: 'building', workspaceId: 'w1' }, // not a v3 field: ignored
    };
    const m = migrateUiState(v3);
    expect(UI_STATE_VERSION).toBe(4);
    expect(m).toEqual({ v: 4, filters: { ...DEFAULT_FILTERS, query: 'api' }, selection: { kind: 'session', id: 's1' }, nav: { level: 'city' } });
  });

  it('keeps user choices made in the current version: filters, city camera, level and building camera', () => {
    const cur = {
      v: UI_STATE_VERSION,
      filters: { ...DEFAULT_FILTERS, hideInactive: true },
      zoom: { k: 2, x: 10, y: 10 },
      nav: { level: 'building', workspaceId: 'w1' },
      buildingZoom: { workspaceId: 'w1', t: { k: 1.5, x: -20, y: 4 } },
      selection: { kind: 'history', id: 'abc-1', workspaceId: 'w1' },
    };
    const m = migrateUiState(cur);
    expect(m.filters!.hideInactive).toBe(true);
    expect(m.zoom).toEqual({ k: 2, x: 10, y: 10 });
    expect(m.nav).toEqual({ level: 'building', workspaceId: 'w1' });
    expect(m.buildingZoom).toEqual({ workspaceId: 'w1', t: { k: 1.5, x: -20, y: 4 } });
    expect(m.selection).toEqual({ kind: 'history', id: 'abc-1', workspaceId: 'w1' });
  });

  it('sanitizes navigation and building camera', () => {
    const base = { v: UI_STATE_VERSION, filters: DEFAULT_FILTERS };
    for (const nav of [null, 'building', { level: 'building' }, { level: 'building', workspaceId: '' }, { level: 'roof', workspaceId: 'w' }]) {
      expect(migrateUiState({ ...base, nav }).nav).toEqual({ level: 'city' });
    }
    expect(migrateUiState({ ...base, nav: { level: 'city', workspaceId: 'w' } }).nav).toEqual({ level: 'city' });
    for (const buildingZoom of [{}, { workspaceId: 'w' }, { workspaceId: 'w', t: { k: 99, x: 0, y: 0 } }, { workspaceId: 5, t: { k: 1, x: 0, y: 0 } }]) {
      expect(migrateUiState({ ...base, buildingZoom }).buildingZoom).toBeUndefined();
    }
    expect(migrateUiState({ ...base, selection: { kind: 'history', id: 'x' } }).selection).toBeUndefined(); // workspace missing
  });
});
