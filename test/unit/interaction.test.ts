import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../src/models/Session';
import type { Agent } from '../../src/models/Agent';
import type { CityWorkspace } from '../../src/models/Workspace';
import { parseWebviewMessage } from '../../src/shared/protocol';
import { buildOpenSessionUri, isValidSessionId, isValidUriScheme } from '../../src/shared/sessionLinks';
import { DEFAULT_FILTERS, applyFilters, isFilterActive, sanitizeFilters, togglePhase } from '../../src/webview/filters';
import {
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  clampPan,
  clampZoom,
  fitContent,
  fitRect,
  isValidTransform,
  panBy,
  screenToWorld,
  transformAttr,
  wheelFactor,
  zoomAt,
} from '../../src/webview/zoom';

describe('session links', () => {
  it('validates session ids', () => {
    expect(isValidSessionId('3f2a9c1e-1111-4222-8333-444455556666')).toBe(true);
    expect(isValidSessionId('abc_DEF-1')).toBe(true);
    for (const bad of ['', 'a b', 'a/b', 'a?b', 'a&session=x', '../x', 'x'.repeat(129), 5, null, undefined]) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });
  it('builds the documented URI and rejects bad input', () => {
    expect(buildOpenSessionUri('abc-123')).toBe('vscode://anthropic.claude-code/open?session=abc-123');
    expect(buildOpenSessionUri('abc-123', 'vscode-insiders')).toBe('vscode-insiders://anthropic.claude-code/open?session=abc-123');
    expect(buildOpenSessionUri('a&prompt=rm', 'vscode')).toBeUndefined();
    expect(buildOpenSessionUri('abc', 'javascript:alert(1)//')).toBeUndefined();
    expect(isValidUriScheme('Vscode')).toBe(false);
  });
});

describe('protocol - phase 4 messages', () => {
  it('accepts valid messages, strips extras and coerces newWindow', () => {
    expect(parseWebviewMessage({ type: 'openSession', sessionId: 'abc-1', x: 1 })).toEqual({ type: 'openSession', sessionId: 'abc-1' });
    expect(parseWebviewMessage({ type: 'copySessionId', sessionId: 'abc-1' })).toEqual({ type: 'copySessionId', sessionId: 'abc-1' });
    expect(parseWebviewMessage({ type: 'openWorkspace', workspaceId: 'w1', newWindow: 'yes' })).toEqual({
      type: 'openWorkspace',
      workspaceId: 'w1',
      newWindow: false,
    });
    expect(parseWebviewMessage({ type: 'openWorkspace', workspaceId: 'w1', newWindow: true })).toMatchObject({ newWindow: true });
    expect(parseWebviewMessage({ type: 'installHooks', path: '/etc' })).toEqual({ type: 'installHooks' });
    expect(parseWebviewMessage({ type: 'uninstallHooks' })).toEqual({ type: 'uninstallHooks' });
  });
  it('rejects invalid session ids and workspace ids', () => {
    for (const bad of [
      { type: 'openSession' },
      { type: 'openSession', sessionId: 'a b' },
      { type: 'openSession', sessionId: 'x&prompt=y' },
      { type: 'copySessionId', sessionId: 42 },
      { type: 'openWorkspace', workspaceId: '' },
      { type: 'openWorkspace', path: 'C:\\' },
    ]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
  });
});

describe('zoom math', () => {
  it('zoomAt keeps the point under the cursor fixed and clamps', () => {
    const t = zoomAt(IDENTITY, 2, 100, 50);
    expect(t.k).toBe(2);
    const w = screenToWorld(t, 100, 50);
    expect(w.x).toBeCloseTo(100);
    expect(w.y).toBeCloseTo(50);
    expect(zoomAt({ k: 3, x: 0, y: 0 }, 10, 0, 0).k).toBe(MAX_ZOOM);
    expect(zoomAt({ k: 0.3, x: 0, y: 0 }, 0.01, 0, 0).k).toBe(MIN_ZOOM);
    expect(zoomAt(IDENTITY, NaN, 0, 0)).toEqual(IDENTITY);
    expect(clampZoom(Infinity)).toBe(1);
  });
  it('zoom in then out around the same point returns to the start', () => {
    const start = { k: 1.2, x: -40, y: 30 };
    const back = zoomAt(zoomAt(start, 1.25, 300, 200), 1 / 1.25, 300, 200);
    expect(back.k).toBeCloseTo(start.k);
    expect(back.x).toBeCloseTo(start.x);
    expect(back.y).toBeCloseTo(start.y);
  });
  it('panBy, wheelFactor', () => {
    expect(panBy(IDENTITY, 10, -5)).toEqual({ k: 1, x: 10, y: -5 });
    expect(panBy(IDENTITY, NaN, 1)).toEqual({ k: 1, x: 0, y: 1 });
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1);
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48, 0));
    expect(wheelFactor(1e9)).toBeCloseTo(wheelFactor(300));
  });
  it('fitContent / fitRect center the content and cap the zoom', () => {
    const f = fitContent({ width: 2000, height: 500 }, { width: 1000, height: 600 }, 0);
    expect(f.k).toBeCloseTo(0.5);
    expect(f.x).toBeCloseTo(0);
    expect(f.y).toBeCloseTo((600 - 250) / 2);
    expect(fitContent({ width: 100, height: 100 }, { width: 1000, height: 1000 }).k).toBe(1);
    const r = fitRect({ x: 100, y: 100, width: 100, height: 50 }, { width: 400, height: 400 }, 0, 2);
    expect(r.k).toBe(2);
    const center = screenToWorld(r, 200, 200);
    expect(center.x).toBeCloseTo(150);
    expect(center.y).toBeCloseTo(125);
  });
  it('clampPan keeps part of the content visible', () => {
    const c = clampPan({ k: 1, x: -5000, y: 5000 }, { width: 1000, height: 800 }, { width: 500, height: 400 }, 60);
    expect(c.x).toBe(60 - 1000);
    expect(c.y).toBe(400 - 60);
  });
  it('transformAttr and persisted state validation', () => {
    expect(transformAttr({ k: 1.23456, x: 1.006, y: -2 })).toBe('translate(1.01 -2) scale(1.2346)');
    expect(isValidTransform({ k: 1, x: 0, y: 0 })).toBe(true);
    for (const bad of [null, {}, { k: 99, x: 0, y: 0 }, { k: 1, x: 'a', y: 0 }, { k: 1, x: NaN, y: 0 }, { k: 1, x: 1e9, y: 0 }]) {
      expect(isValidTransform(bad)).toBe(false);
    }
  });
});

describe('filters', () => {
  const s = (id: string, status: string, cwd: string, name?: string, state?: string) =>
    ({ ...normalizeSession({ sessionId: id, status, cwd, name, state })!, workspaceId: cwd.includes('alpha') ? 'wa' : 'wb' });
  const sessions = [
    s('s1', 'busy', 'C:\\alpha', 'refactor-auth'),
    s('s2', 'idle', 'C:\\alpha', 'docs'),
    s('s3', 'waiting', 'C:\\beta', 'db-migration'),
    s('s4', 'idle', 'C:\\beta', 'old', 'failed'),
  ];
  const ws = (id: string, name: string, ids: string[]): CityWorkspace => ({
    id, name, path: `C:\\${name}`, firstSeen: 0, lastSeen: 0, source: 'session', pinned: false, open: false, sessionIds: ids,
  });
  const workspaces = [ws('wa', 'alpha', ['s1', 's2']), ws('wb', 'beta', ['s3', 's4']), ws('wc', 'gamma', [])];
  const agents: Agent[] = [
    { agentId: 's1:main', agentType: 'main', role: 'main', parentSessionId: 's1', name: 'refactor-auth', characterState: 'busy' },
    { agentId: 's1:a1', agentType: 'Explore', role: 'subagent', parentSessionId: 's1', name: 'Explore', characterState: 'working', task: 'scan repo' },
  ];
  const input = { workspaces, sessions, agents };

  it('defaults show everything', () => {
    const r = applyFilters(input, DEFAULT_FILTERS);
    expect(r.workspaces.map((w) => w.id)).toEqual(['wa', 'wb', 'wc']);
    expect(r.sessions).toHaveLength(4);
    expect(r.active).toBe(false);
    expect(r.hiddenWorkspaces).toBe(0);
  });
  it('search matches company names (keeps all its sessions)', () => {
    const r = applyFilters(input, { ...DEFAULT_FILTERS, query: 'ALPHA' });
    expect(r.workspaces.map((w) => w.id)).toEqual(['wa']);
    expect(r.sessions.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(r.hiddenWorkspaces).toBe(2);
  });
  it('search matches session names, agent types/tasks and paths', () => {
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'migration' }).sessions.map((x) => x.id)).toEqual(['s3']);
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'explore' }).sessions.map((x) => x.id)).toEqual(['s1']);
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'scan repo' }).sessions.map((x) => x.id)).toEqual(['s1']);
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'c:\\beta' }).workspaces.map((w) => w.id)).toEqual(['wb']);
    expect(applyFilters(input, { ...DEFAULT_FILTERS, query: 'nothing-matches' }).workspaces).toEqual([]);
  });
  it('phase filters and workspace sessionIds are filtered consistently', () => {
    const r = applyFilters(input, { ...DEFAULT_FILTERS, phases: ['waiting', 'failed'] });
    expect(r.sessions.map((x) => x.id)).toEqual(['s3', 's4']);
    expect(r.workspaces.map((w) => [w.id, w.sessionIds])).toEqual([['wb', ['s3', 's4']]]);
    expect(r.agents).toEqual([]);
    expect(r.hiddenSessions).toBe(2);
  });
  it('hideInactive and onlyWithSessions', () => {
    expect(applyFilters(input, { ...DEFAULT_FILTERS, onlyWithSessions: true }).workspaces.map((w) => w.id)).toEqual(['wa', 'wb']);
    const r = applyFilters(
      { ...input, sessions: sessions.map((x) => (x.id === 's3' ? { ...x, status: 'idle' as const } : x)) },
      { ...DEFAULT_FILTERS, hideInactive: true },
    );
    expect(r.workspaces.map((w) => w.id)).toEqual(['wa']);
  });
  it('sanitize / toggle / active', () => {
    expect(sanitizeFilters({ query: 5, phases: ['working', 'bogus', 'working'], hideInactive: 'true' })).toEqual({
      query: '',
      phases: ['working'],
      hideInactive: false,
      onlyWithSessions: false,
      tiers: [],
    });
    // legacy v2 toggle -> tier filter
    expect(sanitizeFilters({ showArchived: false }).tiers).toEqual(['live', 'recent']);
    expect(sanitizeFilters({ showArchived: 'no' }).tiers).toEqual([]);
    expect(sanitizeFilters({ tiers: ['archived', 'bogus', 'live'] }).tiers).toEqual(['live', 'archived']);
    expect(sanitizeFilters({ tiers: ['archived', 'recent', 'live'] }).tiers).toEqual([]); // all = none
    expect(sanitizeFilters(null)).toEqual(DEFAULT_FILTERS);
    const f = togglePhase(DEFAULT_FILTERS, 'idle');
    expect(f.phases).toEqual(['idle']);
    expect(togglePhase(f, 'idle').phases).toEqual([]);
    expect(isFilterActive(f)).toBe(true);
    expect(isFilterActive({ ...DEFAULT_FILTERS, query: '   ' })).toBe(false);
  });
});
