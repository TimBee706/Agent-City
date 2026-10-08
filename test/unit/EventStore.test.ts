import { describe, expect, it } from 'vitest';
import { EventStore } from '../../src/backend/EventStore';
import { cityFingerprint, buildCityState } from '../../src/backend/cityStateBuilder';
import { diffSessions, sessionsFingerprint } from '../../src/backend/sessionDiff';
import type { AgentEvent } from '../../src/models/AgentEvent';
import { normalizeSession } from '../../src/models/Session';

const ev = (id: string, ts: number, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  id,
  type: 'session.phaseChanged',
  timestamp: ts,
  sessionId: 's-' + id,
  source: 'diff',
  message: id,
  ...extra,
});

describe('EventStore', () => {
  it('keeps the newest N events (ring buffer)', () => {
    const st = new EventStore(3);
    st.add([ev('a', 1000), ev('b', 2000), ev('c', 3000), ev('d', 4000)]);
    expect(st.list().map((e) => e.id)).toEqual(['b', 'c', 'd']);
    st.add([ev('e', 5000), ev('f', 6000)]);
    expect(st.list().map((e) => e.id)).toEqual(['d', 'e', 'f']);
    expect(st.list(2).map((e) => e.id)).toEqual(['e', 'f']);
    expect(st.length).toBe(3);
  });

  it('dedupes by id and by type+session+agent+1s bucket', () => {
    const st = new EventStore(10);
    expect(st.add([ev('a', 1000)])).toHaveLength(1);
    expect(st.add([ev('a', 9000)])).toHaveLength(0); // same id
    expect(st.add([ev('x', 1500, { sessionId: 's-a' })])).toHaveLength(0); // same bucket
    expect(st.add([ev('y', 2500, { sessionId: 's-a' })])).toHaveLength(1); // next bucket
    expect(st.add([ev('z', 1500, { sessionId: 's-a', agentId: 'other' })])).toHaveLength(1);
  });

  it('forgets dedupe keys of evicted events', () => {
    const st = new EventStore(1);
    st.add([ev('a', 1000)]);
    st.add([ev('b', 2000)]);
    expect(st.add([ev('a', 1000)])).toHaveLength(1);
  });

  it('clear() resets', () => {
    const st = new EventStore(2);
    st.add([ev('a', 1)]);
    st.clear();
    expect(st.list()).toEqual([]);
    expect(st.add([ev('a', 1)])).toHaveLength(1);
  });

  it('rejects invalid capacity', () => {
    expect(() => new EventStore(0)).toThrow();
  });
});

describe('diffSessions / change detection', () => {
  const s = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    normalizeSession({ sessionId: id, cwd: '/r', status, name: id, ...extra })!;

  it('synthesizes appeared, phase changed and disappeared events', () => {
    const first = diffSessions(undefined, [s('a', 'busy'), s('b', 'idle')], 100);
    expect(first.map((e) => e.type)).toEqual(['session.appeared', 'session.appeared']);

    const second = diffSessions([s('a', 'busy'), s('b', 'idle')], [s('a', 'waiting'), s('c', 'busy')], 200);
    expect(second.map((e) => [e.type, e.sessionId])).toEqual([
      ['session.phaseChanged', 'a'],
      ['session.appeared', 'c'],
      ['session.disappeared', 'b'],
    ]);
    expect(second[0]).toMatchObject({ from: 'working', to: 'waiting', agentId: 'a:main' });
  });

  it('emits nothing when nothing changed', () => {
    expect(diffSessions([s('a', 'busy')], [s('a', 'busy')], 1)).toEqual([]);
  });

  it('fingerprints are order independent and ignore volatile fields', () => {
    expect(sessionsFingerprint([s('a', 'busy'), s('b', 'idle')])).toBe(sessionsFingerprint([s('b', 'idle'), s('a', 'busy')]));
    const base = { workspaces: [], events: [], source: 'live' as const };
    const f1 = cityFingerprint(buildCityState({ ...base, sessions: [s('a', 'busy')], now: 1 }));
    const f2 = cityFingerprint(buildCityState({ ...base, sessions: [s('a', 'busy')], now: 999, events: [ev('q', 5)] }));
    const f3 = cityFingerprint(buildCityState({ ...base, sessions: [s('a', 'idle')], now: 1 }));
    expect(f1).toBe(f2);
    expect(f1).not.toBe(f3);
  });
});
