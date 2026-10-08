/**
 * Pure navigation helpers: city level <-> building level, keyboard spatial navigation between
 * buildings and the taxi's "next building that needs attention". No DOM / React, unit-tested.
 */
import type { Pt } from './iso';

export type ArrowDir = 'left' | 'right' | 'up' | 'down';

export type NavLevel = 'city' | 'building';

export interface NavState {
  level: NavLevel;
  /** Building shown on the building level. */
  workspaceId?: string;
}

export const CITY_NAV: NavState = { level: 'city' };

export function sanitizeNav(v: unknown): NavState {
  if (!v || typeof v !== 'object') return CITY_NAV;
  const o = v as Record<string, unknown>;
  if (o.level === 'building' && typeof o.workspaceId === 'string' && o.workspaceId.length > 0 && o.workspaceId.length <= 300) {
    return { level: 'building', workspaceId: o.workspaceId };
  }
  return CITY_NAV;
}

export interface NavPoint extends Pt {
  id: string;
}

const DIR: Record<ArrowDir, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/**
 * Screen-space spatial navigation: the nearest point in the arrow's direction. Points inside a
 * ±60° cone win; otherwise any point in that half plane. Off-axis distance counts double.
 * No current point -> the first point (placement order = most important building).
 */
export function spatialNext(points: readonly NavPoint[], currentId: string | undefined, dir: ArrowDir): string | undefined {
  const cur = currentId ? points.find((p) => p.id === currentId) : undefined;
  if (!cur) return points[0]?.id;
  const v = DIR[dir];
  let best: { id: string; score: number; cone: boolean } | undefined;
  for (const p of points) {
    if (p.id === cur.id) continue;
    const dx = p.x - cur.x;
    const dy = p.y - cur.y;
    const along = dx * v.x + dy * v.y;
    if (along <= 0.5) continue;
    const across = Math.abs(dx * v.y - dy * v.x);
    const cone = across <= along * Math.tan(Math.PI / 3);
    const score = along + 2 * across;
    if (!best || (cone && !best.cone) || (cone === best.cone && (score < best.score || (score === best.score && p.id < best.id)))) {
      best = { id: p.id, score, cone };
    }
  }
  return best?.id;
}

/**
 * Taxi target: the next building (in placement order, after `afterId`, cyclic) with the highest
 * urgency class (3 waiting, 2 failed, 1 working); undefined when nothing needs attention.
 */
export function nextNeedingAttention(order: readonly string[], urgency: ReadonlyMap<string, number>, afterId?: string): string | undefined {
  let top = 0;
  for (const id of order) top = Math.max(top, urgency.get(id) ?? 0);
  if (top === 0) return undefined;
  const start = afterId ? order.indexOf(afterId) + 1 : 0;
  for (let i = 0; i < order.length; i++) {
    const id = order[(start + i) % order.length];
    if ((urgency.get(id) ?? 0) === top) return id;
  }
  return undefined;
}
