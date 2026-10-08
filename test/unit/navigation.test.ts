import { describe, expect, it } from 'vitest';
import { computeCityLayout } from '../../src/webview/cityLayout';
import { CITY_NAV, nextNeedingAttention, sanitizeNav, spatialNext } from '../../src/webview/navigation';

describe('navigation state', () => {
  it('sanitizes levels', () => {
    expect(sanitizeNav({ level: 'building', workspaceId: 'w1' })).toEqual({ level: 'building', workspaceId: 'w1' });
    for (const bad of [undefined, null, 5, {}, { level: 'building' }, { level: 'building', workspaceId: 'x'.repeat(301) }, { level: 'attic' }]) {
      expect(sanitizeNav(bad)).toEqual(CITY_NAV);
    }
  });
});

describe('keyboard spatial navigation', () => {
  //   a(0,0)   b(100,0)
  //   c(0,100) d(100,100)   e(300,40)
  const pts = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 0, y: 100 },
    { id: 'd', x: 100, y: 100 },
    { id: 'e', x: 300, y: 40 },
  ];
  it('moves to the nearest neighbour in the arrow direction', () => {
    expect(spatialNext(pts, 'a', 'right')).toBe('b');
    expect(spatialNext(pts, 'a', 'down')).toBe('c');
    expect(spatialNext(pts, 'd', 'up')).toBe('b');
    expect(spatialNext(pts, 'd', 'left')).toBe('c');
    expect(spatialNext(pts, 'b', 'right')).toBe('e');
    expect(spatialNext(pts, 'a', 'left')).toBeUndefined(); // edge of the city
    expect(spatialNext(pts, 'e', 'right')).toBeUndefined();
  });
  it('starts at the first building without a current one', () => {
    expect(spatialNext(pts, undefined, 'down')).toBe('a');
    expect(spatialNext(pts, 'gone', 'down')).toBe('a');
    expect(spatialNext([], undefined, 'down')).toBeUndefined();
  });
  it('visits every building of a real city layout (no dead ends for right / down sweeps)', () => {
    const workspaces = Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, name: `w${i}`, sessionIds: [] }));
    const { buildings } = computeCityLayout({ workspaces, sessions: [] });
    const points = buildings.map((b) => ({ id: b.workspaceId, x: b.center.x, y: b.center.y }));
    const reached = new Set<string>();
    for (const start of points) {
      reached.add(start.id);
      for (const dir of ['left', 'right', 'up', 'down'] as const) {
        const n = spatialNext(points, start.id, dir);
        if (n) reached.add(n);
      }
    }
    expect(reached.size).toBe(20);
    // every move goes in the pressed direction on screen
    for (const p of points) {
      const r = spatialNext(points, p.id, 'right');
      if (r) expect(points.find((q) => q.id === r)!.x).toBeGreaterThan(p.x);
      const u = spatialNext(points, p.id, 'up');
      if (u) expect(points.find((q) => q.id === u)!.y).toBeLessThan(p.y);
    }
  });
});

describe('taxi: next building that needs attention', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('cycles through the most urgent class only', () => {
    const urgency = new Map([
      ['a', 1],
      ['b', 3],
      ['c', 0],
      ['d', 3],
    ]);
    expect(nextNeedingAttention(order, urgency)).toBe('b');
    expect(nextNeedingAttention(order, urgency, 'b')).toBe('d');
    expect(nextNeedingAttention(order, urgency, 'd')).toBe('b');
    expect(nextNeedingAttention(order, new Map([['a', 1]]), 'a')).toBe('a');
    expect(nextNeedingAttention(order, new Map())).toBeUndefined();
  });
});
