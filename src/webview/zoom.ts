/**
 * Pure zoom/pan math for the city map (no DOM). A transform maps world (layout) coordinates to
 * screen (viewport) coordinates: screen = world * k + (x, y).
 */

export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** Low enough to fit a city with hundreds of imported buildings. */
export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 4;
/** Multiplicative step for buttons / keyboard. */
export const ZOOM_STEP = 1.25;
/** Pixels per arrow key press. */
export const PAN_STEP = 60;

export const IDENTITY: ViewTransform = { k: 1, x: 0, y: 0 };

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Zooms by `factor` keeping the world point under screen point (cx, cy) fixed. */
export function zoomAt(t: ViewTransform, factor: number, cx: number, cy: number): ViewTransform {
  const k = clampZoom(t.k * (Number.isFinite(factor) && factor > 0 ? factor : 1));
  const ratio = k / t.k;
  return { k, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
}

export function panBy(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { k: t.k, x: t.x + (Number.isFinite(dx) ? dx : 0), y: t.y + (Number.isFinite(dy) ? dy : 0) };
}

export function screenToWorld(t: ViewTransform, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
}

/** Wheel delta -> zoom factor (smooth, symmetric for in/out). deltaMode 1 = lines, 2 = pages. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-300, Math.min(300, Number.isFinite(px) ? px : 0));
  return Math.exp(-clamped * 0.0015);
}

/** Transform that fits a rect into the viewport (centered), zoom capped at maxK. */
export function fitRect(rect: Rect, viewport: Size, padding = 16, maxK = 1): ViewTransform {
  const vw = Math.max(1, viewport.width - padding * 2);
  const vh = Math.max(1, viewport.height - padding * 2);
  const k = clampZoom(Math.min(maxK, vw / Math.max(1, rect.width), vh / Math.max(1, rect.height)));
  return {
    k,
    x: viewport.width / 2 - (rect.x + rect.width / 2) * k,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * k,
  };
}

/** Fit the whole content (origin 0,0). */
export function fitContent(content: Size, viewport: Size, padding = 16): ViewTransform {
  return fitRect({ x: 0, y: 0, ...content }, viewport, padding, 1);
}

/**
 * Keeps at least `margin` screen pixels of the content visible so the city can never be panned
 * completely out of view.
 */
export function clampPan(t: ViewTransform, content: Size, viewport: Size, margin = 60): ViewTransform {
  const w = content.width * t.k;
  const h = content.height * t.k;
  const minX = margin - w;
  const maxX = viewport.width - margin;
  const minY = margin - h;
  const maxY = viewport.height - margin;
  return {
    k: t.k,
    x: Math.min(maxX, Math.max(minX, t.x)),
    y: Math.min(maxY, Math.max(minY, t.y)),
  };
}

export function transformAttr(t: ViewTransform): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  return `translate(${r(t.x)} ${r(t.y)}) scale(${Math.round(t.k * 10000) / 10000})`;
}

export function isValidTransform(v: unknown): v is ViewTransform {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.k === 'number' &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    Number.isFinite(o.k) &&
    Number.isFinite(o.x) &&
    Number.isFinite(o.y) &&
    o.k >= MIN_ZOOM &&
    o.k <= MAX_ZOOM &&
    Math.abs(o.x) < 1e6 &&
    Math.abs(o.y) < 1e6
  );
}
