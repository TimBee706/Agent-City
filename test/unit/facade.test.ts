import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/models/Session';
import { normalizeSession } from '../../src/models/Session';
import { FACADE, buildingSummary, computeFacade, orderRoomSessions, paletteFor, windowTone } from '../../src/webview/facade';

const DAY = 86_400_000;
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const live = (sid: string, raw: Record<string, unknown>, startedAt = 1000): Session => ({
  ...normalizeSession({ sessionId: sid, cwd: 'C:\\w', startedAt, ...raw })!,
  workspaceId: 'w',
});
const hist = (n: number, tier: 'recent' | 'archived', age = n * DAY): Session => ({
  id: id(n),
  sessionId: id(n),
  kind: 'history',
  state: 'unknown',
  status: 'unknown',
  origin: 'history',
  tier,
  lastActivityAt: 10_000 * DAY - age,
  workspaceId: 'w',
});

describe('facade: windows, floors and basement dots', () => {
  it('maps phases to window colours', () => {
    expect(windowTone('working')).toBe('working');
    expect(windowTone('waiting')).toBe('waiting');
    expect(windowTone('idle')).toBe('idle');
    expect(windowTone('unknown')).toBe('idle');
    expect(windowTone('resting')).toBe('resting');
    expect(windowTone('failed')).toBe('failed');
    expect(windowTone('done')).toBe('done');
    expect(windowTone('stopped')).toBe('stopped');
  });

  it('one window per live / recent session: live by urgency first, then recent newest first', () => {
    const sessions = [
      live('idle', { status: 'idle' }, 1),
      live('busy', { status: 'busy' }, 2),
      live('wait', { status: 'waiting' }, 3),
      live('fail', { state: 'failed' }, 4),
      hist(1, 'recent', 3 * DAY),
      hist(2, 'recent', 1 * DAY),
      hist(3, 'archived'),
    ];
    expect(orderRoomSessions(sessions).map((s) => s.id)).toEqual(['wait', 'busy', 'fail', 'idle', id(2), id(1)]);
    const f = computeFacade(sessions, {});
    expect(f.windows.map((w) => [w.sessionId, w.tone])).toEqual([
      ['wait', 'waiting'],
      ['busy', 'working'],
      ['fail', 'failed'],
      ['idle', 'idle'],
      [id(2), 'resting'],
      [id(1), 'resting'],
    ]);
    // 4 windows per floor, alternating faces, filled from the ground up
    expect(f.floors).toBe(2);
    expect(f.windows.map((w) => `${w.floor}${w.face[0]}${w.slot}`)).toEqual(['0l0', '0r0', '0l1', '0r1', '1l0', '1r0']);
    expect(f).toMatchObject({ live: 4, working: 1, waiting: 1, failed: 1, recent: 2, archived: 1, dots: 1, dotsOverflow: 0, hiddenWindows: 0 });
    expect(f.quiet).toBe(false);
    expect(f.windows[0].label).toContain('waiting for input');
  });

  it('caps floors and reports hidden windows (+N) incl. recent overflow', () => {
    const many = Array.from({ length: 40 }, (_, i) => hist(i + 1, 'recent'));
    const f = computeFacade(many, { recentOverflow: 5 });
    expect(f.floors).toBe(FACADE.MAX_FLOORS);
    expect(f.windows).toHaveLength(FACADE.MAX_FLOORS * FACADE.PER_FLOOR);
    expect(f.hiddenWindows).toBe(40 - 24 + 5);
    expect(f.recent).toBe(45);
    expect(f.roof).toBe('flat');
    expect(f.heightPx).toBe(FACADE.BASE_H + 6 * FACADE.FLOOR_H + FACADE.ROOF_H);
  });

  it('archived sessions become basement dots: up to 12, then "+N" (overflow counted)', () => {
    const seven = Array.from({ length: 7 }, (_, i) => hist(i + 1, 'archived'));
    expect(computeFacade(seven, {})).toMatchObject({ archived: 7, dots: 7, dotsOverflow: 0, floors: 1, roof: 'gable' });
    const f = computeFacade(seven, { archivedOverflow: 193 });
    expect(f).toMatchObject({ archived: 200, dots: FACADE.MAX_DOTS, dotsOverflow: 188 });
    expect(f.windows).toEqual([]);
  });

  it('empty building: one floor, shutters (quiet), pitched roof', () => {
    const f = computeFacade([], {});
    expect(f).toMatchObject({ floors: 1, quiet: true, live: 0, recent: 0, archived: 0, dots: 0, roof: 'gable' });
    expect(f.heightPx).toBe(FACADE.BASE_H + FACADE.FLOOR_H + FACADE.GABLE_H);
    expect(computeFacade([], { recentOverflow: 2 }).quiet).toBe(false);
  });

  it('palette is deterministic and within range; summary mentions all tiers', () => {
    const p = paletteFor('workspace-1');
    expect(paletteFor('workspace-1')).toBe(p);
    const all = new Set(Array.from({ length: 200 }, (_, i) => paletteFor(`ws-${i}`)));
    expect([...all].every((x) => x >= 0 && x < FACADE.PALETTES)).toBe(true);
    expect(all.size).toBe(FACADE.PALETTES);
    const s = buildingSummary('Wardow', computeFacade(Array.from({ length: 7 }, (_, i) => hist(i + 1, 'archived')), {}), { open: true });
    expect(s).toBe('Wardow (open in VS Code): 0 live sessions, 0 recent, 7 archived in the basement');
  });
});
