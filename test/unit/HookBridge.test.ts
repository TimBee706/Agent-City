import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOOK_PATH,
  HttpHookBridge,
  MAX_BODY_BYTES,
  MAX_CONNECTIONS,
  NoopHookBridge,
  isAllowedHost,
  isBrowserRequest,
} from '../../src/backend/HookBridge';
import { AgentEvent } from '../../src/models/AgentEvent';

const TOKEN = 'test-token-0123456789abcdefghijkl';
const SID = 'abc-123';

interface Resp {
  status: number;
  body: string;
}

function request(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? HOOK_PATH,
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function good(port: number, payload: unknown = { session_id: SID, hook_event_name: 'Stop' }, extra: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return request(port, {
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-claude-city-token': TOKEN,
      'content-length': String(Buffer.byteLength(body)),
      ...extra,
    },
    body,
  });
}

const bridges: HttpHookBridge[] = [];
const servers: net.Server[] = [];

async function startBridge(port = 0) {
  const bridge = new HttpHookBridge({ port, token: TOKEN, retryBindMs: 0 });
  bridges.push(bridge);
  const events: AgentEvent[] = [];
  bridge.onEvent((e) => events.push(...e));
  await bridge.start();
  return { bridge, events, port: bridge.port! };
}

afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

describe('HttpHookBridge', () => {
  it('listens on loopback, accepts a valid hook and answers 200 {} without decision fields', async () => {
    const { bridge, events, port } = await startBridge();
    expect(bridge.info.status).toBe('running');
    const r = await good(port, { session_id: SID, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    expect(r).toEqual({ status: 200, body: '{}' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'subagent-start', agentId: `${SID}:a1` });
  });

  it('rejects wrong method and path', async () => {
    const { port, events } = await startBridge();
    const h = { host: `127.0.0.1:${port}`, 'x-claude-city-token': TOKEN };
    expect((await request(port, { method: 'GET', headers: h })).status).toBe(405);
    expect((await request(port, { method: 'PUT', headers: h, body: '{}' })).status).toBe(405);
    expect((await request(port, { path: '/other', headers: h, body: '{}' })).status).toBe(404);
    expect((await request(port, { path: `${HOOK_PATH}?x=1`, headers: h, body: '{}' })).status).toBe(404);
    expect(events).toHaveLength(0);
  });

  it('rejects foreign Host headers (DNS rebinding) and browser Origins', async () => {
    const { port, events } = await startBridge();
    expect((await good(port, undefined, { host: 'evil.example:' + port })).status).toBe(403);
    expect((await good(port, undefined, { host: `127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await good(port, undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await good(port, undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await good(port, undefined, { 'sec-fetch-site': 'same-origin' })).status).toBe(403);
    expect((await good(port, undefined, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await good(port, undefined, { host: `localhost:${port}` })).status).toBe(200);
    // Sec-Fetch-* alone (no Origin, not web-initiated) is not a reason to reject
    expect((await good(port, undefined, { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })).status).toBe(200);
    expect((await good(port, undefined, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(200);
    expect(events).toHaveLength(3);
  });

  it('logs the header names (never values) of the first accepted request at debug level', async () => {
    const debug: string[] = [];
    const bridge = new HttpHookBridge({ port: 0, token: TOKEN, retryBindMs: 0, debug: (m) => debug.push(m) });
    bridges.push(bridge);
    await bridge.start();
    expect((await good(bridge.port!, undefined, { 'x-custom': 'secret-value' })).status).toBe(200);
    expect((await good(bridge.port!)).status).toBe(200);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('x-claude-city-token');
    expect(debug[0]).toContain('x-custom');
    expect(debug[0]).not.toContain(TOKEN);
    expect(debug[0]).not.toContain('secret-value');
  });

  it('requires the token', async () => {
    const { port, events } = await startBridge();
    expect((await good(port, undefined, { 'x-claude-city-token': 'wrong' })).status).toBe(401);
    expect((await good(port, undefined, { 'x-claude-city-token': TOKEN + 'x' })).status).toBe(401);
    const body = JSON.stringify({ session_id: SID, hook_event_name: 'Stop' });
    const r = await request(port, { headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, body });
    expect(r.status).toBe(401);
    expect(events).toHaveLength(0);
  });

  it('requires JSON content type and valid JSON', async () => {
    const { port } = await startBridge();
    expect((await good(port, undefined, { 'content-type': 'text/plain' })).status).toBe(415);
    const bad = await request(port, {
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json; charset=utf-8', 'x-claude-city-token': TOKEN },
      body: '{not json',
    });
    expect(bad).toEqual({ status: 400, body: '{}' });
  });

  it('enforces the body size limit (declared and streamed)', async () => {
    const { port, events } = await startBridge();
    const big = JSON.stringify({ session_id: SID, hook_event_name: 'Stop', pad: 'x'.repeat(MAX_BODY_BYTES) });
    const declared = await good(port, JSON.parse(big)).catch((e) => ({ status: -1, body: String(e) }));
    expect([413, -1]).toContain(declared.status);
    // chunked (no content-length): rejected while streaming
    const streamed = await request(port, {
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-claude-city-token': TOKEN, 'transfer-encoding': 'chunked' },
      body: big,
    }).catch((e) => ({ status: -1, body: String(e) }));
    expect([413, -1]).toContain(streamed.status);
    expect(events).toHaveLength(0);
  });

  it('acknowledges unknown events with 200 but emits nothing; rejects payloads without session', async () => {
    const { port, events } = await startBridge();
    expect((await good(port, { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'secret' })).status).toBe(200);
    expect((await good(port, { hook_event_name: 'Stop' })).status).toBe(400);
    expect((await good(port, [1, 2])).status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('reports unavailable (no throw) when the port is busy', async () => {
    const blocker = net.createServer();
    servers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const bridge = new HttpHookBridge({ port, token: TOKEN, retryBindMs: 0 });
    bridges.push(bridge);
    const statuses: string[] = [];
    bridge.onDidChangeStatus((i) => statuses.push(i.status));
    await bridge.start();
    expect(bridge.info.status).toBe('unavailable');
    expect(bridge.info.error).toContain(String(port));
    expect(statuses).toEqual(['starting', 'unavailable']);
  });

  it('does not flap the status while retrying a busy port, reports running once it is free', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const bridge = new HttpHookBridge({ port, token: TOKEN, retryBindMs: 15 });
    bridges.push(bridge);
    const statuses: string[] = [];
    bridge.onDidChangeStatus((i) => statuses.push(i.status));
    await bridge.start();
    await new Promise((r) => setTimeout(r, 120)); // several retries
    expect(statuses).toEqual(['starting', 'unavailable']);
    await new Promise((r) => blocker.close(r));
    for (let i = 0; i < 100 && bridge.info.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(statuses).toEqual(['starting', 'unavailable', 'running']);
  });

  it('limits concurrent connections', async () => {
    const { bridge } = await startBridge();
    expect(MAX_CONNECTIONS).toBe(32);
    expect((bridge as unknown as { server: { maxConnections: number } }).server.maxConnections).toBe(MAX_CONNECTIONS);
  });

  it('stops cleanly and refuses connections afterwards', async () => {
    const { bridge, port } = await startBridge();
    await bridge.stop();
    expect(bridge.info.status).toBe('disabled');
    await expect(good(port)).rejects.toThrow();
    await bridge.stop(); // idempotent
  });

  it('rejects short tokens at construction', () => {
    expect(() => new HttpHookBridge({ port: 0, token: 'short' })).toThrow();
  });
});

describe('isBrowserRequest', () => {
  it('flags Origin and web-initiated Sec-Fetch-Site only', () => {
    expect(isBrowserRequest({ origin: 'null' })).toBe(true);
    expect(isBrowserRequest({ 'sec-fetch-site': 'Cross-Site' })).toBe(true);
    expect(isBrowserRequest({ 'sec-fetch-site': 'none' })).toBe(false);
    expect(isBrowserRequest({ 'sec-fetch-mode': 'no-cors' })).toBe(false);
    expect(isBrowserRequest({})).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('accepts loopback names on our port only', () => {
    expect(isAllowedHost('127.0.0.1:47821', 47821)).toBe(true);
    expect(isAllowedHost('localhost', 47821)).toBe(true);
    expect(isAllowedHost('LOCALHOST:47821', 47821)).toBe(true);
    expect(isAllowedHost('127.0.0.1:1', 47821)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.com:47821', 47821)).toBe(false);
    expect(isAllowedHost('[::1]:47821', 47821)).toBe(false);
    expect(isAllowedHost(undefined, 47821)).toBe(false);
  });
});

describe('NoopHookBridge', () => {
  it('is inert', async () => {
    const b = new NoopHookBridge();
    await b.start();
    expect(b.info.status).toBe('disabled');
    expect(b.isRunning).toBe(false);
    b.onEvent().dispose();
    await b.stop();
    b.dispose();
  });
});
