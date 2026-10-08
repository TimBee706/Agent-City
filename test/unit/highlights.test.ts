import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/models/AgentEvent';
import { normalizeSession } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import {
  announcementFor,
  combineAnnouncements,
  computeHighlights,
  dayPeriod,
  sparkleTargets,
} from '../../src/webview/highlights';

const s = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  ...normalizeSession({ sessionId: id, status, cwd: 'C:\\x', name: id })!,
  ...extra,
});
const ws = (id: string, name: string, ids: string[]): CityWorkspace => ({
  id, name, path: '', firstSeen: 0, lastSeen: 0, source: 'session', pinned: false, open: false, sessionIds: ids,
});

describe('highlights', () => {
  it('computes most active company, attention list (hook attention first) and counts', () => {
    const sessions = [s('a', 'busy'), s('b', 'busy'), s('c', 'waiting'), s('d', 'idle', { attention: 'Bash wants to run' }), s('e', 'idle')];
    const h = computeHighlights({
      workspaces: [ws('w1', 'one', ['a']), ws('w2', 'two', ['b', 'c']), ws('w3', 'three', ['d', 'e'])],
      sessions,
      stats: { tasksCompletedToday: 4 },
    });
    expect(h.mostActive).toEqual({ id: 'w2', name: 'two', active: 2 });
    expect(h.attention.map((x) => x.id)).toEqual(['d', 'c']);
    expect(h.working).toBe(2);
    expect(h.idle).toBe(1);
    expect(h.completedToday).toBe(4);
    expect(computeHighlights({ workspaces: [], sessions: [] }).mostActive).toBeUndefined();
  });

  it('dayPeriod', () => {
    expect([0, 6, 9, 16, 17, 21, 23].map(dayPeriod)).toEqual(['night', 'dawn', 'day', 'day', 'dusk', 'night', 'night']);
  });

  it('announcements only for important events, combined when many', () => {
    const base: AgentEvent = { id: '1', type: 'notification', timestamp: 0, sessionId: 'a', source: 'hook', message: 'Needs attention: x' };
    const sessions = [s('a', 'busy')];
    expect(announcementFor(base, sessions)).toBe('a needs your attention');
    expect(announcementFor({ ...base, type: 'task-completed', message: 'Task completed: T' }, sessions)).toBe('a: Task completed: T');
    expect(announcementFor({ ...base, type: 'tool-use' }, sessions)).toBeUndefined();
    expect(announcementFor({ ...base, type: 'session.phaseChanged', to: 'idle' }, sessions)).toBeUndefined();
    expect(announcementFor({ ...base, type: 'session.phaseChanged', to: 'failed', sessionId: 'zzzzzzzzzz' }, [])).toBe(
      'session zzzzzzzz is now failed',
    );
    expect(combineAnnouncements([])).toBe('');
    expect(combineAnnouncements(['x', 'y'])).toBe('x. y');
    expect(combineAnnouncements(['x', 'y', 'z'])).toBe('z, and 2 more updates');
  });

  it('sparkleTargets', () => {
    const e: AgentEvent = { id: '1', type: 'task-completed', timestamp: 0, sessionId: 'a', agentId: 'a:main', source: 'hook', message: '' };
    expect(sparkleTargets([e, { ...e, type: 'stop' }])).toEqual(['a:main']);
  });
});
