import { describe, expect, it } from 'vitest';
import { characterStateFor, mainAgentForSession } from '../../src/models/Agent';
import { normalizeSession, normalizeState, normalizeStatus, parseTimestamp, sessionPhase } from '../../src/models/Session';

describe('parseTimestamp', () => {
  it('accepts ms, seconds, numeric strings and ISO strings', () => {
    expect(parseTimestamp(1791452102248)).toBe(1791452102248);
    expect(parseTimestamp(1791452102)).toBe(1791452102000);
    expect(parseTimestamp(1791452102.5)).toBe(1791452102500);
    expect(parseTimestamp('1791452102248')).toBe(1791452102248);
    expect(parseTimestamp('1791452102')).toBe(1791452102000);
    expect(parseTimestamp('2026-10-08T10:00:00.000Z')).toBe(Date.UTC(2026, 9, 8, 10));
  });
  it('rejects invalid values', () => {
    for (const v of [undefined, null, '', 'yesterday', 0, -5, NaN, Infinity, {}, []]) expect(parseTimestamp(v)).toBeUndefined();
  });
});

describe('normalizeSession', () => {
  it('handles missing metadata gracefully', () => {
    const s = normalizeSession({ cwd: '/repo' })!;
    expect(s.kind).toBe('unknown');
    expect(s.state).toBe('unknown');
    expect(s.status).toBe('unknown');
    expect(s.name).toBeUndefined();
    expect(s.id).toMatch(/^h[0-9a-f]{16}$/);
  });

  it('uses sessionId, then id, then a stable hash', () => {
    expect(normalizeSession({ sessionId: 'S', id: 'I' })!.id).toBe('S');
    expect(normalizeSession({ id: 'I', cwd: '/x' })!.id).toBe('I');
    const a = normalizeSession({ cwd: '/x', startedAt: 1, pid: 3 })!.id;
    const b = normalizeSession({ pid: 3, startedAt: 1, cwd: '/x' })!.id;
    const c = normalizeSession({ cwd: '/x', startedAt: 1, pid: 4 })!.id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('returns undefined without any identity', () => {
    expect(normalizeSession({ name: 'x', status: 'busy' })).toBeUndefined();
    expect(normalizeSession(null)).toBeUndefined();
    expect(normalizeSession([1])).toBeUndefined();
  });

  it('coerces types and limits text', () => {
    const s = normalizeSession({ sessionId: 'a', pid: '123', name: 'x'.repeat(1000), cwd: 5, waitingFor: { type: 'permission' } })!;
    expect(s.pid).toBe(123);
    expect(s.name!.length).toBe(300);
    expect(s.cwd).toBe('5');
    expect(s.waitingFor).toBe('permission');
  });

  it('maps state and status vocabularies', () => {
    expect(normalizeState('Running')).toBe('working');
    expect(normalizeState('needs-input')).toBe('blocked');
    expect(normalizeState('completed')).toBe('done');
    expect(normalizeState('errored')).toBe('failed');
    expect(normalizeState('killed')).toBe('stopped');
    expect(normalizeState('weird')).toBe('unknown');
    expect(normalizeStatus('busy')).toBe('busy');
    expect(normalizeStatus('waiting')).toBe('waiting');
    expect(normalizeStatus('idle')).toBe('idle');
    expect(normalizeStatus(undefined)).toBe('unknown');
  });
});

describe('sessionPhase + character state mapping', () => {
  const cases: [string | undefined, string | undefined, string | undefined, string, string][] = [
    // rawState, rawStatus, waitingFor, phase, characterState
    [undefined, 'busy', undefined, 'working', 'busy'],
    [undefined, 'idle', undefined, 'idle', 'idle'],
    [undefined, 'waiting', undefined, 'waiting', 'blocked'],
    ['working', undefined, undefined, 'working', 'working'],
    ['working', 'busy', undefined, 'working', 'busy'],
    ['working', 'idle', undefined, 'idle', 'idle'],
    ['blocked', 'busy', undefined, 'waiting', 'blocked'],
    [undefined, undefined, 'permission', 'waiting', 'blocked'],
    ['done', 'busy', undefined, 'done', 'done'],
    ['failed', undefined, undefined, 'failed', 'failed'],
    ['stopped', undefined, undefined, 'stopped', 'stopped'],
    [undefined, undefined, undefined, 'unknown', 'idle'],
  ];
  it.each(cases)('state=%s status=%s waitingFor=%s -> %s / %s', (state, status, waitingFor, phase, charState) => {
    const s = normalizeSession({ sessionId: 'x', state, status, waitingFor })!;
    expect(sessionPhase(s)).toBe(phase);
    expect(characterStateFor(sessionPhase(s), s.status)).toBe(charState);
    expect(mainAgentForSession(s).characterState).toBe(charState);
  });

  it('builds a main agent with subagent-ready fields', () => {
    const a = mainAgentForSession({ ...normalizeSession({ sessionId: 's1', name: 'n', status: 'busy' })!, workspaceId: 'w1' });
    expect(a).toMatchObject({ agentId: 's1:main', agentType: 'main', role: 'main', parentSessionId: 's1', workspaceId: 'w1', name: 'n' });
  });
});
