import { describe, expect, it } from 'vitest';
import { AgentsResult } from '../../src/backend/ClaudeCliClient';
import { EventStore } from '../../src/backend/EventStore';
import {
  HIDDEN_POLL_MS,
  MAX_STALE_ERRORS,
  SessionManager,
  SessionManagerConfig,
  UNAVAILABLE_BACKOFF_MS,
} from '../../src/backend/SessionManager';
import { WorkspaceRegistry } from '../../src/backend/WorkspaceRegistry';
import { CityState } from '../../src/models/CityState';
import { normalizeSession } from '../../src/models/Session';
import { FakeTimers, MemoryMemento, settle } from './helpers';

const live = (...items: [string, string][]): AgentsResult => ({
  kind: 'ok',
  malformed: 0,
  sessions: items.map(([id, status]) => normalizeSession({ sessionId: id, cwd: `C:\\repo\\${id}`, status })!),
});

function setup(results: AgentsResult[], config: Partial<SessionManagerConfig> = {}) {
  const timers = new FakeTimers();
  let calls = 0;
  let resolveHold: (() => void) | undefined;
  let hold = false;
  const client = {
    listSessions: async () => {
      calls++;
      if (hold) await new Promise<void>((r) => (resolveHold = r));
      return results[Math.min(calls - 1, results.length - 1)];
    },
    version: async () => '2.1.289 (Claude Code)',
  };
  const cfg: SessionManagerConfig = { pollIntervalSeconds: 4, demoMode: 'auto', ...config };
  const now = { t: 1_000_000 };
  const mgr = new SessionManager({
    client,
    registry: new WorkspaceRegistry(new MemoryMemento()),
    events: new EventStore(500),
    getConfig: () => cfg,
    timers,
    now: () => now.t,
  });
  const states: CityState[] = [];
  const events: number[] = [];
  mgr.onDidChangeState((s) => states.push(s));
  mgr.onDidAddEvents((e) => events.push(e.length));
  return {
    mgr,
    timers,
    states,
    events,
    now,
    cfg,
    calls: () => calls,
    hold: (v: boolean) => (hold = v),
    release: () => resolveHold?.(),
  };
}

describe('SessionManager', () => {
  it('emits live state and only emits again when something changed', async () => {
    const t = setup([live(['a', 'busy']), live(['a', 'busy']), live(['a', 'idle'])]);
    t.mgr.setViewsVisible(true);
    t.mgr.start();
    await settle();
    expect(t.states).toHaveLength(1);
    expect(t.states[0].source).toBe('live');
    expect(t.states[0].cliVersion).toBe('2.1.289 (Claude Code)');
    expect(t.states[0].agents).toHaveLength(1);
    expect(t.states[0].workspaces.map((w) => w.name)).toEqual(['a']);

    t.timers.flush();
    await settle();
    expect(t.calls()).toBe(2);
    expect(t.states).toHaveLength(1); // unchanged -> no emit

    t.now.t += 5000;
    t.timers.flush();
    await settle();
    expect(t.states).toHaveLength(2);
    expect(t.states[1].agents[0].characterState).toBe('idle');
    expect(t.events).toEqual([1, 1]); // appeared, then phase changed
    t.mgr.dispose();
  });

  it('never overlaps polls; refresh during a poll coalesces into one rerun', async () => {
    const t = setup([live(['a', 'busy'])]);
    t.hold(true);
    t.mgr.start();
    await settle();
    void t.mgr.refresh();
    void t.mgr.refresh();
    await settle();
    expect(t.calls()).toBe(1);
    t.hold(false);
    t.release();
    await settle();
    expect(t.calls()).toBe(2);
    expect(t.timers.pending.size).toBe(1);
    t.mgr.dispose();
    expect(t.timers.pending.size).toBe(0);
  });

  it('uses the configured interval when visible and a slower one when hidden', async () => {
    const t = setup([live(['a', 'busy'])], { pollIntervalSeconds: 1 /* clamped to 2 */ });
    t.mgr.setViewsVisible(true);
    t.mgr.start();
    await settle();
    expect(t.timers.delays()).toEqual([2000]);
    t.mgr.setViewsVisible(false);
    t.timers.flush();
    await settle();
    expect(t.timers.delays()).toEqual([HIDDEN_POLL_MS]);
    t.mgr.dispose();
  });

  it('shows labelled demo data when the CLI is unavailable in auto mode, and backs off CLI checks', async () => {
    const t = setup([{ kind: 'unavailable', reason: 'not found' }]);
    t.mgr.setViewsVisible(true);
    t.mgr.start();
    await settle();
    const s = t.states.at(-1)!;
    expect(s.source).toBe('demo');
    expect(s.error).toContain('not found');
    expect(s.workspaces.length).toBeGreaterThanOrEqual(3);
    // demo keeps ticking but the CLI is not re-checked within the back-off window
    t.now.t += 4000;
    t.timers.flush();
    await settle();
    expect(t.calls()).toBe(1);
    t.now.t += UNAVAILABLE_BACKOFF_MS;
    t.timers.flush();
    await settle();
    expect(t.calls()).toBe(2);
    t.mgr.dispose();
  });

  it('reports unavailable (no demo) with demoMode off and backs off 30s', async () => {
    const t = setup([{ kind: 'unavailable', reason: 'not found' }], { demoMode: 'off' });
    t.mgr.setViewsVisible(true);
    t.mgr.start();
    await settle();
    expect(t.states.at(-1)).toMatchObject({ source: 'unavailable', sessions: [], error: 'not found' });
    expect(t.timers.delays()).toEqual([UNAVAILABLE_BACKOFF_MS]);
    t.mgr.dispose();
  });

  it('demoMode on never calls the CLI; toggle switches back to live', async () => {
    const t = setup([live(['a', 'busy'])], { demoMode: 'on' });
    t.mgr.start();
    await settle();
    expect(t.calls()).toBe(0);
    expect(t.mgr.isDemoActive).toBe(true);
    t.mgr.toggleDemo();
    await settle();
    expect(t.mgr.state.source).toBe('live');
    expect(t.mgr.state.events.every((e) => e.source !== 'demo')).toBe(true);
    t.mgr.dispose();
  });

  it('keeps last known sessions on transient errors, drops them after repeated errors', async () => {
    const err: AgentsResult = { kind: 'error', message: 'timeout' };
    const t = setup([live(['a', 'busy']), err, err, err]);
    t.mgr.start();
    await settle();
    for (let i = 0; i < MAX_STALE_ERRORS - 1; i++) {
      t.timers.flush();
      await settle();
      expect(t.mgr.state).toMatchObject({ source: 'error', error: 'timeout' });
      expect(t.mgr.state.sessions).toHaveLength(1);
    }
    t.timers.flush();
    await settle();
    expect(t.mgr.state.sessions).toHaveLength(0);
    t.mgr.dispose();
  });

  it('does not poll after dispose', async () => {
    const t = setup([live(['a', 'busy'])]);
    t.mgr.start();
    await settle();
    t.mgr.dispose();
    await t.mgr.refresh();
    expect(t.calls()).toBe(1);
  });
});
