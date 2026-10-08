import type { HistorySummary } from '../models/CityState';
import type { Session } from '../models/Session';
import { isArchived, isRecent, sessionLabel } from '../models/Session';
import { FacadeWorkspace, computeFacade, orderRoomSessions } from './facade';

/**
 * Pure, deterministic layout of the building view (level 2): a cut-away side view ("doll house")
 * with a lobby on the ground floor, office floors with one room per live / recent session, an
 * elevator shaft and a basement with shelves of archive boxes. No DOM / React, unit-tested.
 */

export const BI = {
  ROOM_W: 196,
  ROOM_H: 122,
  GAP: 8,
  WALL: 14,
  ELEV_W: 48,
  SLAB: 9,
  LOBBY_H: 92,
  ROOF_H: 64,
  /** Street / sky margin left and right of the building. */
  SIDE: 90,
  /** Sky above the roof. */
  SKY: 40,
  MAX_COLS: 4,
  MAX_DESKS: 3,
  BOX_W: 26,
  BOX_H: 20,
  BOX_GAP: 7,
  SHELF_H: 38,
  BASE_HEAD: 30,
  BASE_PAD: 16,
  MAX_BOXES: 60,
  /** Soil below the basement. */
  EARTH: 36,
} as const;

export interface InteriorSession {
  id: string;
  /** Live sessions first, then recent (history) ones - the caller passes them in room order. */
  tier: 'live' | 'recent';
}
export interface InteriorAgent {
  agentId: string;
  parentSessionId: string;
  role: 'main' | 'subagent';
}
export interface InteriorArchived {
  /** Claude session id. */
  id: string;
  title: string;
  /** City session id if this archived session is also a room in the state (selectable as a session). */
  roomId?: string;
}
export interface InteriorInput {
  rooms: readonly InteriorSession[];
  agents: readonly InteriorAgent[];
  /** Archived sessions, newest first (may be longer than what is drawn). */
  archived: readonly InteriorArchived[];
  /** Total archived sessions of the workspace (>= archived.length). */
  archivedTotal: number;
  /** Recent sessions over the room limit ("+N recent" door in the lobby). */
  recentOverflow: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface InteriorDesk {
  agentId: string;
  x: number;
  y: number;
}
export interface InteriorRoom extends Box {
  sessionId: string;
  tier: 'live' | 'recent';
  /** 1 = first floor above the lobby. */
  floor: number;
  col: number;
  desks: InteriorDesk[];
  /** Agents without a desk ("+N"). */
  overflow: number;
  /** Elevator door on this floor relative to nothing - absolute point where walkers come from. */
  entrance: { x: number; y: number };
}
export interface InteriorBox extends Box {
  id: string;
  roomId?: string;
  title: string;
  shelf: number;
}
export interface InteriorLayout {
  width: number;
  height: number;
  groundY: number;
  cols: number;
  floors: number;
  building: Box;
  roof: Box;
  lobby: Box;
  door: Box;
  /** "+N recent" door in the lobby (only with recent overflow). */
  moreDoor?: Box & { count: number };
  elevator: Box;
  /** Floor slabs (top edge y) incl. the lobby ceiling. */
  slabs: number[];
  rooms: InteriorRoom[];
  /** Placeholder room when there are no live / recent sessions. */
  emptyRoom?: Box;
  basement: Box & { perRow: number; rows: number; shelves: Box[]; boxes: InteriorBox[]; overflow: number; total: number };
}

/** Room columns: 1 -> 1, 2..4 -> 2, 5..9 -> 3, 10+ -> 4. */
export function interiorColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return BI.MAX_COLS;
}

/** Desk anchors (character feet) spread evenly along the room floor. */
export function deskPositions(count: number, room: Box, max: number = BI.MAX_DESKS): { x: number; y: number }[] {
  const n = Math.min(count, max);
  const out: { x: number; y: number }[] = [];
  const floorY = room.y + room.height - 10;
  for (let i = 0; i < n; i++) out.push({ x: Math.round(room.x + (room.width * (i + 1)) / (n + 1)) + 6, y: floorY });
  return out;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeInterior(input: InteriorInput): InteriorLayout {
  const n = input.rooms.length;
  const cols = Math.max(2, interiorColumns(n));
  const floors = Math.max(1, Math.ceil(n / cols));
  const innerW = cols * BI.ROOM_W + (cols - 1) * BI.GAP;
  const bodyW = BI.WALL * 2 + BI.ELEV_W + BI.GAP + innerW;
  const x0 = BI.SIDE;
  const roomsX = x0 + BI.WALL + BI.ELEV_W + BI.GAP;
  const floorsTop = BI.SKY + BI.ROOF_H;
  const floorTop = (floor: number) => floorsTop + (floors - floor) * (BI.ROOM_H + BI.SLAB) + BI.SLAB;
  const lobbyY = floorsTop + floors * (BI.ROOM_H + BI.SLAB) + BI.SLAB;
  const groundY = lobbyY + BI.LOBBY_H;

  // agents per session: main first, then subagents by id
  const bySession = new Map<string, InteriorAgent[]>();
  for (const a of input.agents) {
    const list = bySession.get(a.parentSessionId) ?? [];
    list.push(a);
    bySession.set(a.parentSessionId, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => (a.role === b.role ? byString(a.agentId, b.agentId) : a.role === 'main' ? -1 : 1));

  const elevatorX = x0 + BI.WALL;
  const rooms: InteriorRoom[] = input.rooms.map((s, i) => {
    const floor = 1 + Math.floor(i / cols); // lowest floors first (closest to the entrance)
    const col = i % cols;
    const room = { x: roomsX + col * (BI.ROOM_W + BI.GAP), y: floorTop(floor), width: BI.ROOM_W, height: BI.ROOM_H };
    const agents = s.tier === 'live' ? (bySession.get(s.id) ?? []) : [];
    const desks = deskPositions(agents.length, room).map((p, k) => ({ agentId: agents[k].agentId, ...p }));
    return {
      sessionId: s.id,
      tier: s.tier,
      floor,
      col,
      ...room,
      desks,
      overflow: Math.max(0, agents.length - BI.MAX_DESKS),
      entrance: { x: elevatorX + BI.ELEV_W, y: room.y + room.height - 10 },
    };
  });

  // basement shelves with archive boxes
  const basementY = groundY + BI.SLAB;
  const perRow = Math.max(1, Math.floor((innerW - 2 * BI.BASE_PAD + BI.BOX_GAP) / (BI.BOX_W + BI.BOX_GAP)));
  const visible = Math.min(BI.MAX_BOXES, input.archived.length);
  const rows = Math.max(1, Math.ceil(visible / perRow));
  const basementH = BI.BASE_HEAD + rows * BI.SHELF_H + BI.BASE_PAD;
  const shelves: Box[] = [];
  for (let r = 0; r < rows; r++) {
    shelves.push({ x: roomsX + BI.BASE_PAD - 6, y: basementY + BI.BASE_HEAD + (r + 1) * BI.SHELF_H - 6, width: innerW - 2 * BI.BASE_PAD + 12, height: 5 });
  }
  const boxes: InteriorBox[] = input.archived.slice(0, visible).map((a, i) => {
    const shelf = Math.floor(i / perRow);
    const c = i % perRow;
    const box: InteriorBox = {
      id: a.id,
      title: a.title,
      shelf,
      x: roomsX + BI.BASE_PAD + c * (BI.BOX_W + BI.BOX_GAP),
      y: shelves[shelf].y - BI.BOX_H,
      width: BI.BOX_W,
      height: BI.BOX_H,
    };
    if (a.roomId) box.roomId = a.roomId;
    return box;
  });
  const total = Math.max(input.archivedTotal, input.archived.length);

  const height = basementY + basementH + BI.EARTH;
  const layout: InteriorLayout = {
    width: bodyW + 2 * BI.SIDE,
    height,
    groundY,
    cols,
    floors,
    building: { x: x0, y: floorsTop, width: bodyW, height: groundY - floorsTop },
    roof: { x: x0 - 12, y: BI.SKY, width: bodyW + 24, height: BI.ROOF_H },
    lobby: { x: roomsX, y: lobbyY, width: innerW, height: BI.LOBBY_H },
    door: { x: roomsX + innerW / 2 - 22, y: groundY - 58, width: 44, height: 58 },
    elevator: { x: elevatorX, y: floorTop(floors), width: BI.ELEV_W, height: basementY + basementH - floorTop(floors) },
    slabs: Array.from({ length: floors + 1 }, (_, k) => floorsTop + k * (BI.ROOM_H + BI.SLAB)),
    rooms,
    basement: {
      x: x0,
      y: basementY,
      width: bodyW,
      height: basementH,
      perRow,
      rows,
      shelves,
      boxes,
      overflow: Math.max(0, total - visible),
      total,
    },
  };
  if (n === 0) layout.emptyRoom = { x: roomsX, y: floorTop(1), width: innerW, height: BI.ROOM_H };
  const more = Math.max(0, Math.floor(input.recentOverflow));
  if (more > 0) layout.moreDoor = { x: roomsX + innerW - 70, y: groundY - 54, width: 40, height: 54, count: more };
  return layout;
}

/** Archived sessions for the basement: archived rooms + (when not narrowed by filters) the history index. */
export function basementItems(
  sessions: readonly Session[],
  history: readonly HistorySummary[] | undefined,
  useIndex: boolean,
): InteriorArchived[] {
  const rooms = sessions.filter(isArchived);
  const byClaudeId = new Map(rooms.map((s) => [s.sessionId ?? s.id, s]));
  const out: InteriorArchived[] = [];
  const seen = new Set<string>();
  const items: { id: string; title: string; roomId?: string; t: number }[] = rooms.map((s) => ({
    id: s.sessionId ?? s.id,
    title: sessionLabel(s),
    roomId: s.id,
    t: s.lastActivityAt ?? 0,
  }));
  if (useIndex) {
    for (const h of history ?? []) {
      if (h.tier !== 'archived') continue;
      const room = byClaudeId.get(h.id);
      items.push({ id: h.id, title: h.title ?? `session ${h.id.slice(0, 8)}`, roomId: room?.id, t: h.lastActivityAt });
    }
  }
  items.sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const a: InteriorArchived = { id: it.id, title: it.title };
    if (it.roomId) a.roomId = it.roomId;
    out.push(a);
  }
  return out;
}

/**
 * Everything the building view draws for one workspace: rooms in facade order (live by urgency,
 * then recent), agents at desks and the basement (archived rooms + the history index, unless the
 * archive tier is narrowed by filters - then the workspace has no `archivedOverflow`).
 */
export function interiorFor(
  ws: FacadeWorkspace,
  sessions: readonly Session[],
  agents: readonly InteriorAgent[],
  history?: readonly HistorySummary[],
): { layout: InteriorLayout; rooms: Session[]; archived: InteriorArchived[]; facade: ReturnType<typeof computeFacade> } {
  const facade = computeFacade(sessions, ws);
  const rooms = orderRoomSessions(sessions);
  const archived = basementItems(sessions, history, ws.archivedOverflow !== undefined);
  const layout = computeInterior({
    rooms: rooms.map((s) => ({ id: s.id, tier: isRecent(s) ? 'recent' : 'live' })),
    agents,
    archived,
    archivedTotal: facade.archived,
    recentOverflow: ws.recentOverflow ?? 0,
  });
  return { layout, rooms, archived, facade };
}
