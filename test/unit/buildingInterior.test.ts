import { describe, expect, it } from 'vitest';
import { BI, Box, basementItems, computeInterior, deskPositions, interiorColumns } from '../../src/webview/buildingInterior';
import type { HistorySummary } from '../../src/models/CityState';
import type { Session } from '../../src/models/Session';

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

const rooms = (live: number, recent: number) => [
  ...Array.from({ length: live }, (_, i) => ({ id: `l${i}`, tier: 'live' as const })),
  ...Array.from({ length: recent }, (_, i) => ({ id: `r${i}`, tier: 'recent' as const })),
];
const archived = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, title: `old ${i}` }));

function checkGeometry(l: ReturnType<typeof computeInterior>) {
  expect(l.width).toBeGreaterThan(0);
  for (const r of l.rooms) {
    expect(inside(r, l.building)).toBe(true);
    expect(r.y + r.height).toBeLessThanOrEqual(l.lobby.y);
    expect(overlaps(r, l.elevator)).toBe(false);
    for (const d of r.desks) {
      expect(d.x).toBeGreaterThan(r.x);
      expect(d.x).toBeLessThan(r.x + r.width);
    }
  }
  const all: Box[] = [...l.rooms, ...l.basement.boxes];
  for (let i = 0; i < all.length; i++) for (let k = i + 1; k < all.length; k++) expect(overlaps(all[i], all[k])).toBe(false);
  for (const b of l.basement.boxes) {
    expect(inside(b, l.basement)).toBe(true);
    expect(b.y).toBeGreaterThan(l.groundY);
  }
  expect(l.basement.y + l.basement.height).toBeLessThanOrEqual(l.height);
  // the elevator connects the top floor with the basement
  expect(l.elevator.y).toBeLessThanOrEqual(Math.min(...l.rooms.map((r) => r.y), l.lobby.y));
  expect(l.elevator.y + l.elevator.height).toBeGreaterThanOrEqual(l.basement.y + l.basement.height - 1);
}

describe('building interior layout', () => {
  it('columns', () => {
    expect([0, 1, 2, 4, 5, 9, 10, 40].map(interiorColumns)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(deskPositions(5, { x: 0, y: 0, width: 200, height: 100 })).toHaveLength(BI.MAX_DESKS);
  });

  it('0 sessions: one empty office floor, empty basement', () => {
    const l = computeInterior({ rooms: [], agents: [], archived: [], archivedTotal: 0, recentOverflow: 0 });
    expect(l.rooms).toEqual([]);
    expect(l.floors).toBe(1);
    expect(l.emptyRoom).toBeDefined();
    expect(l.basement.boxes).toEqual([]);
    expect(l.basement.rows).toBe(1);
    expect(l.basement.overflow).toBe(0);
    expect(l.moreDoor).toBeUndefined();
    checkGeometry(l);
  });

  it('1 live session with main agent + 4 subagents: main first, desk overflow, entrance at the elevator', () => {
    const agents = [
      { agentId: 'l0:z', parentSessionId: 'l0', role: 'subagent' as const },
      { agentId: 'l0:main', parentSessionId: 'l0', role: 'main' as const },
      ...[1, 2, 3].map((i) => ({ agentId: `l0:s${i}`, parentSessionId: 'l0', role: 'subagent' as const })),
    ];
    const l = computeInterior({ rooms: rooms(1, 0), agents, archived: [], archivedTotal: 0, recentOverflow: 0 });
    const r = l.rooms[0];
    expect(r).toMatchObject({ floor: 1, col: 0, tier: 'live' });
    expect(r.desks[0].agentId).toBe('l0:main');
    expect(r.desks).toHaveLength(BI.MAX_DESKS);
    expect(r.overflow).toBe(5 - BI.MAX_DESKS);
    expect(r.entrance.x).toBe(l.elevator.x + l.elevator.width);
    expect(r.entrance.x).toBeLessThan(r.x);
    checkGeometry(l);
  });

  it('40 recent sessions: 4 columns, 10 floors, lowest floors first, recent rooms have no desks; +N recent door', () => {
    const l = computeInterior({
      rooms: rooms(2, 40),
      agents: [{ agentId: 'r0:main', parentSessionId: 'r0', role: 'main' }],
      archived: [],
      archivedTotal: 0,
      recentOverflow: 7,
    });
    expect(l.cols).toBe(4);
    expect(l.floors).toBe(Math.ceil(42 / 4));
    expect(l.rooms[0]).toMatchObject({ sessionId: 'l0', floor: 1 });
    expect(l.rooms[41].floor).toBe(l.floors);
    expect(l.rooms[0].y).toBeGreaterThan(l.rooms[41].y); // floor 1 is lower on screen
    expect(l.rooms.filter((r) => r.tier === 'recent').every((r) => r.desks.length === 0)).toBe(true);
    expect(l.moreDoor).toMatchObject({ count: 7 });
    expect(inside(l.moreDoor!, l.lobby)).toBe(true);
    checkGeometry(l);
  });

  it('200 archived sessions: 60 boxes on shelves, "+140", newest first, deterministic', () => {
    const input = { rooms: rooms(1, 1), agents: [], archived: archived(200), archivedTotal: 200, recentOverflow: 0 };
    const l = computeInterior(input);
    expect(l.basement.boxes).toHaveLength(BI.MAX_BOXES);
    expect(l.basement.boxes.map((b) => b.id).slice(0, 3)).toEqual(['a0', 'a1', 'a2']);
    expect(l.basement.overflow).toBe(140);
    expect(l.basement.total).toBe(200);
    expect(l.basement.rows).toBe(Math.ceil(BI.MAX_BOXES / l.basement.perRow));
    expect(new Set(l.basement.boxes.map((b) => b.shelf)).size).toBe(l.basement.rows);
    expect(computeInterior(input)).toEqual(l);
    checkGeometry(l);
  });

  it('basement items: archived rooms + history index (deduped, newest first); index ignored when narrowed', () => {
    const room = (n: number, t: number): Session => ({
      id: `room${n}`,
      sessionId: `id-${n}`,
      kind: 'history',
      state: 'unknown',
      status: 'unknown',
      origin: 'history',
      tier: 'archived',
      lastActivityAt: t,
      name: `Room ${n}`,
    });
    const history: HistorySummary[] = [
      { id: 'id-1', title: 'Room 1', lastActivityAt: 50, tier: 'archived' },
      { id: 'id-9', title: 'Old', lastActivityAt: 10, tier: 'archived' },
      { id: 'id-8', lastActivityAt: 70, tier: 'archived' },
      { id: 'id-7', title: 'recent overflow', lastActivityAt: 99, tier: 'recent' },
    ];
    expect(basementItems([room(1, 50), room(2, 60)], history, true)).toEqual([
      { id: 'id-8', title: 'session id-8' },
      { id: 'id-2', title: 'Room 2', roomId: 'room2' },
      { id: 'id-1', title: 'Room 1', roomId: 'room1' },
      { id: 'id-9', title: 'Old' },
    ]);
    expect(basementItems([room(1, 50)], history, false)).toEqual([{ id: 'id-1', title: 'Room 1', roomId: 'room1' }]);
  });
});
