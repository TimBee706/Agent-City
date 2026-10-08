import { describe, expect, it, vi } from 'vitest';
import { MessageBus, WebviewLike } from '../../src/services/MessageBus';
import { StateSynchronizer } from '../../src/services/StateSynchronizer';
import { emptyCityState } from '../../src/models/CityState';
import { parseExtensionMessage, parseWebviewMessage } from '../../src/shared/protocol';
import { FakeTimers } from './helpers';

describe('parseWebviewMessage', () => {
  it('accepts known messages and strips extra properties', () => {
    expect(parseWebviewMessage({ type: 'ready', view: 'panel', evil: 1 })).toEqual({ type: 'ready', view: 'panel' });
    expect(parseWebviewMessage({ type: 'refresh' })).toEqual({ type: 'refresh' });
    expect(parseWebviewMessage({ type: 'openCity' })).toEqual({ type: 'openCity' });
    expect(parseWebviewMessage({ type: 'toggleDemo' })).toEqual({ type: 'toggleDemo' });
    expect(parseWebviewMessage({ type: 'openFolder', workspaceId: 'w1' })).toEqual({ type: 'openFolder', workspaceId: 'w1' });
  });

  it('rejects unknown types and bad shapes', () => {
    for (const bad of [
      null,
      undefined,
      'refresh',
      [],
      {},
      { type: 'runShell', cmd: 'rm -rf /' },
      { type: 'ready' },
      { type: 'ready', view: 'other' },
      { type: 'openFolder' },
      { type: 'openFolder', workspaceId: 5 },
      { type: 'openFolder', workspaceId: '' },
      { type: 'openFolder', workspaceId: 'x'.repeat(500) },
      { type: '__proto__' },
    ]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
  });

  it('parseExtensionMessage validates basic shape', () => {
    expect(parseExtensionMessage({ type: 'state', state: emptyCityState() })).toBeDefined();
    expect(parseExtensionMessage({ type: 'events', events: [] })).toBeDefined();
    expect(parseExtensionMessage({ type: 'state' })).toBeUndefined();
    expect(parseExtensionMessage({ type: 'x' })).toBeUndefined();
  });
});

function fakeWebview() {
  let listener: ((m: unknown) => void) | undefined;
  const posted: unknown[] = [];
  const wv: WebviewLike = {
    postMessage: async (m) => {
      posted.push(m);
      return true;
    },
    onDidReceiveMessage: (l) => {
      listener = l;
      return { dispose: () => (listener = undefined) };
    },
  };
  return { wv, posted, send: (m: unknown) => listener?.(m) };
}

describe('MessageBus', () => {
  it('forwards valid messages and rejects invalid ones', () => {
    const f = fakeWebview();
    const handler = vi.fn();
    const bus = new MessageBus(f.wv, handler);
    f.send({ type: 'refresh' });
    f.send({ type: 'hack' });
    f.send(42);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.rejectedCount).toBe(2);
    bus.dispose();
    f.send({ type: 'refresh' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('post never rejects', async () => {
    const bus = new MessageBus(
      { postMessage: () => Promise.reject(new Error('disposed')), onDidReceiveMessage: () => ({ dispose() {} }) },
      () => undefined,
    );
    await expect(bus.post({ type: 'events', events: [] })).resolves.toBe(false);
  });
});

describe('StateSynchronizer', () => {
  it('sends a snapshot on ready, throttles state, forwards events immediately', () => {
    const timers = new FakeTimers();
    let version = 0;
    const sync = new StateSynchronizer(() => ({ ...emptyCityState('live'), updatedAt: ++version }), 100, timers);
    const posted: unknown[] = [];
    const notReady: unknown[] = [];
    const t1 = sync.attach({ post: async (m) => (posted.push(m), true) });
    sync.attach({ post: async (m) => (notReady.push(m), true) });

    sync.pushState(); // nobody ready
    expect(posted).toHaveLength(0);
    t1.markReady();
    expect(posted).toHaveLength(1);

    timers.flush();
    sync.pushState(); // leading edge
    sync.pushState(); // throttled
    sync.pushState(); // throttled
    expect(posted).toHaveLength(2);
    timers.flush(); // trailing edge
    expect(posted).toHaveLength(3);

    sync.pushEvents([{ id: 'e', type: 'session.appeared', timestamp: 1, sessionId: 's', source: 'diff', message: 'm' }]);
    expect(posted).toHaveLength(4);
    expect(notReady).toHaveLength(0);

    t1.dispose();
    expect(sync.targetCount).toBe(1);
    sync.dispose();
  });
});
