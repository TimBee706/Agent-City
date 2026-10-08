import { describe, expect, it } from 'vitest';
import { parseAgentsOutput } from '../../src/backend/claudeOutputParser';

// Shape observed from `claude agents --json --all` (Claude Code 2.1.289), sanitized.
const REAL_SAMPLE = `[
  {
    "pid": 10488,
    "cwd": "c:\\\\VSO\\\\Heyconnect",
    "kind": "interactive",
    "startedAt": 1791452102248,
    "sessionId": "7438ba5d-8f96-4879-b115-01848084f971",
    "name": "heyconnect-b1",
    "status": "idle"
  },
  {
    "pid": 27764,
    "cwd": "c:\\\\VSO\\\\Agent City",
    "kind": "interactive",
    "startedAt": 1791452562526,
    "sessionId": "61737144-a8eb-4807-a65f-532acc2432f6",
    "name": "agent-city-17",
    "status": "busy"
  }
]`;

describe('parseAgentsOutput', () => {
  it('parses the real CLI JSON array', () => {
    const r = parseAgentsOutput(REAL_SAMPLE);
    expect(r.recognized).toBe(true);
    expect(r.malformed).toBe(0);
    expect(r.sessions).toHaveLength(2);
    const s = r.sessions.find((x) => x.name === 'agent-city-17')!;
    expect(s.id).toBe('61737144-a8eb-4807-a65f-532acc2432f6');
    expect(s.cwd).toBe('c:\\VSO\\Agent City');
    expect(s.status).toBe('busy');
    expect(s.state).toBe('unknown');
    expect(s.kind).toBe('interactive');
    expect(s.startedAt).toBe(1791452562526);
    expect(s.pid).toBe(27764);
  });

  it('parses an empty array and empty output', () => {
    expect(parseAgentsOutput('[]')).toEqual({ sessions: [], malformed: 0, recognized: true });
    expect(parseAgentsOutput('  \n')).toEqual({ sessions: [], malformed: 0, recognized: true });
  });

  it.each(['agents', 'sessions', 'items', 'data'])('parses an object wrapping an array under "%s"', (key) => {
    const r = parseAgentsOutput(JSON.stringify({ [key]: [{ id: 'a', cwd: '/x', state: 'running' }] }));
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].id).toBe('a');
    expect(r.sessions[0].state).toBe('working');
  });

  it('parses NDJSON lines and skips malformed lines individually', () => {
    const text = [
      JSON.stringify({ sessionId: 's1', cwd: '/a', status: 'busy' }),
      '{not json',
      '',
      JSON.stringify({ sessionId: 's2', cwd: '/b', state: 'done' }),
      JSON.stringify([{ sessionId: 's3', cwd: '/c' }]),
      '42',
    ].join('\n');
    const r = parseAgentsOutput(text);
    expect(r.recognized).toBe(true);
    expect(r.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
    expect(r.malformed).toBe(2);
  });

  it('ignores malformed entries inside a valid array', () => {
    const r = parseAgentsOutput(JSON.stringify([null, 5, 'x', [], {}, { foo: 1 }, { sessionId: 'ok' }]));
    expect(r.sessions.map((s) => s.id)).toEqual(['ok']);
    expect(r.malformed).toBe(6);
  });

  it('reports unrecognized garbage output', () => {
    const r = parseAgentsOutput('Error: something went wrong\nat foo');
    expect(r.recognized).toBe(false);
    expect(r.sessions).toEqual([]);
  });

  it('handles a BOM and dedupes by id (last wins)', () => {
    const r = parseAgentsOutput('\uFEFF' + JSON.stringify([{ sessionId: 'a', status: 'idle' }, { sessionId: 'a', status: 'busy' }]));
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].status).toBe('busy');
  });
});
