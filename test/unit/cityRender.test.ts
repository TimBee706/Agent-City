import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../src/models/Agent';
import type { HistorySummary } from '../../src/models/CityState';
import { Session, normalizeSession } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import { BuildingView } from '../../src/webview/BuildingView';
import { CityMap, LOD_FAR, LOD_TINY, lodClasses } from '../../src/webview/CityMap';
import { carKeyframes, computeCityGrid } from '../../src/webview/cityLayout';
import { ToyCars } from '../../src/webview/ToyCars';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8);
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;

/** History session as produced by toHistorySession (kept local: this test is type-checked with the webview config). */
function hist(n: number, tier: 'recent' | 'archived', wsId = 'w'): Session {
  const s: Session = {
    id: id(n), sessionId: id(n), cwd: 'C:\\w', kind: 'history', state: 'unknown', status: 'unknown',
    origin: 'history', tier, lastActivityAt: NOW - n * DAY, name: `Task ${n}`, workspaceId: wsId,
  };
  if (tier === 'archived') s.archivedBy = 'claude';
  return s;
}

function fixture() {
  const live = [
    { ...normalizeSession({ sessionId: 'l1', cwd: 'C:\\w', status: 'busy', name: 'refactor-auth' })!, workspaceId: 'w' },
    { ...normalizeSession({ sessionId: 'l2', cwd: 'C:\\w', status: 'waiting', name: 'db-migration' })!, workspaceId: 'w' },
  ];
  const recent = [hist(1, 'recent'), hist(2, 'recent')];
  const archived = [3, 4, 5, 6, 7, 8, 9].map((n) => hist(n, 'archived'));
  const sessions = [...live, ...recent, ...archived];
  const ws: CityWorkspace = {
    id: 'w', name: 'Wardow', path: 'C:\\w', firstSeen: 0, lastSeen: 0, source: 'imported', pinned: true, open: true,
    sessionIds: sessions.map((s) => s.id), archivedOverflow: 2,
  };
  const empty: CityWorkspace = {
    id: 'e', name: 'empty-project', path: 'C:\\e', firstSeen: 0, lastSeen: 0, source: 'imported', pinned: true, open: false, sessionIds: [],
  };
  const gone: CityWorkspace = { ...empty, id: 'g', name: 'gone', missing: true };
  const history: HistorySummary[] = [
    ...archived.map((s) => ({ id: s.sessionId!, title: s.name, lastActivityAt: s.lastActivityAt!, tier: 'archived' as const, archivedBy: 'claude' as const })),
    { id: id(20), title: 'Only in the index', lastActivityAt: NOW - 30 * DAY, tier: 'archived' },
    { id: id(21), title: 'Second index entry', lastActivityAt: NOW - 31 * DAY, tier: 'archived' },
  ];
  return { live, sessions, workspaces: [ws, empty, gone], history };
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('city map rendering (level 1)', () => {
  it('draws every building with lit windows and the archived sessions as basement boxes - visible without clicking', () => {
    const f = fixture();
    const html = renderToStaticMarkup(
      createElement(CityMap, {
        workspaces: f.workspaces,
        sessions: f.sessions,
        agents: [],
        selection: undefined,
        onSelect: () => undefined,
        onOpen: () => undefined,
        initialTransform: undefined,
        onTransformChange: () => undefined,
        focusRequest: undefined,
        active: true,
        empty: null,
      }),
    );
    for (const w of f.workspaces) expect(html).toContain(`data-workspace-id="${w.id}"`);
    // 7 archived rooms + 2 overflow = 9 archive boxes in the basement strip, no "+N" (fits 12)
    expect(count(html, /class="arch-box"/g)).toBe(9);
    expect(html).not.toContain('class="arch-more"');
    // windows: 2 live (working + waiting) + 2 recent (resting); shutters on the two buildings without sessions
    expect(count(html, /win win--working/g)).toBe(1);
    expect(count(html, /win win--waiting/g)).toBe(1);
    expect(count(html, /win win--resting/g)).toBe(2);
    expect(count(html, /win win--shut/g)).toBe(8); // empty + missing building
    // accessible summary incl. tiers, waiting "!" sign over the door, construction site for the missing folder
    expect(html).toContain('Wardow (open in VS Code): 2 live sessions, 1 working, 1 waiting for input, 2 recent, 9 archived in the basement');
    expect(html).toContain('door-alert');
    expect(html).toContain('bld--missing');
    expect(html).toContain('class="construction"');
    // name plates, decorations, roads and toy cars (one focusable taxi)
    expect(html).toContain('>Wardow</text>');
    expect(html).toContain('class="road"');
    expect(html).toMatch(/deco deco-tree-(round|cone)/);
    expect(count(html, /class="toy-car( toy-car--taxi)?"/g)).toBe(computeCityGrid(3).cars.length);
    expect(count(html, /aria-label="Taxi: drive to the next building that needs your attention"/g)).toBe(1);
    // CSP: no inline styles anywhere
    expect(html).not.toMatch(/style=/);
  });

  it('archive overflow beyond 12 boxes shows "+N"', () => {
    const f = fixture();
    const ws = { ...f.workspaces[0], archivedOverflow: 30 };
    const html = renderToStaticMarkup(
      createElement(CityMap, {
        workspaces: [ws],
        sessions: f.sessions,
        agents: [],
        selection: { kind: 'workspace', id: 'w' },
        onSelect: () => undefined,
        onOpen: () => undefined,
        initialTransform: undefined,
        onTransformChange: () => undefined,
        focusRequest: undefined,
        active: true,
        empty: null,
      }),
    );
    expect(count(html, /class="arch-box"/g)).toBe(12);
    expect(html).toMatch(/class="arch-more"[^>]*>\+25<\/text>/); // 7 rooms + 30 overflow = 37 -> 12 boxes + 25
    expect(html).toContain('is-selected');
  });

  it('level of detail thresholds', () => {
    expect(lodClasses(1)).toEqual({ far: false, tiny: false });
    expect(lodClasses(LOD_FAR - 0.01)).toEqual({ far: true, tiny: false });
    expect(lodClasses(LOD_TINY - 0.01)).toEqual({ far: true, tiny: true });
  });
});

describe('building view rendering (level 2)', () => {
  it('shows rooms for live + recent sessions, characters, and one box per archived session in the basement', () => {
    const f = fixture();
    const agents: Agent[] = f.live.map((s) => ({
      agentId: `${s.id}:main`, agentType: 'main', role: 'main', parentSessionId: s.id, name: s.name!, workspaceId: 'w',
      characterState: s.status === 'busy' ? 'busy' : 'blocked',
    }));
    const html = renderToStaticMarkup(
      createElement(BuildingView, {
        workspace: f.workspaces[0],
        sessions: f.sessions,
        agents,
        history: f.history,
        selection: undefined,
        onSelect: () => undefined,
        onBack: () => undefined,
        sparkles: new Set<string>(),
        initialTransform: undefined,
        onTransformChange: () => undefined,
        focusRequest: undefined,
      }),
    );
    // breadcrumb + back
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('Back to city');
    // rooms: waiting first, then working, then the two recent ones (sleeping)
    const order = [...html.matchAll(/class="iroom iroom--(\w+)[^"]*" data-session-id="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(order).toEqual(['waiting:l2', 'working:l1', `resting:${id(1)}`, `resting:${id(2)}`]);
    expect(count(html, /class="resting-z"/g)).toBe(2);
    expect(count(html, /class="char char--/g)).toBe(2);
    expect(html).toContain('char--blocked'); // raised hand + "!"
    // basement: 7 archived rooms + 2 sessions only known from the index = 9 boxes, newest first
    expect(count(html, /class="abox"/g)).toBe(9);
    expect(html).toContain('Basement · 9 archived sessions');
    expect(html).toContain(`data-archive-id="${id(20)}"`);
    expect(html).toContain('aria-label="Archived session Only in the index. Open Session resumes it"');
    expect(html).not.toMatch(/style=/);
  });

  it('an empty building: empty offices and an empty basement', () => {
    const f = fixture();
    const html = renderToStaticMarkup(
      createElement(BuildingView, {
        workspace: f.workspaces[1],
        sessions: [],
        agents: [],
        history: undefined,
        selection: undefined,
        onSelect: () => undefined,
        onBack: () => undefined,
        sparkles: new Set<string>(),
        initialTransform: undefined,
        onTransformChange: () => undefined,
        focusRequest: undefined,
      }),
    );
    expect(html).toContain('the offices are empty');
    expect(html).toContain('The basement is empty');
    expect(count(html, /class="abox"/g)).toBe(0);
  });
});

describe('reduced motion', () => {
  const cars = computeCityGrid(10).cars;
  const render = () => renderToStaticMarkup(createElement('svg', null, createElement(ToyCars, { cars, running: true, onTaxi: () => undefined })));

  it('parks the toy cars when VS Code asks for reduced motion (body.vscode-reduce-motion)', () => {
    expect(render()).toContain('class="toy-cars"');
    (globalThis as { document?: unknown }).document = { body: { classList: { contains: (c: string) => c === 'vscode-reduce-motion' } } };
    const html = render();
    expect(html).toContain('class="toy-cars is-parked"');
    // parked cars still have a static position (SVG attribute, not a style)
    expect(html).toMatch(/class="toy-car[^"]*" transform="translate\(/);
  });

  it('stylesheets switch off CSS animations and transitions for both reduced-motion signals', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\*,/);
    expect(css).toMatch(/body\.vscode-reduce-motion \*,/);
    for (const f of ['city.css', 'building.css', 'styles.css']) {
      expect(fs.readFileSync(path.join(__dirname, '../../src/webview', f), 'utf8')).not.toMatch(/@import|url\(\s*['"]?(https?|data):/);
    }
  });

  it('car keyframes: one lap, monotonic offsets, orientation flips at the corners', () => {
    const k = carKeyframes(cars[0]);
    expect(k.move[0].offset).toBe(0);
    expect(k.move[k.move.length - 1].offset).toBe(1);
    expect(k.move[0].transform).toBe(k.move[k.move.length - 1].transform);
    for (const list of [k.move, k.orient]) for (let i = 1; i < list.length; i++) expect(list[i].offset).toBeGreaterThanOrEqual(list[i - 1].offset);
    expect(new Set(k.orient.map((f) => f.transform))).toEqual(new Set(['scale(1, 1)', 'scale(-1, 1)']));
  });
});
