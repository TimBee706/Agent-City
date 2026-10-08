/**
 * Pure facade model of a city building (level 1): floors, one window per live / recent session,
 * archive boxes ("dots") in the basement strip and status counts. No DOM / React, unit-tested.
 */
import type { Session, SessionPhase } from '../models/Session';
import { isArchived, isHistory, isRecent, sessionLabel, sessionPhase } from '../models/Session';
import { fnv1a } from '../util/hash';
import { PHASE_LABEL } from './format';

export const FACADE = {
  /** Windows per floor: two on each visible face. */
  PER_FLOOR: 4,
  MAX_FLOORS: 6,
  /** Archive boxes drawn in the basement strip before "+N". */
  MAX_DOTS: 12,
  FLOOR_H: 24,
  BASE_H: 14,
  /** Flat roof parapet height (office buildings, 3+ floors). */
  ROOF_H: 6,
  /** Gable height of the pitched roof (houses with 1-2 floors). */
  GABLE_H: 26,
  /** Houses up to this many floors get a pitched roof. */
  GABLE_MAX_FLOORS: 2,
  PALETTES: 8,
} as const;

/** Window light per phase (CSS class `win--<tone>`). */
export type WindowTone = 'working' | 'waiting' | 'idle' | 'resting' | 'done' | 'failed' | 'stopped';

export function windowTone(p: SessionPhase): WindowTone {
  switch (p) {
    case 'working':
    case 'waiting':
    case 'done':
    case 'failed':
    case 'stopped':
    case 'resting':
      return p;
    case 'archived':
      return 'resting';
    default:
      return 'idle';
  }
}

/** Room order inside a building: live sessions by urgency, then recent ones (newest first). */
const PRIORITY: Record<SessionPhase, number> = {
  waiting: 0,
  working: 1,
  failed: 2,
  idle: 3,
  unknown: 3,
  done: 4,
  stopped: 5,
  resting: 6,
  archived: 7,
};

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Live (by phase priority, then start time) followed by recent (newest first). Archived excluded. */
export function orderRoomSessions<S extends Session>(sessions: readonly S[]): S[] {
  const live = sessions
    .filter((s) => !isHistory(s))
    .map((s) => ({ s, p: PRIORITY[sessionPhase(s)] }))
    .sort((a, b) => a.p - b.p || (a.s.startedAt ?? 0) - (b.s.startedAt ?? 0) || byString(a.s.id, b.s.id))
    .map((x) => x.s);
  const recent = sessions
    .filter((s) => isRecent(s))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || byString(a.id, b.id));
  return [...live, ...recent];
}

export interface FacadeWindow {
  sessionId: string;
  tone: WindowTone;
  /** Tooltip text (plain text, rendered by React). */
  label: string;
  face: 'left' | 'right';
  floor: number;
  /** 0 or 1: position on the face. */
  slot: number;
}

export interface FacadeModel {
  floors: number;
  windows: FacadeWindow[];
  /** Live / recent sessions without a visible window (incl. recent overflow): "+N". */
  hiddenWindows: number;
  live: number;
  working: number;
  waiting: number;
  failed: number;
  /** Recent sessions incl. those over the room limit. */
  recent: number;
  /** Archived sessions incl. overflow (what the basement holds). */
  archived: number;
  dots: number;
  dotsOverflow: number;
  /** No sessions at all: closed shutters. */
  quiet: boolean;
  /** Pitched (toy house) or flat (office) roof. */
  roof: 'gable' | 'flat';
  /** Height of the walls' top edge (basement + floors) in px. */
  wallTopPx: number;
  /** Total height incl. roof in px. */
  heightPx: number;
}

export interface FacadeWorkspace {
  recentOverflow?: number;
  archivedOverflow?: number;
}

export function computeFacade(sessions: readonly Session[], ws: FacadeWorkspace): FacadeModel {
  const rooms = orderRoomSessions(sessions);
  const recentOverflow = Math.max(0, Math.floor(ws.recentOverflow ?? 0));
  const archivedOverflow = Math.max(0, Math.floor(ws.archivedOverflow ?? 0));
  const floors = Math.min(FACADE.MAX_FLOORS, Math.max(1, Math.ceil(rooms.length / FACADE.PER_FLOOR)));
  const capacity = floors * FACADE.PER_FLOOR;
  const windows: FacadeWindow[] = rooms.slice(0, capacity).map((s, i) => {
    const k = i % FACADE.PER_FLOOR;
    const p = sessionPhase(s);
    return {
      sessionId: s.id,
      tone: windowTone(p),
      label: `${sessionLabel(s)}: ${PHASE_LABEL[p]}`,
      face: k % 2 === 0 ? 'left' : 'right',
      floor: Math.floor(i / FACADE.PER_FLOOR),
      slot: k < 2 ? 0 : 1,
    };
  });
  let live = 0;
  let working = 0;
  let waiting = 0;
  let failed = 0;
  for (const s of sessions) {
    if (isHistory(s)) continue;
    live++;
    const p = sessionPhase(s);
    if (p === 'working') working++;
    else if (p === 'waiting') waiting++;
    else if (p === 'failed') failed++;
  }
  const recent = sessions.filter(isRecent).length + recentOverflow;
  const archived = sessions.filter(isArchived).length + archivedOverflow;
  const dots = Math.min(FACADE.MAX_DOTS, archived);
  return {
    floors,
    windows,
    hiddenWindows: Math.max(0, rooms.length - capacity) + recentOverflow,
    live,
    working,
    waiting,
    failed,
    recent,
    archived,
    dots,
    dotsOverflow: archived - dots,
    quiet: sessions.length === 0 && recentOverflow === 0 && archivedOverflow === 0,
    roof: floors <= FACADE.GABLE_MAX_FLOORS ? 'gable' : 'flat',
    wallTopPx: FACADE.BASE_H + floors * FACADE.FLOOR_H,
    heightPx: FACADE.BASE_H + floors * FACADE.FLOOR_H + (floors <= FACADE.GABLE_MAX_FLOORS ? FACADE.GABLE_H : FACADE.ROOF_H),
  };
}

/** Deterministic colour palette (0..7) for a workspace id. */
export function paletteFor(workspaceId: string): number {
  return parseInt(fnv1a(workspaceId).slice(0, 6), 16) % FACADE.PALETTES;
}

/** Accessible summary of a building (aria-label / tooltip). */
export function buildingSummary(
  name: string,
  f: Pick<FacadeModel, 'live' | 'working' | 'waiting' | 'failed' | 'recent' | 'archived'>,
  flags: { open?: boolean; missing?: boolean } = {},
): string {
  const parts = [`${f.live} live session${f.live === 1 ? '' : 's'}`];
  if (f.working) parts.push(`${f.working} working`);
  if (f.waiting) parts.push(`${f.waiting} waiting for input`);
  if (f.failed) parts.push(`${f.failed} failed`);
  parts.push(`${f.recent} recent`, `${f.archived} archived in the basement`);
  return `${name}${flags.open ? ' (open in VS Code)' : ''}${flags.missing ? ' (folder not found)' : ''}: ${parts.join(', ')}`;
}
