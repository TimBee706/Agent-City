/**
 * Pure, deterministic isometric city layout ("play rug"): a square-ish grid of plots separated by
 * streets, one plot per workspace plus park plots, decorations and toy-car loops. No DOM / React.
 *
 * The grid (roads, parks, decorations, car loops) depends only on the number of buildings, so the
 * static ground layer stays identical while sessions change. Buildings are assigned to plots in
 * the existing order (active first, then last activity, then name): the most important ones sit in
 * the middle of the city ("downtown") and the rest spiral outwards.
 */
import { Pt, Projector, cellSeed, makeProjector, rng, subPath, worldToScreen } from './iso';

interface CellIndex {
  col: number;
  row: number;
  seed: number;
}
import type { LayoutSession, LayoutWorkspace } from './layout';
import { orderWorkspaces } from './layout';

export const CITY = {
  /** Plot interior size in tiles. */
  PLOT: 4,
  /** Road width in tiles. */
  ROAD: 1,
  /** Plot + road. */
  PITCH: 5,
  /** Building footprint (tiles) and its offset inside the plot. */
  FOOT: 2.4,
  FOOT_OFF: 0.8,
  /** Rug border around the street grid (tiles). */
  RUG: 1.3,
  /** Rug thickness (px). */
  RUG_DEPTH: 9,
  /** Room above the top-most plot for tall buildings and badges (px). */
  TOP_PAD: 130,
  SIDE_PAD: 24,
  BOTTOM_PAD: 24,
  MAX_DECORATIONS: 400,
  MIN_CARS: 4,
  MAX_CARS: 12,
  /** Toy car speed in tiles per second. */
  CAR_SPEED: 1.1,
} as const;

export type ParkKind = 'fountain' | 'pond' | 'grove' | 'garden';

export interface CityCell {
  index: number;
  col: number;
  row: number;
  /** World origin of the plot interior (tiles). */
  gx: number;
  gy: number;
  kind: 'building' | 'park';
  park?: ParkKind;
}

export type DecorationKind =
  | 'tree-round'
  | 'tree-cone'
  | 'bush'
  | 'flowers'
  | 'bench'
  | 'lamp'
  | 'traffic-light'
  | 'parked-car'
  | 'pond'
  | 'fountain'
  | 'swing';

/**
 * Painter layer of a decoration:
 *  - ground: flat (flowers, pond) - drawn with the ground
 *  - road:   on / at the street (lamps, traffic lights, parked cars) - drawn after the ground
 *  - back / front: on a plot, drawn before / after the building of that plot
 */
export type DecorationLayer = 'ground' | 'road' | 'back' | 'front';

export interface Decoration {
  id: string;
  kind: DecorationKind;
  /** Centre in world tiles. */
  gx: number;
  gy: number;
  /** Footprint radius in tiles (for overlap checks). */
  r: number;
  variant: number;
  /** Small decorations are hidden when zoomed out (level of detail). */
  small: boolean;
  layer: DecorationLayer;
  /** Plot index for back / front decorations, -1 otherwise. */
  cell: number;
}

export interface CarLoop {
  id: string;
  /** Closed loop of screen points (corners). */
  points: Pt[];
  /** For each segment i (points[i] -> points[i+1]): true when it runs along the gx axis. */
  alongX: boolean[];
  /** Loop length in px. */
  length: number;
  /** Duration of one lap in ms. */
  durationMs: number;
  variant: number;
  /** The one clickable taxi (cycles through buildings that need attention). */
  taxi: boolean;
}

export interface GroundPaths {
  rugTop: string;
  rugLeft: string;
  rugRight: string;
  /** Rug border stitching (inset outline). */
  rugStitch: string;
  roads: string;
  centreLines: string;
  zebras: string;
  buildingLawns: string;
  parkLawns: string;
}

export interface CityGrid {
  cols: number;
  rows: number;
  buildingCount: number;
  cells: CityCell[];
  /** Cell indices in building placement order (downtown first). */
  buildingCells: number[];
  decorations: Decoration[];
  ground: GroundPaths;
  cars: CarLoop[];
  /** Origin offset (screen px) applied to every projected point. */
  ox: number;
  oy: number;
  width: number;
  height: number;
}

export interface BuildingPlacement {
  workspaceId: string;
  cell: number;
  col: number;
  row: number;
  /** Footprint origin and size (tiles). */
  gx: number;
  gy: number;
  w: number;
  d: number;
  /** Painter depth (front corner). */
  depth: number;
  /** Ground centre of the footprint (screen). */
  center: Pt;
  /** Door on the +gy face (screen, ground level). */
  door: Pt;
  /** Front point on the street in front of the door (screen) - walkers come from here. */
  street: Pt;
}

export interface CityLayout {
  grid: CityGrid;
  buildings: BuildingPlacement[];
}

export function projectorFor(grid: Pick<CityGrid, 'ox' | 'oy'>): Projector {
  return makeProjector(grid.ox, grid.oy);
}

/** Grid size for n buildings: a few parks in between, roughly square (a diamond on screen). */
export function gridSize(n: number): { cols: number; rows: number; parks: number } {
  if (n <= 0) return { cols: 0, rows: 0, parks: 0 };
  const wanted = Math.min(40, Math.round(n * 0.2) + 2);
  const total = n + wanted;
  const cols = Math.max(2, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(2, Math.ceil(total / cols));
  return { cols, rows, parks: cols * rows - n };
}

const P = CITY.PITCH;

function cellOrigin(col: number, row: number): { gx: number; gy: number } {
  return { gx: col * P + CITY.ROAD, gy: row * P + CITY.ROAD };
}

/** Cells ordered from the city centre outwards (ties: deterministic per-cell hash). */
function centreOrder(cols: number, rows: number): CellIndex[] {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const out: CellIndex[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) out.push({ col, row, seed: cellSeed(col, row) });
  out.sort((a, b) => {
    const da = Math.hypot(a.col - cx, a.row - cy);
    const db = Math.hypot(b.col - cx, b.row - cy);
    return da - db || a.seed - b.seed || a.row - b.row || a.col - b.col;
  });
  return out;
}

const PARK_KINDS: ParkKind[] = ['grove', 'pond', 'garden', 'grove', 'garden'];

// Plot-local decoration spots on building plots (outside the footprint, door path and sign kept free).
const BUILDING_SPOTS: [number, number][] = [
  [0.4, 0.4],
  [2.0, 0.4],
  [3.6, 0.4],
  [0.4, 2.0],
  [3.6, 2.0],
  [3.6, 3.6],
  [0.4, 3.6],
];
const PARK_SPOTS: [number, number][] = [
  [0.6, 0.6],
  [2.0, 0.55],
  [3.4, 0.6],
  [0.55, 2.0],
  [3.45, 2.0],
  [0.6, 3.4],
  [2.0, 3.45],
  [3.4, 3.4],
];

function shuffled<T>(arr: readonly T[], next: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DECO_RADIUS: Record<DecorationKind, number> = {
  'tree-round': 0.34,
  'tree-cone': 0.3,
  bush: 0.22,
  flowers: 0.25,
  bench: 0.25,
  lamp: 0.06,
  'traffic-light': 0.06,
  'parked-car': 0.3,
  pond: 1.05,
  fountain: 0.62,
  swing: 0.4,
};
const SMALL: ReadonlySet<DecorationKind> = new Set(['bush', 'flowers', 'bench', 'lamp', 'traffic-light', 'parked-car', 'swing']);
const FLAT: ReadonlySet<DecorationKind> = new Set(['flowers', 'pond']);
/** Priority when the decoration budget is exceeded (lower = dropped first). */
const PRIORITY: Record<DecorationKind, number> = {
  pond: 9,
  fountain: 9,
  'tree-round': 6,
  'tree-cone': 6,
  lamp: 5,
  'traffic-light': 4,
  swing: 4,
  bench: 3,
  'parked-car': 3,
  bush: 2,
  flowers: 1,
};

function deco(kind: DecorationKind, gx: number, gy: number, variant: number, cell: number, plotDepth?: number): Decoration {
  let layer: DecorationLayer = 'road';
  if (FLAT.has(kind)) layer = 'ground';
  else if (cell >= 0 && plotDepth !== undefined) layer = gx + gy < plotDepth ? 'back' : 'front';
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    id: `${kind}@${r3(gx)},${r3(gy)}`,
    kind,
    gx: r3(gx),
    gy: r3(gy),
    r: DECO_RADIUS[kind],
    variant,
    small: SMALL.has(kind),
    layer,
    cell,
  };
}

function plotDecorations(cell: CityCell): Decoration[] {
  const next = rng(cellSeed(cell.col, cell.row, 0x51ed));
  const out: Decoration[] = [];
  // Building centre depth: things behind it (smaller gx + gy) are drawn first.
  const centreDepth = cell.gx + cell.gy + CITY.PLOT;
  const at = (kind: DecorationKind, lx: number, ly: number, variant: number) =>
    out.push(deco(kind, cell.gx + lx, cell.gy + ly, variant, cell.index, centreDepth));
  if (cell.kind === 'building') {
    const k = 1 + Math.floor(next() * 3);
    for (const [lx, ly] of shuffled(BUILDING_SPOTS, next).slice(0, k)) {
      const roll = next();
      const kind: DecorationKind = roll < 0.42 ? 'tree-round' : roll < 0.7 ? 'tree-cone' : roll < 0.86 ? 'bush' : 'flowers';
      at(kind, lx, ly, Math.floor(next() * 3));
    }
    return out;
  }
  const kind = cell.park ?? 'grove';
  if (kind === 'pond') at('pond', 2, 2, Math.floor(next() * 2));
  else if (kind === 'fountain') at('fountain', 2, 2, 0);
  else if (kind === 'grove') at('tree-round', 2, 2, Math.floor(next() * 3));
  else at('flowers', 2, 2, Math.floor(next() * 3));
  const k = 4 + Math.floor(next() * 3);
  for (const [lx, ly] of shuffled(PARK_SPOTS, next).slice(0, k)) {
    const roll = next();
    let dk: DecorationKind;
    if (kind === 'garden') dk = roll < 0.45 ? 'flowers' : roll < 0.65 ? 'bench' : roll < 0.85 ? 'bush' : 'tree-round';
    else if (kind === 'grove') dk = roll < 0.5 ? 'tree-cone' : roll < 0.85 ? 'tree-round' : 'bush';
    else dk = roll < 0.35 ? 'tree-round' : roll < 0.55 ? 'bench' : roll < 0.75 ? 'flowers' : roll < 0.9 ? 'bush' : 'swing';
    at(dk, lx, ly, Math.floor(next() * 3));
  }
  return out;
}

function roadDecorations(cols: number, rows: number, cells: readonly CityCell[]): Decoration[] {
  const out: Decoration[] = [];
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const ix = i * P;
      const iy = j * P;
      const h = cellSeed(i, j, 0x1a2b);
      // street lamp on the front corner of every other intersection
      if ((i + j) % 2 === 0) out.push(deco('lamp', ix + 0.9, iy + 0.9, h % 2, -1));
      // traffic lights on some inner intersections (back corner)
      const inner = i > 0 && j > 0 && i < cols && j < rows;
      if (inner && h % 4 === 0) out.push(deco('traffic-light', ix + 0.1, iy + 0.1, (h >>> 3) % 3, -1));
    }
  }
  // parked cars at the kerb in front of some building plots
  for (const c of cells) {
    if (c.kind !== 'building') continue;
    const next = rng(cellSeed(c.col, c.row, 0xca7));
    if (next() < 0.3) {
      const lx = 0.5 + next() * 3;
      out.push(deco('parked-car', c.gx + lx, c.gy + CITY.PLOT + 0.3, Math.floor(next() * 6), -1));
    }
  }
  return out;
}

function groundPaths(cols: number, rows: number, p: Projector): GroundPaths {
  const W = cols * P + CITY.ROAD;
  const H = rows * P + CITY.ROAD;
  const M = CITY.RUG;
  const quad = (gx: number, gy: number, w: number, d: number, z = 0) =>
    subPath([p(gx, gy, z), p(gx + w, gy, z), p(gx + w, gy + d, z), p(gx, gy + d, z)]);
  const rugTop = quad(-M, -M, W + 2 * M, H + 2 * M);
  const D = CITY.RUG_DEPTH;
  const rugLeft = subPath([p(-M, H + M, 0), p(W + M, H + M, 0), p(W + M, H + M, -D), p(-M, H + M, -D)]);
  const rugRight = subPath([p(W + M, H + M, 0), p(W + M, -M, 0), p(W + M, -M, -D), p(W + M, H + M, -D)]);
  const s = 0.45;
  const rugStitch = quad(-M + s, -M + s, W + 2 * (M - s), H + 2 * (M - s));

  const roads: string[] = [];
  for (let i = 0; i <= cols; i++) roads.push(quad(i * P, 0, CITY.ROAD, H));
  for (let j = 0; j <= rows; j++) roads.push(quad(0, j * P, W, CITY.ROAD));

  const line = (a: Pt, b: Pt) => `M${Math.round(a.x * 10) / 10} ${Math.round(a.y * 10) / 10}L${Math.round(b.x * 10) / 10} ${Math.round(b.y * 10) / 10}`;
  const centre: string[] = [];
  for (let i = 0; i <= cols; i++)
    for (let j = 0; j < rows; j++) centre.push(line(p(i * P + 0.5, j * P + 1.15), p(i * P + 0.5, (j + 1) * P - 0.15)));
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i < cols; i++) centre.push(line(p(i * P + 1.15, j * P + 0.5), p((i + 1) * P - 0.15, j * P + 0.5)));

  // zebra crossings on the two front approaches of every intersection
  const zebras: string[] = [];
  const STRIPES = 4;
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const ix = i * P;
      const iy = j * P;
      for (let k = 0; k < STRIPES; k++) {
        const a = 0.12 + (k * 0.76) / STRIPES;
        const b = a + 0.1;
        if (j < rows) zebras.push(quad(ix + a, iy + 1.08, b - a, 0.3)); // along +gy approach
        if (i < cols) zebras.push(quad(ix + 1.08, iy + a, 0.3, b - a)); // along +gx approach
      }
    }
  }
  return {
    rugTop,
    rugLeft,
    rugRight,
    rugStitch,
    roads: roads.join(''),
    centreLines: centre.join(''),
    zebras: zebras.join(''),
    buildingLawns: '',
    parkLawns: '',
  };
}

function carLoops(cols: number, rows: number, n: number, p: Projector): CarLoop[] {
  if (n <= 0) return [];
  const count = Math.max(CITY.MIN_CARS, Math.min(CITY.MAX_CARS, 3 + Math.floor(n / 6)));
  const out: CarLoop[] = [];
  for (let k = 0; k < count; k++) {
    const next = rng(cellSeed(k, 77, 0xc0ffee));
    const c0 = Math.floor(next() * cols);
    const c1 = Math.min(cols - 1, c0 + Math.floor(next() * Math.min(4, cols - c0)));
    const r0 = Math.floor(next() * rows);
    const r1 = Math.min(rows - 1, r0 + Math.floor(next() * Math.min(4, rows - r0)));
    const clockwise = k % 2 === 0;
    const lane = clockwise ? 0.24 : -0.24; // opposite directions use opposite lanes
    const x0 = c0 * P + 0.5 + lane;
    const x1 = (c1 + 1) * P + 0.5 - lane;
    const y0 = r0 * P + 0.5 + lane;
    const y1 = (r1 + 1) * P + 0.5 - lane;
    let world: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    if (!clockwise) world = [world[0], world[3], world[2], world[1]];
    // start somewhere along the loop (rotate the corner list)
    const shift = Math.floor(next() * 4);
    world = [...world.slice(shift), ...world.slice(0, shift)];
    const points = world.map(([gx, gy]) => p(gx, gy));
    const alongX = world.map((w, i) => {
      const nx = world[(i + 1) % world.length];
      return Math.abs(nx[1] - w[1]) < 1e-9;
    });
    let tiles = 0;
    for (let i = 0; i < world.length; i++) {
      const a = world[i];
      const b = world[(i + 1) % world.length];
      tiles += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    }
    let length = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    out.push({
      id: `car-${k}`,
      points: points.map((q) => ({ x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 })),
      alongX,
      length: Math.round(length),
      durationMs: Math.round((tiles / (CITY.CAR_SPEED * (0.8 + next() * 0.5))) * 1000),
      variant: k % 6,
      taxi: k === 0,
    });
  }
  return out;
}

/**
 * Grid, ground paths, decorations and car loops for `n` buildings. Depends only on `n` - so the
 * caller can memoise it on the building count.
 */
export function computeCityGrid(n: number): CityGrid {
  const count = Math.max(0, Math.floor(n));
  const { cols, rows, parks } = gridSize(count);
  if (count === 0) {
    return {
      cols: 0,
      rows: 0,
      buildingCount: 0,
      cells: [],
      buildingCells: [],
      decorations: [],
      ground: { rugTop: '', rugLeft: '', rugRight: '', rugStitch: '', roads: '', centreLines: '', zebras: '', buildingLawns: '', parkLawns: '' },
      cars: [],
      ox: 0,
      oy: 0,
      width: 320,
      height: 200,
    };
  }

  // 1. which cells are parks: interleaved from the centre outwards, centre cell always a building
  const order = centreOrder(cols, rows);
  const isPark = new Set<string>();
  let parksLeft = parks;
  let cellsLeft = order.length;
  for (let i = 0; i < order.length; i++, cellsLeft--) {
    const c = order[i];
    if (parksLeft <= 0) break;
    const must = parksLeft >= cellsLeft;
    const chance = (c.seed % 1000) / 1000 < (parksLeft / cellsLeft) * 1.15;
    if (i > 0 && (must || chance)) {
      isPark.add(`${c.col},${c.row}`);
      parksLeft--;
    }
  }

  // 2. cells (row-major index) with park kinds; the most central park is the fountain plaza
  const cells: CityCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const o = cellOrigin(col, row);
      const park = isPark.has(`${col},${row}`);
      const cell: CityCell = { index: cells.length, col, row, gx: o.gx, gy: o.gy, kind: park ? 'park' : 'building' };
      if (park) cell.park = PARK_KINDS[cellSeed(col, row, 0xbeef) % PARK_KINDS.length];
      cells.push(cell);
    }
  }
  const buildingCells: number[] = [];
  let fountain = false;
  for (const c of order) {
    const cell = cells[c.row * cols + c.col];
    if (cell.kind === 'building') buildingCells.push(cell.index);
    else if (!fountain) {
      cell.park = 'fountain';
      fountain = true;
    }
  }

  // 3. screen extents -> origin so the whole rug starts at (0, 0)
  const W = cols * P + CITY.ROAD;
  const H = rows * P + CITY.ROAD;
  const M = CITY.RUG;
  const left = worldToScreen(-M, H + M);
  const right = worldToScreen(W + M, -M);
  const top = worldToScreen(-M, -M);
  const bottom = worldToScreen(W + M, H + M);
  const ox = -left.x + CITY.SIDE_PAD;
  const oy = -top.y + CITY.TOP_PAD;
  const width = Math.ceil(right.x - left.x + 2 * CITY.SIDE_PAD);
  const height = Math.ceil(bottom.y - top.y + CITY.TOP_PAD + CITY.RUG_DEPTH + CITY.BOTTOM_PAD);
  const p = makeProjector(ox, oy);

  // 4. ground paths incl. lawns
  const ground = groundPaths(cols, rows, p);
  const lawn = (c: CityCell) =>
    subPath([p(c.gx, c.gy), p(c.gx + CITY.PLOT, c.gy), p(c.gx + CITY.PLOT, c.gy + CITY.PLOT), p(c.gx, c.gy + CITY.PLOT)]);
  ground.buildingLawns = cells.filter((c) => c.kind === 'building').map(lawn).join('');
  ground.parkLawns = cells.filter((c) => c.kind === 'park').map(lawn).join('');

  // 5. decorations (bounded; lowest priority dropped first, deterministic)
  let decorations = [...cells.flatMap(plotDecorations), ...roadDecorations(cols, rows, cells)];
  if (decorations.length > CITY.MAX_DECORATIONS) {
    const ranked = decorations
      .map((d, i) => ({ d, i, k: PRIORITY[d.kind] * 1e6 + (cellSeed(Math.round(d.gx * 10), Math.round(d.gy * 10), 7) % 1e6) }))
      .sort((a, b) => b.k - a.k || a.i - b.i)
      .slice(0, CITY.MAX_DECORATIONS);
    const keep = new Set(ranked.map((x) => x.i));
    decorations = decorations.filter((_, i) => keep.has(i));
  }

  return {
    cols,
    rows,
    buildingCount: count,
    cells,
    buildingCells,
    decorations,
    ground,
    cars: carLoops(cols, rows, count, p),
    ox,
    oy,
    width,
    height,
  };
}

/** Places the (already ordered) workspaces on the grid's building cells. */
export function placeBuildings(grid: CityGrid, orderedIds: readonly string[]): BuildingPlacement[] {
  const p = projectorFor(grid);
  const out: BuildingPlacement[] = [];
  const n = Math.min(orderedIds.length, grid.buildingCells.length);
  for (let i = 0; i < n; i++) {
    const cell = grid.cells[grid.buildingCells[i]];
    const gx = cell.gx + CITY.FOOT_OFF;
    const gy = cell.gy + CITY.FOOT_OFF;
    const w = CITY.FOOT;
    const d = CITY.FOOT;
    out.push({
      workspaceId: orderedIds[i],
      cell: cell.index,
      col: cell.col,
      row: cell.row,
      gx,
      gy,
      w,
      d,
      depth: gx + gy + w + d,
      center: p(gx + w / 2, gy + d / 2),
      door: p(gx + w / 2, gy + d),
      street: p(gx + w / 2, cell.gy + CITY.PLOT + 0.5),
    });
  }
  return out;
}

/** Full city layout: ordered workspaces placed on a grid for their count. */
export function computeCityLayout(
  input: { workspaces: readonly LayoutWorkspace[]; sessions: readonly LayoutSession[] },
  grid?: CityGrid,
): CityLayout {
  const sessionsById = new Map(input.sessions.map((s) => [s.id, s]));
  const ordered = orderWorkspaces(input.workspaces, sessionsById);
  const g = grid && grid.buildingCount === ordered.length ? grid : computeCityGrid(ordered.length);
  return { grid: g, buildings: placeBuildings(g, ordered.map((w) => w.id)) };
}

/** Screen bounding box of a building incl. its height (for zoom-to / hit tests). */
export function buildingRect(grid: CityGrid, b: BuildingPlacement, heightPx: number): { x: number; y: number; width: number; height: number } {
  const p = projectorFor(grid);
  const left = p(b.gx, b.gy + b.d);
  const right = p(b.gx + b.w, b.gy);
  const top = p(b.gx, b.gy, heightPx);
  const bottom = p(b.gx + b.w, b.gy + b.d);
  return { x: left.x, y: top.y, width: right.x - left.x, height: bottom.y - top.y };
}

/**
 * Web Animations keyframes for one lap of a car: `move` (translate along the loop) and `orient`
 * (mirror for segments along gy, flipping instantly at the corners). Both use the same timing.
 */
export function carKeyframes(car: Pick<CarLoop, 'points' | 'alongX'>): {
  move: { transform: string; offset: number }[];
  orient: { transform: string; offset: number }[];
} {
  const n = car.points.length;
  const move: { transform: string; offset: number }[] = [];
  const orient: { transform: string; offset: number }[] = [];
  if (n < 2) return { move, orient };
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = car.points[i];
    const b = car.points[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(l);
    total += l;
  }
  if (total <= 0) return { move, orient };
  const EPS = 0.0004;
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = car.points[i];
    const start = r5(acc / total);
    acc += seg[i];
    const flip = `scale(${car.alongX[i] ? 1 : -1}, 1)`;
    move.push({ transform: `translate(${a.x}px, ${a.y}px)`, offset: start });
    orient.push({ transform: flip, offset: start });
    orient.push({ transform: flip, offset: i === n - 1 ? 1 : r5(Math.max(start, acc / total - EPS)) });
  }
  const first = car.points[0];
  move.push({ transform: `translate(${first.x}px, ${first.y}px)`, offset: 1 });
  return { move, orient };
}

/** Static SVG transform attributes (start of the loop) for parked / reduced-motion cars. */
export function carRest(car: Pick<CarLoop, 'points' | 'alongX'>): { move: string; orient: string } {
  const q = car.points[0] ?? { x: 0, y: 0 };
  return { move: `translate(${q.x} ${q.y})`, orient: `scale(${car.alongX[0] ? 1 : -1} 1)` };
}
