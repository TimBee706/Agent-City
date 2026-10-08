import { describe, expect, it } from 'vitest';
import { AgentsResult } from '../../src/backend/ClaudeCliClient';
import { EventStore } from '../../src/backend/EventStore';
import { SessionManager, SessionManagerConfig, TRANSIENT_GRACE_MS } from '../../src/backend/SessionManager';
import { WorkspaceRegistry } from '../../src/backend/WorkspaceRegistry';
import {
  deriveAgents,
  overlaySessions,
  suppressRedundantDiffEvents,
  transientSessions,
} from '../../src/backend/cityStateBuilder';
import { HookActivityTracker, STALE_MS, SUBAGENT_LEAVE_GRACE_MS } from '../../src/backend/hookActivity';
import { parseHookPayload } from '../../src/backend/hookPayload';
import { AgentEvent } from '../../src/models/AgentEvent';
import { CityState } from '../../src/models/CityState';
import { normalizeSession, sessionPhase } from '../../src/models/Session';
import { FakeTimers, MemoryMemento, settle } from './helpers';

const SID = 'sess-1';
let clock = 1_000_000;
function hook(event: string, extra: Record<string, unknown> = {}, at = clock, sid = SID): AgentEvent {
  const r = parseHookPayload({ session_id: sid, cwd: 'C:\\repo\\app', hook_event_name: event, ...extra }, at);
  if (!r.ok) throw new Error(r.reason);
  return r.event;
}
const session = (id = SID, status = 'busy') => normalizeSession({ sessionId: id, cwd: 'C:\\repo\\app', status })!;

describe('HookActivityTracker + deriveAgents', () => {
  it('SubagentStart spawns a working subagent with its type', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' })]);
    const agents = deriveAgents([session()], [], t);
    expect(agents.map((a) => [a.role, a.agentType, a.characterState])).toEqual([
      ['main', 'main', 'busy'],
      ['subagent', 'Explore', 'working'],
    ]);
    expect(agents[1]).toMatchObject({ agentId: `${SID}:a1`, parentSessionId: SID, parentAgentId: `${SID}:main`, spawnedAt: clock });
  });

  it('SubagentStop -> leaving/done, removed after the grace period', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SubagentStart', { agent_id: 'a1', agent_type: 'Plan' }, 0), hook('SubagentStop', { agent_id: 'a1' }, 1000)]);
    const [, sub] = deriveAgents([session()], [], t);
    expect(sub).toMatchObject({ characterState: 'done', leaving: true });
    expect(t.nextExpiry(1000)).toBe(1000 + SUBAGENT_LEAVE_GRACE_MS);
    expect(t.prune(1000 + SUBAGENT_LEAVE_GRACE_MS - 1)).toBe(false);
    expect(t.prune(1000 + SUBAGENT_LEAVE_GRACE_MS)).toBe(true);
    expect(deriveAgents([session()], [], t)).toHaveLength(1);
  });

  it('expires stale subagents without events (no ghosts)', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SubagentStart', { agent_id: 'a1' }, 0)]);
    expect(t.prune(STALE_MS - 1)).toBe(false);
    expect(t.prune(STALE_MS)).toBe(true);
    expect(t.subagents.size).toBe(0);
  });

  it('TaskCreated attaches to the subagent (by agent id or teammate name), else to the main agent', () => {
    const t = new HookActivityTracker();
    t.apply([
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'researcher' }, 0),
      hook('TaskCreated', { agent_id: 'a1', task_id: 't1', task_subject: 'Read docs' }, 1),
      hook('TaskCreated', { task_id: 't2', task_subject: 'Write code', teammate_name: 'Researcher' }, 2),
      hook('TaskCreated', { task_id: 't3', task_subject: 'Main work' }, 3),
    ]);
    const [main, sub] = deriveAgents([session()], [], t);
    expect(sub.task).toBe('Write code');
    expect(main.task).toBe('Main work');
    t.apply([hook('TaskCompleted', { task_id: 't3', task_subject: 'Main work' }, 10)]);
    const [main2] = deriveAgents([session()], [], t);
    expect(main2.task).toBeUndefined();
    expect(main2.completedAt).toBe(10);
    expect(t.tasksCompletedToday(10)).toBe(1);
  });

  it('Notification flags attention until later activity or a poll phase change', () => {
    const t = new HookActivityTracker();
    t.apply([hook('Notification', { notification_type: 'permission_prompt', message: 'Bash wants to run' }, 100)]);
    let [s] = overlaySessions([session()], t);
    expect(s.attention).toBe('Bash wants to run');
    expect(sessionPhase(s)).toBe('waiting');
    expect(deriveAgents([s], [], t)[0]).toMatchObject({ characterState: 'blocked', attention: 'Bash wants to run' });
    // poll older than the notification does not clear it
    expect(t.clearAttention(SID, 50)).toBe(false);
    expect(t.clearAttention(SID, 200)).toBe(true);
    [s] = overlaySessions([session()], t);
    expect(s.attention).toBeUndefined();
    // later hook activity clears it as well
    t.apply([hook('Notification', { notification_type: 'idle_prompt' }, 300), hook('Stop', {}, 400)]);
    [s] = overlaySessions([session()], t);
    expect(s.attention).toBeUndefined();
  });

  it('SessionEnd winds the room down and stops subagents', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SubagentStart', { agent_id: 'a1' }, 0), hook('SessionEnd', { reason: 'logout' }, 10)]);
    const [s] = overlaySessions([session()], t);
    expect(s.endedAt).toBe(10);
    expect(sessionPhase(s)).toBe('stopped');
    const agents = deriveAgents([s], [], t);
    expect(agents[0].characterState).toBe('stopped');
    expect(agents[1].leaving).toBe(true);
  });

  it('treats the first hook event after SessionEnd as a resume (no SessionStart http hook)', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SubagentStart', { agent_id: 'a1' }, 1000), hook('SessionEnd', { reason: 'other' }, 2000)]);
    expect(t.sessions.get(SID)?.endedAt).toBe(2000);
    expect(overlaySessions([session()], t)[0].endedAt).toBe(2000);
    // an event in the same millisecond as the end does not resume
    t.apply([hook('Stop', {}, 2000)]);
    expect(t.sessions.get(SID)?.endedAt).toBe(2000);
    // claude --resume: the next hook event clears the ended state
    t.apply([hook('Notification', { notification_type: 'idle_prompt', message: 'waiting' }, 5000)]);
    expect(t.sessions.get(SID)?.endedAt).toBeUndefined();
    expect(t.sessions.get(SID)?.endReason).toBeUndefined();
    expect(overlaySessions([session()], t)[0].endedAt).toBeUndefined();
    expect(deriveAgents([session()], [], t)[0].characterState).not.toBe('stopped');
    // the subagent stopped by SessionEnd stays stopped
    expect(t.subagents.get(`${SID}:a1`)?.stoppedAt).toBe(2000);
    // a resumed hook-only session gets its transient room back
    const resolve = () => 'w1';
    expect(transientSessions(t, new Set(), new Set(), resolve).map((x) => x.id)).toEqual([SID]);
  });

  it('a second SessionEnd after a resume ends the session again', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SessionEnd', {}, 1000), hook('Stop', {}, 2000), hook('SessionEnd', {}, 3000)]);
    expect(t.sessions.get(SID)?.endedAt).toBe(3000);
  });

  it('transient rooms only for known workspaces, never for excluded or ended sessions', () => {
    const t = new HookActivityTracker();
    t.apply([hook('SubagentStart', { agent_id: 'a' }, 0, 'new-1'), hook('Stop', {}, 0, 'new-2'), hook('SessionEnd', {}, 0, 'new-3')]);
    const resolve = (cwd: string) => (cwd.startsWith('C:\\repo') ? 'w1' : undefined);
    const tr = transientSessions(t, new Set(), new Set(['new-2']), resolve);
    expect(tr.map((s) => [s.id, s.transient, s.workspaceId, s.state])).toEqual([['new-1', true, 'w1', 'working']]);
    expect(transientSessions(t, new Set(['new-1']), new Set(), resolve).map((s) => s.id)).toEqual(['new-2']);
    expect(transientSessions(t, new Set(), new Set(), () => undefined)).toEqual([]);
  });

  it('ignores non-hook events and caps subagents per session', () => {
    const t = new HookActivityTracker();
    t.apply([{ ...hook('SubagentStart', { agent_id: 'x' }), source: 'diff' }]);
    expect(t.subagents.size).toBe(0);
    t.apply(Array.from({ length: 40 }, (_, i) => hook('SubagentStart', { agent_id: `a${i}` }, i)));
    expect(t.subagents.size).toBe(24);
  });
});

describe('event dedup (hook + synthesized)', () => {
  it('drops left diff events covered by a recent SessionEnd hook; appeared stays without SessionStart', () => {
    const he = hook('SessionEnd', {}, 1000, 'sess-2');
    const other = hook('Stop', {}, 1000); // ordinary hook activity must not hide "appeared"
    const diff: AgentEvent[] = [
      { id: 'd1', type: 'session.appeared', timestamp: 2000, sessionId: SID, source: 'diff', message: '' },
      { id: 'd2', type: 'session.disappeared', timestamp: 2000, sessionId: 'sess-2', source: 'diff', message: '' },
    ];
    expect(suppressRedundantDiffEvents(diff, [he, other], 2000).map((e) => e.id)).toEqual(['d1']);
  });

  it('legacy/manual SessionStart hook events still suppress appeared', () => {
    const hs = hook('SessionStart', {}, 1000);
    const he = hook('SessionEnd', {}, 1000, 'sess-2');
    const diff: AgentEvent[] = [
      { id: 'd1', type: 'session.appeared', timestamp: 2000, sessionId: SID, source: 'diff', message: '' },
      { id: 'd2', type: 'session.disappeared', timestamp: 2000, sessionId: 'sess-2', source: 'diff', message: '' },
      { id: 'd3', type: 'session.appeared', timestamp: 2000, sessionId: 'other', source: 'diff', message: '' },
      { id: 'd4', type: 'session.phaseChanged', timestamp: 2000, sessionId: SID, source: 'diff', message: '' },
    ];
    expect(suppressRedundantDiffEvents(diff, [hs, he], 2000).map((e) => e.id)).toEqual(['d3', 'd4']);
    expect(suppressRedundantDiffEvents(diff, [hs, he], 1000 + 61_000)).toHaveLength(4);
  });

  it('EventStore dedupes duplicate hook deliveries but keeps distinct tasks in the same second', () => {
    const store = new EventStore(50);
    const a = hook('TaskCreated', { task_id: 't1' }, 5000);
    const dup = hook('TaskCreated', { task_id: 't1' }, 5100);
    const b = hook('TaskCreated', { task_id: 't2' }, 5200);
    expect(store.add([a, dup, b]).map((e) => e.taskId)).toEqual(['t1', 't2']);
  });
});

describe('SessionManager with hook events', () => {
  function setup(results: AgentsResult[]) {
    const timers = new FakeTimers();
    let calls = 0;
    const now = { t: 1_000_000 };
    const registry = new WorkspaceRegistry(new MemoryMemento());
    const cfg: SessionManagerConfig = { pollIntervalSeconds: 5, demoMode: 'off' };
    const mgr = new SessionManager({
      client: {
        listSessions: async () => results[Math.min(calls++, results.length - 1)],
        version: async () => '2.1.289',
      },
      registry,
      events: new EventStore(500),
      getConfig: () => cfg,
      timers,
      now: () => now.t,
    });
    const states: CityState[] = [];
    const fired: AgentEvent[][] = [];
    mgr.onDidChangeState((s) => states.push(s));
    mgr.onDidAddEvents((e) => fired.push(e));
    return { mgr, timers, now, states, fired, registry };
  }
  const live = (...ids: string[]): AgentsResult => ({ kind: 'ok', malformed: 0, sessions: ids.map((id) => session(id)) });

  it('applies hook events immediately (no poll), forwards them and dedupes', async () => {
    const t = setup([live(SID)]);
    t.mgr.start();
    await settle();
    const before = t.states.length;
    const ev = hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, t.now.t);
    t.mgr.ingestHookEvents([ev]);
    expect(t.fired.at(-1)?.[0].type).toBe('subagent-start');
    expect(t.fired.at(-1)?.[0].workspaceId).toBeDefined();
    expect(t.states.length).toBe(before + 1);
    expect(t.mgr.state.agents.filter((a) => a.role === 'subagent')).toHaveLength(1);
    t.mgr.ingestHookEvents([{ ...ev, id: 'other-id' }]); // same key -> duplicate
    expect(t.states.length).toBe(before + 1);
    expect(t.fired.filter((f) => f[0].type === 'subagent-start')).toHaveLength(1);
    t.mgr.dispose();
  });

  it('removes a stopped subagent after the grace period via its own timer', async () => {
    const t = setup([live(SID)]);
    t.mgr.start();
    await settle();
    t.mgr.ingestHookEvents([hook('SubagentStart', { agent_id: 'a1' }, t.now.t)]);
    t.now.t += 1000;
    t.mgr.ingestHookEvents([hook('SubagentStop', { agent_id: 'a1' }, t.now.t)]);
    expect(t.mgr.state.agents.find((a) => a.role === 'subagent')?.leaving).toBe(true);
    expect(t.timers.delays()).toContain(SUBAGENT_LEAVE_GRACE_MS);
    t.now.t += SUBAGENT_LEAVE_GRACE_MS;
    t.timers.flush();
    await settle();
    expect(t.mgr.state.agents.filter((a) => a.role === 'subagent')).toHaveLength(0);
    t.mgr.dispose();
    expect(t.timers.pending.size).toBe(0);
  });

  it('creates a transient room for a hook-only session in a known workspace; polling wins later', async () => {
    const t = setup([live(SID)]);
    t.mgr.start();
    await settle();
    t.mgr.ingestHookEvents([hook('SubagentStart', { agent_id: 'a1' }, t.now.t, 'fresh')]);
    expect(t.mgr.state.sessions.find((s) => s.id === 'fresh')?.transient).toBe(true);
    // a poll started after the grace period that still does not list it -> dropped for good
    t.now.t += TRANSIENT_GRACE_MS + 1;
    await t.mgr.refresh();
    expect(t.mgr.state.sessions.find((s) => s.id === 'fresh')).toBeUndefined();
    t.mgr.ingestHookEvents([hook('Stop', {}, t.now.t, 'fresh')]);
    expect(t.mgr.state.sessions.find((s) => s.id === 'fresh')).toBeUndefined();
    expect(t.mgr.state.events.some((e) => e.sessionId === 'fresh' && e.type === 'stop')).toBe(true);
    t.mgr.dispose();
  });

  it('does not create rooms for unknown workspaces', async () => {
    const t = setup([live(SID)]);
    t.mgr.start();
    await settle();
    const r = parseHookPayload({ session_id: 'x1', cwd: 'D:\\elsewhere', hook_event_name: 'Stop' }, t.now.t);
    if (!r.ok) throw new Error();
    t.mgr.ingestHookEvents([r.event]);
    expect(t.mgr.state.sessions.map((s) => s.id)).toEqual([SID]);
    expect(t.mgr.state.events.some((e) => e.sessionId === 'x1')).toBe(true);
    t.mgr.dispose();
  });

  it('ignores hook events while demo data is shown and reports hook status + stats', async () => {
    const t = setup([live(SID)]);
    t.mgr.start();
    await settle();
    t.mgr.setHookStatus({ bridge: 'running', install: 'current', port: 47821 });
    expect(t.mgr.state.hooks).toMatchObject({ bridge: 'running', install: 'current', port: 47821 });
    t.mgr.ingestHookEvents([hook('TaskCompleted', { task_id: 'z' }, t.now.t)]);
    expect(t.mgr.state.stats?.tasksCompletedToday).toBe(1);
    t.mgr.setDemoOverride(true);
    await settle();
    const n = t.mgr.state.events.length;
    t.mgr.ingestHookEvents([hook('Stop', {}, t.now.t + 5000)]);
    expect(t.mgr.state.events.length).toBe(n);
    t.mgr.dispose();
  });
});
