import { describe, expect, it } from 'vitest';
import { extractCwd } from '../../src/backend/HistoricalProjects';
import { DEMO_COMPANY_COUNT, demoSessions } from '../../src/demo/demoData';
import { characterStateFor } from '../../src/models/Agent';
import { computeCounts, summaryText } from '../../src/models/CityState';
import { sessionPhase } from '../../src/models/Session';

describe('demo data', () => {
  it('has >= 3 companies, multiple rooms and varied character states', () => {
    const sessions = demoSessions(0, 1_000_000);
    expect(DEMO_COMPANY_COUNT).toBeGreaterThanOrEqual(3);
    expect(sessions.length).toBeGreaterThanOrEqual(8);
    const states = new Set(sessions.map((s) => characterStateFor(sessionPhase(s), s.status)));
    for (const st of ['busy', 'idle', 'blocked', 'done', 'failed', 'stopped']) expect(states.has(st as never)).toBe(true);
  });

  it('is deterministic per tick and evolves over ticks', () => {
    expect(demoSessions(4, 1_000_000)).toEqual(demoSessions(4, 1_000_000));
    expect(demoSessions(0, 1_000_000)).not.toEqual(demoSessions(3, 1_000_000));
  });
});

describe('counts', () => {
  it('counts phases and renders summary text', () => {
    const sessions = demoSessions(0, 1_000_000);
    const c = computeCounts({ workspaces: [], sessions });
    expect(c.working + c.waiting + c.idle + c.done + c.failed + c.stopped).toBe(sessions.length);
    expect(summaryText({ ...c, working: 3, waiting: 1, failed: 0 })).toBe('3 working · 1 waiting');
    expect(summaryText({ workspaces: 0, sessions: 0, working: 0, waiting: 0, idle: 0, done: 0, failed: 0, stopped: 0, recent: 0, archived: 0 })).toBe('no sessions');
  });
});

describe('extractCwd (historical projects)', () => {
  it('reads cwd from transcript JSONL lines', () => {
    const head = ['{"type":"summary"}', '{"type":"user","cwd":"C:\\\\VSO\\\\Agent City","x":1}'].join('\n');
    expect(extractCwd(head)).toBe('C:\\VSO\\Agent City');
  });
  it('handles truncated lines and missing cwd', () => {
    expect(extractCwd('{"cwd":"/home/me/repo","message":{"content":"trunc')).toBe('/home/me/repo');
    expect(extractCwd('{"a":1}\nnot json')).toBeUndefined();
  });
});
