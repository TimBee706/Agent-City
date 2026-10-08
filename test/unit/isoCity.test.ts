import { describe, expect, it } from 'vitest';
import { CITY, computeCityGrid, computeCityLayout, gridSize, placeBuildings } from '../../src/webview/cityLayout';
import {
  TILE_H,
  TILE_W,
  boxFaces,
  depthKey,
  facePoint,
  makeProjector,
  pts,
  rng,
  screenToWorld,
  sortByDepth,
  tileBounds,
  worldToScreen,
} from '../../src/webview/iso';

describe('iso projection', () => {
  it('maps tiles 2:1 and round-trips', () => {
    expect(worldToScreen(0, 0)).toEqual({ x: 0, y: 0 });
    expect(worldToScreen(1, 0)).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
    expect(worldToScreen(0, 1)).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
    expect(worldToScreen(1, 1, 10)).toEqual({ x: 0, y: TILE_H - 10 });
    for (const [gx, gy] of [
      [3, 7],
      [-2.5, 4.25],
      [10, 0],
    ]) {
      const s = worldToScreen(gx, gy);
      const w = screenToWorld(s.x, s.y);
      expect(w.gx).toBeCloseTo(gx);
      expect(w.gy).toBeCloseTo(gy);
    }
    const p = makeProjector(100, 50);
    expect(p(1, 0)).toEqual({ x: 132, y: 66 });
  });

  it('tile bounds and box faces', () => {
    expect(tileBounds(0, 0, 1, 1)).toEqual({ x: -32, y: 0, width: 64, height: 32 });
    expect(tileBounds(0, 0, 2, 1, 40)).toEqual({ x: -32, y: -40, width: 96, height: 88 });
    const p = makeProjector(0, 0);
    const f = boxFaces(p, 0, 0, 1, 1, 20);
    expect(f.top[0]).toEqual({ x: 0, y: -20 });
    expect(f.left[0]).toEqual(worldToScreen(0, 1));
    expect(f.right[1]).toEqual(worldToScreen(1, 0));
    // faces run left -> right on screen
    expect(facePoint(p, 'left', 0, 0, 1, 1, 0, 0).x).toBeLessThan(facePoint(p, 'left', 0, 0, 1, 1, 1, 0).x);
    expect(facePoint(p, 'right', 0, 0, 1, 1, 0, 0).x).toBeLessThan(facePoint(p, 'right', 0, 0, 1, 1, 1, 0).x);
    expect(pts([{ x: 1.234, y: 5 }])).toBe('1.2,5');
  });

  it('depth sort: back to front, deterministic ties', () => {
    expect(depthKey(1, 1, 2, 2)).toBe(6);
    const items = [
      { id: 'front', depth: depthKey(5, 5), sx: 0 },
      { id: 'b', depth: depthKey(1, 1), sx: 10 },
      { id: 'a', depth: depthKey(1, 1), sx: -10 },
      { id: 'back', depth: depthKey(0, 0), sx: 0 },
    ];
    expect(sortByDepth(items).map((i) => i.id)).toEqual(['back', 'a', 'b', 'front']);
    expect(sortByDepth([...items].reverse()).map((i) => i.id)).toEqual(['back', 'a', 'b', 'front']);
  });

  it('seeded rng is deterministic', () => {
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

const ws = (i: number) => ({ id: `w${String(i).padStart(3, '0')}`, name: `project-${i}`, sessionIds: [] as string[] });

const circleRect = (c: { gx: number; gy: number; r: number }, r: { gx: number; gy: number; w: number; d: number }) => {
  const nx = Math.max(r.gx, Math.min(c.gx, r.gx + r.w));
  const ny = Math.max(r.gy, Math.min(c.gy, r.gy + r.d));
  return Math.hypot(c.gx - nx, c.gy - ny) < c.r - 1e-9;
};

describe('city layout (play rug)', () => {
  it('grid size: parks in between, roughly square', () => {
    expect(gridSize(0)).toEqual({ cols: 0, rows: 0, parks: 0 });
    for (const n of [1, 3, 7, 20, 150]) {
      const g = gridSize(n);
      expect(g.cols * g.rows).toBe(n + g.parks);
      expect(g.parks).toBeGreaterThanOrEqual(1);
      expect(Math.abs(g.cols - g.rows)).toBeLessThanOrEqual(1);
    }
  });

  it('empty city', () => {
    const g = computeCityGrid(0);
    expect(g.cells).toEqual([]);
    expect(g.cars).toEqual([]);
    expect(computeCityLayout({ workspaces: [], sessions: [] }).buildings).toEqual([]);
  });

  it('is deterministic and independent of input order', () => {
    const list = Array.from({ length: 23 }, (_, i) => ws(i));
    const a = computeCityLayout({ workspaces: list, sessions: [] });
    const b = computeCityLayout({ workspaces: [...list].reverse(), sessions: [] });
    expect(b).toEqual(a);
    expect(computeCityGrid(23)).toEqual(a.grid);
  });

  it('places the first (most important) building downtown and every building on its own plot', () => {
    const list = Array.from({ length: 30 }, (_, i) => ws(i));
    const { grid, buildings } = computeCityLayout({ workspaces: list, sessions: [] });
    expect(buildings).toHaveLength(30);
    const cells = new Set(buildings.map((b) => b.cell));
    expect(cells.size).toBe(30);
    const cx = (grid.cols - 1) / 2;
    const cy = (grid.rows - 1) / 2;
    const dist = (b: { col: number; row: number }) => Math.hypot(b.col - cx, b.row - cy);
    expect(dist(buildings[0])).toBeLessThanOrEqual(Math.min(...buildings.map(dist)) + 1e-9);
    expect(dist(buildings[0])).toBeLessThan(dist(buildings[29]));
    // parks fill the remaining plots, one of them is the fountain plaza
    const parks = grid.cells.filter((c) => c.kind === 'park');
    expect(parks.length).toBe(grid.cols * grid.rows - 30);
    expect(parks.filter((c) => c.park === 'fountain')).toHaveLength(1);
  });

  it('no overlaps between buildings, decorations and roads; bounded counts', () => {
    for (const n of [1, 5, 40, 150]) {
      const grid = computeCityGrid(n);
      const buildings = placeBuildings(
        grid,
        Array.from({ length: n }, (_, i) => `w${i}`),
      );
      expect(grid.decorations.length).toBeLessThanOrEqual(CITY.MAX_DECORATIONS);
      expect(grid.cars.length).toBeGreaterThanOrEqual(CITY.MIN_CARS);
      expect(grid.cars.length).toBeLessThanOrEqual(CITY.MAX_CARS);
      expect(grid.cars.filter((c) => c.taxi)).toHaveLength(1);
      // building footprints stay inside their plot (never on a road) and never overlap
      for (const b of buildings) {
        const c = grid.cells[b.cell];
        expect(b.gx).toBeGreaterThanOrEqual(c.gx);
        expect(b.gy).toBeGreaterThanOrEqual(c.gy);
        expect(b.gx + b.w).toBeLessThanOrEqual(c.gx + CITY.PLOT);
        expect(b.gy + b.d).toBeLessThanOrEqual(c.gy + CITY.PLOT);
      }
      const byCell = new Map(grid.decorations.filter((d) => d.cell >= 0).map((d) => [d.cell, [] as typeof grid.decorations]));
      for (const d of grid.decorations) {
        if (d.layer === 'road') {
          // on the street grid: never inside a plot interior
          const c = grid.cells.find((x) => d.gx > x.gx + 0.01 && d.gx < x.gx + CITY.PLOT - 0.01 && d.gy > x.gy + 0.01 && d.gy < x.gy + CITY.PLOT - 0.01);
          expect(c).toBeUndefined();
          continue;
        }
        expect(d.cell).toBeGreaterThanOrEqual(0); // every non-road decoration belongs to a plot
        const plotCell = grid.cells[d.cell];
        // fully inside its plot -> not on a road
        expect(d.gx - d.r).toBeGreaterThanOrEqual(plotCell.gx - 1e-9);
        expect(d.gy - d.r).toBeGreaterThanOrEqual(plotCell.gy - 1e-9);
        expect(d.gx + d.r).toBeLessThanOrEqual(plotCell.gx + CITY.PLOT + 1e-9);
        expect(d.gy + d.r).toBeLessThanOrEqual(plotCell.gy + CITY.PLOT + 1e-9);
        for (const b of buildings) expect(circleRect(d, b)).toBe(false);
        byCell.get(d.cell)!.push(d);
      }
      for (const list of byCell.values()) {
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            expect(Math.hypot(a.gx - b.gx, a.gy - b.gy)).toBeGreaterThanOrEqual(a.r + b.r - 1e-9);
          }
      }
      // ids are unique (React keys)
      expect(new Set(grid.decorations.map((d) => d.id)).size).toBe(grid.decorations.length);
    }
  });

  it('decorations behind a building are drawn before it, the rest after it', () => {
    const grid = computeCityGrid(12);
    for (const d of grid.decorations.filter((x) => x.layer === 'back' || x.layer === 'front')) {
      const c = grid.cells[d.cell];
      const centre = c.gx + c.gy + CITY.PLOT;
      expect(d.layer === 'back').toBe(d.gx + d.gy < centre);
    }
  });

  it('car loops run on road centre lines and have a sane speed', () => {
    const grid = computeCityGrid(30);
    for (const car of grid.cars) {
      expect(car.points).toHaveLength(4);
      expect(car.alongX).toHaveLength(4);
      expect(car.length).toBeGreaterThan(0);
      expect(car.durationMs).toBeGreaterThan(1000);
      for (const q of car.points) {
        expect(q.x).toBeGreaterThanOrEqual(0);
        expect(q.x).toBeLessThanOrEqual(grid.width);
        expect(q.y).toBeGreaterThanOrEqual(0);
        expect(q.y).toBeLessThanOrEqual(grid.height);
      }
    }
  });

  it('150 workspaces: layout + roads + decorations in < 80 ms, deterministic', () => {
    const list = Array.from({ length: 150 }, (_, i) => ws(i));
    computeCityLayout({ workspaces: list, sessions: [] }); // warm-up (JIT)
    const t0 = performance.now();
    const a = computeCityLayout({ workspaces: list, sessions: [] });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(80);
    expect(a.buildings).toHaveLength(150);
    expect(a.grid.decorations.length).toBeLessThanOrEqual(400);
    expect(a.grid.decorations.length).toBeGreaterThan(150);
    expect(computeCityLayout({ workspaces: [...list].reverse(), sessions: [] })).toEqual(a);
    // the rug fits into the reported size
    expect(a.grid.width).toBeGreaterThan(1000);
    expect(a.grid.height).toBeGreaterThan(500);
    for (const b of a.buildings) {
      expect(b.center.x).toBeGreaterThan(0);
      expect(b.center.x).toBeLessThan(a.grid.width);
      expect(b.center.y).toBeGreaterThan(CITY.TOP_PAD - 1);
      expect(b.center.y).toBeLessThan(a.grid.height);
    }
  });
});
