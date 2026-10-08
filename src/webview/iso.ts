/**
 * Pure 2.5D isometric (dimetric 2:1) projection helpers. No DOM / React.
 *
 * World coordinates are tile units on the ground plane: `gx` grows towards the lower right of the
 * screen, `gy` towards the lower left, `z` is a height in screen pixels. One tile is TILE_W x TILE_H
 * pixels on screen (2:1). Things with a larger depth key are closer to the viewer and must be drawn
 * later (painter's algorithm).
 */

export const TILE_W = 64;
export const TILE_H = 32;

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** World (tile) coordinates -> screen pixels (before any origin offset). */
export function worldToScreen(gx: number, gy: number, z = 0): Pt {
  return { x: ((gx - gy) * TILE_W) / 2, y: ((gx + gy) * TILE_H) / 2 - z };
}

/** Screen pixels (ground plane, z = 0, no origin offset) -> world tile coordinates. */
export function screenToWorld(x: number, y: number): { gx: number; gy: number } {
  const a = x / (TILE_W / 2);
  const b = y / (TILE_H / 2);
  return { gx: (a + b) / 2, gy: (b - a) / 2 };
}

/** A projector bound to an origin offset (so the whole map starts at screen 0,0). */
export type Projector = (gx: number, gy: number, z?: number) => Pt;

export function makeProjector(ox: number, oy: number): Projector {
  return (gx, gy, z = 0) => {
    const p = worldToScreen(gx, gy, z);
    return { x: p.x + ox, y: p.y + oy };
  };
}

/**
 * Depth sort key of a ground footprint: its front-most corner (gx + w, gy + d). Larger = closer to
 * the viewer. `tie` breaks equal keys deterministically (e.g. left-to-right).
 */
export function depthKey(gx: number, gy: number, w = 0, d = 0): number {
  return gx + w + gy + d;
}

/** Stable painter's order: ascending depth, ties by screen x (gx - gy), then by id. */
export function sortByDepth<T extends { depth: number; sx?: number; id?: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => a.depth - b.depth || (a.sx ?? 0) - (b.sx ?? 0) || ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0),
  );
}

/** Screen corners of a footprint: top (back), right, bottom (front), left. */
export function footprintCorners(p: Projector, gx: number, gy: number, w: number, d: number, z = 0): [Pt, Pt, Pt, Pt] {
  return [p(gx, gy, z), p(gx + w, gy, z), p(gx + w, gy + d, z), p(gx, gy + d, z)];
}

/** Screen bounding box of a box with footprint (gx, gy, w, d) and `height` px (unprojected origin 0,0). */
export function tileBounds(gx: number, gy: number, w: number, d: number, height = 0): Rect {
  const top = worldToScreen(gx, gy);
  const right = worldToScreen(gx + w, gy);
  const bottom = worldToScreen(gx + w, gy + d);
  const left = worldToScreen(gx, gy + d);
  const minX = left.x;
  const maxX = right.x;
  const minY = top.y - Math.max(0, height);
  const maxY = bottom.y;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Polygon point list for an SVG `points` attribute (rounded to 0.1 px). */
export function pts(points: readonly Pt[]): string {
  return points.map((q) => `${Math.round(q.x * 10) / 10},${Math.round(q.y * 10) / 10}`).join(' ');
}

/** Closed sub-path ("M x y L ... Z") for path `d` strings. */
export function subPath(points: readonly Pt[]): string {
  if (!points.length) return '';
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${points.map((q) => `${r(q.x)} ${r(q.y)}`).join('L')}Z`;
}

export interface BoxFaces {
  /** Roof / top face. */
  top: [Pt, Pt, Pt, Pt];
  /** Visible +gy face (lower left on screen). */
  left: [Pt, Pt, Pt, Pt];
  /** Visible +gx face (lower right on screen). */
  right: [Pt, Pt, Pt, Pt];
}

/** The three visible faces of an axis-aligned box from z0 to z1 (pixels). */
export function boxFaces(p: Projector, gx: number, gy: number, w: number, d: number, z1: number, z0 = 0): BoxFaces {
  return {
    top: [p(gx, gy, z1), p(gx + w, gy, z1), p(gx + w, gy + d, z1), p(gx, gy + d, z1)],
    left: [p(gx, gy + d, z0), p(gx + w, gy + d, z0), p(gx + w, gy + d, z1), p(gx, gy + d, z1)],
    right: [p(gx + w, gy + d, z0), p(gx + w, gy, z0), p(gx + w, gy, z1), p(gx + w, gy + d, z1)],
  };
}

/**
 * Point on a visible face of a footprint: `u` in [0, 1] runs along the face from its left end to
 * its right end on screen, `z` is the height in pixels.
 */
export function facePoint(p: Projector, face: 'left' | 'right', gx: number, gy: number, w: number, d: number, u: number, z: number): Pt {
  return face === 'left' ? p(gx + w * u, gy + d, z) : p(gx + w, gy + d - d * u, z);
}

/** Parallelogram on a face (window, door, sign) from u0..u1 and z0..z1. */
export function faceQuad(
  p: Projector,
  face: 'left' | 'right',
  gx: number,
  gy: number,
  w: number,
  d: number,
  u0: number,
  u1: number,
  z0: number,
  z1: number,
): [Pt, Pt, Pt, Pt] {
  return [
    facePoint(p, face, gx, gy, w, d, u0, z0),
    facePoint(p, face, gx, gy, w, d, u1, z0),
    facePoint(p, face, gx, gy, w, d, u1, z1),
    facePoint(p, face, gx, gy, w, d, u0, z1),
  ];
}

export function unionRect(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Deterministic 32-bit PRNG (mulberry32) for decorations - same seed, same city. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small integer hash of two grid coordinates (stable seeds per cell). */
export function cellSeed(col: number, row: number, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  h = Math.imul(h ^ (col + 0x9e37), 0x01000193);
  h = Math.imul(h ^ (row + 0x79b9), 0x01000193);
  h ^= h >>> 13;
  return h >>> 0;
}
