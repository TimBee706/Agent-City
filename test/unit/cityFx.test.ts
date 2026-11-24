import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Session, normalizeSession } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import { CityFx, FxItem, MAX_FX, fxActive, fxSignature, fxViewKey, visibleFx } from '../../src/webview/CityFx';
import { CityDefs } from '../../src/webview/CityGround';
import { CityMap, MINIMAP_MIN_BUILDINGS, miniTone } from '../../src/webview/CityMap';
import { FACADE } from '../../src/webview/facade';
import { viewRect } from '../../src/webview/MiniMap';
import { cssTransform } from '../../src/webview/usePanZoom';
import { ease, lerpTransform } from '../../src/webview/zoom';

const pt = { x: 0, y: 0 };
const item = (id: string, over: Partial<FxItem> = {}): FxItem => ({
  id, alert: pt, vent: pt, roof: pt, badge: pt, door: pt, street: pt,
  waiting: false, smoke: false, sparkle: false, selected: false, walkers: [], ...over,
});

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

function city(n: number, statusOf: (i: number) => string | undefined) {
  const sessions: Session[] = [];
  const workspaces: CityWorkspace[] = [];
  for (let i = 0; i < n; i++) {
    const status = statusOf(i);
    const ids: string[] = [];
    if (status) {
      const s = { ...normalizeSession({ sessionId: `s${i}`, cwd: `/w/${i}`, status, name: `task-${i}` })!, workspaceId: `w${i}` };
      sessions.push(s);
      ids.push(s.id);
    }
    workspaces.push({ id: `w${i}`, name: `ws-${i}`, path: `/w/${i}`, firstSeen: 0, lastSeen: 0, source: 'session', pinned: false, open: false, sessionIds: ids });
  }
  return { sessions, workspaces };
}

function renderCity(n: number, statusOf: (i: number) => string | undefined, extra: Record<string, unknown> = {}): string {
  const c = city(n, statusOf);
  return renderToStaticMarkup(
    createElement(CityMap, {
      workspaces: c.workspaces,
      sessions: c.sessions,
      agents: [],
      selection: undefined,
      onSelect: () => undefined,
      onOpen: () => undefined,
      initialTransform: undefined,
      onTransformChange: () => undefined,
      focusRequest: undefined,
      active: true,
      empty: null,
      ...extra,
    }),
  );
}

describe('camera flights', () => {
  it('ease is monotonic and clamped', () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0)).toBe(0);
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(1)).toBe(1);
    expect(ease(2)).toBe(1);
    expect(ease(0.25)).toBeLessThan(ease(0.75));
  });

  it('lerpTransform starts and ends exactly and moves the view centre on a straight line', () => {
    const vp = { width: 800, height: 600 };
    const a = { k: 0.5, x: 100, y: 50 };
    const b = { k: 2, x: -900, y: -700 };
    expect(lerpTransform(a, b, 0, vp)).toEqual(a);
    expect(lerpTransform(a, b, 1, vp)).toEqual(b);
    const mid = lerpTransform(a, b, 0.5, vp);
    expect(mid.k).toBeCloseTo(1); // geometric mean of 0.5 and 2
    const centre = (t: typeof a) => ({ x: (400 - t.x) / t.k, y: (300 - t.y) / t.k });
    expect(centre(mid).x).toBeCloseTo((centre(a).x + centre(b).x) / 2);
    expect(centre(mid).y).toBeCloseTo((centre(a).y + centre(b).y) / 2);
  });

  it('camera layers get a 3D CSS transform (own compositor layer, sharp after zooming)', () => {
    expect(cssTransform({ k: 1.23456789, x: 10.129, y: -4 })).toBe('translate3d(10.13px, -4px, 0) scale(1.2346)');
  });

  it('viewRect is the visible part of the world', () => {
    expect(viewRect({ k: 2, x: -100, y: -40 }, { width: 800, height: 600 })).toEqual({ x: 50, y: 20, width: 400, height: 300 });
  });
});

describe('effects layer', () => {
  it('only buildings with something to show are active', () => {
    expect(fxActive(item('a'))).toBe(false);
    expect(fxActive(item('a', { waiting: true }))).toBe(true);
    expect(fxActive(item('a', { walkers: [{ id: 'x', leaving: false }] }))).toBe(true);
  });

  it('the signature changes with what is drawn', () => {
    expect(fxSignature(item('a'))).toBe(fxSignature(item('a')));
    expect(fxSignature(item('a'))).not.toBe(fxSignature(item('a', { sparkle: true })));
    expect(fxSignature(item('a'))).not.toBe(fxSignature(item('a', { walkers: [{ id: 'x', leaving: true }] })));
  });

  it('culls to the buildings in view, drops smoke when zoomed far out and is bounded', () => {
    const all = [item('a', { smoke: true }), item('b', { waiting: true, smoke: true }), item('c', { waiting: true })];
    expect(visibleFx(all, undefined).map((i) => i.id)).toEqual(['a', 'b', 'c']); // not measured yet
    expect(visibleFx(all, fxViewKey(false, ['a', 'b'])).map((i) => i.id)).toEqual(['a', 'b']);
    const far = visibleFx(all, fxViewKey(true, ['a', 'b', 'c']));
    expect(far.map((i) => i.id)).toEqual(['b', 'c']); // smoke-only building is skipped
    expect(far[0].smoke).toBe(false);
    expect(far[0].waiting).toBe(true);
    const many = Array.from({ length: MAX_FX + 20 }, (_, i) => item(`w${i}`, { waiting: true }));
    expect(visibleFx(many, undefined)).toHaveLength(MAX_FX);
    expect(visibleFx(many, fxViewKey(false, many.map((i) => i.id)))).toHaveLength(MAX_FX);
  });

  it('renders ping, smoke, fireworks, marker and fountain jets; ambient parts respect the effects switch', () => {
    const items = [item('a', { waiting: true, smoke: true, sparkle: true, selected: true })];
    const on = renderToStaticMarkup(createElement('svg', null, createElement(CityFx, { items, fountains: [pt], effects: true })));
    expect(on).toContain('fx-ping');
    expect(on).toContain('fx-smoke');
    expect(count(on, /class="burst burst--/g)).toBe(3);
    expect(on).toContain('fx-marker');
    expect(on).toContain('fountain-spray');
    const off = renderToStaticMarkup(createElement('svg', null, createElement(CityFx, { items, fountains: [pt], effects: false })));
    expect(off).toContain('fx-ping'); // attention is never optional
    expect(off).toContain('fx-firework');
    expect(off).not.toContain('fx-smoke');
    expect(off).not.toContain('fountain-spray');
    expect(on).not.toMatch(/style=/);
  });
});

describe('city map layers', () => {
  it('splits the scene into ground, cars, buildings and effects layers', () => {
    const html = renderCity(3, (i) => (i === 0 ? 'busy' : i === 1 ? 'waiting' : undefined));
    for (const layer of ['ground', 'cars', 'buildings', 'fx']) expect(count(html, new RegExp(`city-layer--${layer} pz-layer`, 'g'))).toBe(1);
    // everything that animates continuously is outside the static layers
    const ground = html.slice(html.indexOf('city-layer--ground'), html.indexOf('city-layer--cars'));
    const cars = html.slice(html.indexOf('city-layer--cars'), html.indexOf('city-layer--buildings'));
    const buildings = html.slice(html.indexOf('city-layer--buildings'), html.indexOf('city-layer--fx'));
    const fx = html.slice(html.indexOf('city-layer--fx'));
    expect(cars).toContain('toy-car');
    for (const stat of [ground, buildings]) {
      expect(stat).not.toContain('toy-car');
      expect(stat).not.toContain('fx-');
      expect(stat).not.toContain('fountain-spray');
      expect(stat).not.toContain('door-walker');
    }
    expect(buildings).toContain('iso-building');
    expect(count(fx, /class="fx-smoke"/g)).toBe(1); // the working building
    expect(count(fx, /class="fx-ping"/g)).toBe(1); // the waiting building
    expect(html).toContain('class="sky"');
    expect(html).not.toMatch(/style=/);
  });

  it('ambient effects can be switched off (clouds, birds, smoke) - alerts stay', () => {
    const html = renderCity(3, (i) => (i === 0 ? 'busy' : i === 1 ? 'waiting' : undefined), { effects: false });
    expect(html).not.toContain('class="cloud');
    expect(html).not.toContain('class="birds"');
    expect(html).not.toContain('fx-smoke');
    expect(html).toContain('fx-ping');
  });

  it('fireworks over the building whose agent just completed a task', () => {
    const html = renderCity(2, () => 'busy', { sparkles: new Set(['s1:main']) });
    expect(count(html, /class="fx-firework"/g)).toBe(1);
    expect(html).toMatch(/data-fx-for="w1">(?:(?!data-fx-for).)*fx-firework/);
  });

  it('the minimap appears for bigger cities, one dot per building coloured by urgency', () => {
    expect(renderCity(MINIMAP_MIN_BUILDINGS - 1, () => undefined)).not.toContain('class="minimap"');
    const html = renderCity(MINIMAP_MIN_BUILDINGS, (i) => (i === 0 ? 'waiting' : i === 1 ? 'busy' : i === 2 ? 'idle' : undefined));
    expect(html).toContain('class="minimap"');
    expect(count(html, /class="mm-dot /g)).toBe(MINIMAP_MIN_BUILDINGS);
    expect(count(html, /mm-dot--waiting/g)).toBe(1);
    expect(count(html, /mm-dot--working/g)).toBe(1);
    expect(count(html, /mm-dot--live/g)).toBe(1);
    expect(count(html, /mm-dot--quiet/g)).toBe(MINIMAP_MIN_BUILDINGS - 3);
  });

  it('miniTone: what needs attention wins', () => {
    expect(miniTone({ waiting: 1, failed: 1, working: 1, live: 3 })).toBe('waiting');
    expect(miniTone({ waiting: 0, failed: 1, working: 1, live: 2 })).toBe('failed');
    expect(miniTone({ waiting: 0, failed: 0, working: 1, live: 1 })).toBe('working');
    expect(miniTone({ waiting: 0, failed: 0, working: 0, live: 1 })).toBe('live');
    expect(miniTone({ waiting: 0, failed: 0, working: 0, live: 0 })).toBe('quiet');
  });

  it('shared gradient defs cover every palette and both levels', () => {
    const html = renderToStaticMarkup(createElement(CityDefs));
    for (let n = 0; n < FACADE.PALETTES; n++) for (const g of ['wl', 'wr', 'wlq', 'wrq', 'rf', 'rb']) expect(html).toContain(`id="cc-${g}-${n}"`);
    for (const id of ['cc-rug', 'cc-water', 'cc-soft-shadow', 'cc-cast', 'cc-glow', 'cc-sky', 'cc-brick', 'cc-bv-floor', 'cc-win-working', 'cc-win-working-b']) {
      expect(html).toContain(`id="${id}"`);
    }
    // ids are unique (a duplicate would silently win over the intended gradient)
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).not.toMatch(/style=/);
  });
});
