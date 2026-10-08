import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { AgentEvent } from '../models/AgentEvent';
import { Disposable, Emitter } from '../util/emitter';
import { parseHookPayload } from './hookPayload';

/**
 * Live-event bridge for Claude Code hooks.
 *
 * Claude Code `type: "http"` hooks (https://code.claude.com/docs/en/hooks#http-hook-fields) POST the
 * hook input as JSON (`Content-Type: application/json`) to a URL. Our installer registers
 * `http://127.0.0.1:<port>/claude-city/hook` with a fixed `X-Claude-City-Token` header.
 * Per the docs, a 2xx with an empty JSON object is a plain success, and non-2xx / connection failures
 * are non-blocking errors - so hooks never block Claude, even when VS Code is closed.
 *
 * Polling (`claude agents --json --all`) remains the authoritative source; the bridge only enriches.
 */
export type HookBridgeStatus = 'disabled' | 'starting' | 'running' | 'unavailable';

export interface HookBridgeInfo {
  status: HookBridgeStatus;
  port?: number;
  error?: string;
}

export interface HookBridge extends Disposable {
  /** Starts listening. Resolves when ready; must never reject (report errors via status instead). */
  start(): Promise<void>;
  /** Stops listening and frees all resources. Safe to call multiple times. */
  stop(): Promise<void>;
  /** Subscribe to normalized hook events. */
  onEvent(listener: (events: AgentEvent[]) => void): Disposable;
  onDidChangeStatus(listener: (info: HookBridgeInfo) => void): Disposable;
  readonly info: HookBridgeInfo;
  readonly isRunning: boolean;
}

/** Used when `claudeCity.hookBridge.enabled` is false. */
export class NoopHookBridge implements HookBridge {
  readonly isRunning = false;
  readonly info: HookBridgeInfo = { status: 'disabled' };
  async start(): Promise<void> {
    /* disabled */
  }
  async stop(): Promise<void> {
    /* disabled */
  }
  onEvent(): Disposable {
    return { dispose: () => undefined };
  }
  onDidChangeStatus(): Disposable {
    return { dispose: () => undefined };
  }
  dispose(): void {
    /* nothing to free */
  }
}

export const HOOK_PATH = '/claude-city/hook';
export const TOKEN_HEADER = 'x-claude-city-token';
export const DEFAULT_HOOK_PORT = 47821;
export const MAX_BODY_BYTES = 256 * 1024;
/** Max accepted events per second (simple fixed window); excess requests get 429. */
export const MAX_EVENTS_PER_SECOND = 100;
/** While the port is busy (e.g. another VS Code window owns it), retry binding this often. */
export const RETRY_BIND_MS = 30_000;
/** Concurrent socket limit (Claude sends one short request per hook; this only bounds abuse). */
export const MAX_CONNECTIONS = 32;
/** `Sec-Fetch-Site` values only browsers send for web-initiated requests. */
const BROWSER_FETCH_SITES = new Set(['cross-site', 'same-site', 'same-origin']);

export interface HttpHookBridgeOptions {
  port: number;
  /** Shared secret; requests must carry it in the X-Claude-City-Token header. */
  token: string;
  host?: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** Debug-level log (header names of the first accepted request). */
  debug?: (msg: string) => void;
  maxBodyBytes?: number;
  retryBindMs?: number;
}

function tokenMatches(expected: Buffer, actual: string | string[] | undefined): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual, 'utf8');
  if (a.length !== expected.length) return false;
  return timingSafeEqual(a, expected);
}

/** Host header must name the loopback interface on our port (DNS rebinding protection). */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const m = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m) return false;
  return m[2] === undefined || Number(m[2]) === port;
}

/**
 * True for requests a web page could have made: any `Origin` header, or a `Sec-Fetch-Site` of a
 * web-initiated fetch. `Sec-Fetch-Site: none` (user-initiated) or no Sec-Fetch headers at all are not
 * treated as browser requests on their own - HTTP clients may send them, and the token check protects
 * the endpoint anyway.
 */
export function isBrowserRequest(headers: http.IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined) return true;
  const site = headers['sec-fetch-site'];
  return typeof site === 'string' && BROWSER_FETCH_SITES.has(site.trim().toLowerCase());
}

/**
 * Loopback-only HTTP server receiving Claude Code hook payloads.
 * Never returns decision fields: every accepted request gets `200 {}`.
 */
export class HttpHookBridge implements HookBridge {
  private server: http.Server | undefined;
  private readonly eventEmitter = new Emitter<AgentEvent[]>();
  private readonly statusEmitter = new Emitter<HookBridgeInfo>();
  private current: HookBridgeInfo = { status: 'disabled' };
  private readonly expectedToken: Buffer;
  private readonly host: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly debug: (msg: string) => void;
  private loggedHeaderNames = false;
  private readonly maxBody: number;
  private readonly retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private windowStart = 0;
  private windowCount = 0;
  private stopped = false;
  private lastRejectLog = -Infinity;
  /** Counters for diagnostics/tests. */
  readonly stats = { accepted: 0, rejected: 0 };

  constructor(private readonly opts: HttpHookBridgeOptions) {
    if (!opts.token || opts.token.length < 16) throw new Error('hook token too short');
    this.expectedToken = Buffer.from(opts.token, 'utf8');
    this.host = opts.host ?? '127.0.0.1';
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.debug = opts.debug ?? (() => undefined);
    this.maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    this.retryMs = opts.retryBindMs ?? RETRY_BIND_MS;
  }

  get info(): HookBridgeInfo {
    return this.current;
  }

  get isRunning(): boolean {
    return this.current.status === 'running';
  }

  /** Actual bound port (differs from options when port 0 is used in tests). */
  get port(): number | undefined {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : undefined;
  }

  readonly onEvent = (listener: (events: AgentEvent[]) => void): Disposable => this.eventEmitter.event(listener);
  readonly onDidChangeStatus = (listener: (info: HookBridgeInfo) => void): Disposable =>
    this.statusEmitter.event(listener);

  /** Fires only on an actual change (status, port or error), so bind retries do not flap. */
  private setStatus(info: HookBridgeInfo): void {
    const c = this.current;
    if (c.status === info.status && c.port === info.port && c.error === info.error) return;
    this.current = info;
    this.statusEmitter.fire(info);
  }

  async start(): Promise<void> {
    if (this.server || this.stopped) return;
    // A retry after a failed bind keeps reporting 'unavailable' until it succeeds.
    if (this.current.status !== 'unavailable') this.setStatus({ status: 'starting', port: this.opts.port });
    const server = http.createServer((req, res) => this.handle(req, res));
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 2_000;
    server.maxHeadersCount = 50;
    server.maxRequestsPerSocket = 100;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port: this.opts.port, host: this.host, exclusive: true });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg =
        code === 'EADDRINUSE'
          ? `port ${this.opts.port} is in use (another VS Code window with Claude City, or another program)`
          : `could not listen on ${this.host}:${this.opts.port}: ${(err as Error)?.message ?? String(err)}`;
      if (this.current.status !== 'unavailable' || this.current.error !== msg) this.log(`hook bridge unavailable: ${msg}`);
      server.close();
      this.setStatus({ status: 'unavailable', port: this.opts.port, error: msg });
      if (!this.stopped && this.retryMs > 0) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.start();
        }, this.retryMs);
        this.retryTimer.unref?.();
      }
      return;
    }
    if (this.stopped) {
      server.close();
      return;
    }
    server.on('error', (err) => this.log(`hook bridge error: ${err.message}`));
    server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    this.server = server;
    this.setStatus({ status: 'running', port: this.port ?? this.opts.port });
    this.log(`hook bridge listening on http://${this.host}:${this.port}${HOOK_PATH}`);
  }

  private reply(res: http.ServerResponse, status: number, close = false): void {
    if (res.headersSent) return;
    if (status !== 200) {
      this.stats.rejected++;
      const t = this.now();
      if (t - this.lastRejectLog >= 60_000) {
        this.lastRejectLog = t;
        this.log(`hook bridge rejected a request with HTTP ${status} (logged at most once per minute)`);
      }
    }
    const body = '{}';
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(close ? { Connection: 'close' } : {}),
    });
    res.end(body);
  }

  private rateLimited(): boolean {
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.windowCount = 0;
    }
    return ++this.windowCount > MAX_EVENTS_PER_SECOND;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      // 1. Only our path, only POST.
      const url = req.url ?? '';
      if (url !== HOOK_PATH) return this.drain(req, res, 404);
      if (req.method !== 'POST') return this.drain(req, res, 405);
      // 2. DNS rebinding / browser protection.
      if (!isAllowedHost(req.headers.host, this.port ?? this.opts.port)) return this.drain(req, res, 403);
      if (isBrowserRequest(req.headers)) return this.drain(req, res, 403);
      // 3. Shared secret.
      if (!tokenMatches(this.expectedToken, req.headers[TOKEN_HEADER])) return this.drain(req, res, 401);
      // 4. JSON only.
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!/^application\/json(\s*;.*)?$/.test(ct)) return this.drain(req, res, 415);
      // 5. Size limits (declared and actual).
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > this.maxBody) return this.drain(req, res, 413, true);
      if (this.rateLimited()) return this.drain(req, res, 429);
    } catch (err) {
      this.log(`hook bridge request error: ${(err as Error)?.message ?? String(err)}`);
      return this.drain(req, res, 400, true);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > this.maxBody) {
        aborted = true;
        res.once('finish', () => req.destroy());
        this.reply(res, 413, true);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      aborted = true;
    });
    req.on('end', () => {
      if (aborted) return;
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return this.reply(res, 400);
      }
      // Respond first (hooks must never wait on us), then process.
      const parsed = parseHookPayload(raw, this.now());
      if (!parsed.ok) {
        // Unknown events are acknowledged with 200 so Claude does not log errors for them.
        this.stats.rejected += parsed.reason === 'unknown-event' ? 0 : 1;
        return this.reply(res, parsed.reason === 'unknown-event' ? 200 : 400);
      }
      this.stats.accepted++;
      this.reply(res, 200);
      if (!this.loggedHeaderNames) {
        this.loggedHeaderNames = true;
        // Names only - values (token!) are never logged.
        this.debug(`hook bridge: first accepted request had headers: ${Object.keys(req.headers).sort().join(', ')}`);
      }
      this.eventEmitter.fire([parsed.event]);
    });
  }

  /** Rejects without reading a potentially large body. */
  private drain(req: http.IncomingMessage, res: http.ServerResponse, status: number, close = false): void {
    if (close) res.once('finish', () => req.destroy());
    else req.resume();
    this.reply(res, status, close);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    if (this.current.status !== 'disabled') this.setStatus({ status: 'disabled' });
  }

  dispose(): void {
    void this.stop().finally(() => {
      this.eventEmitter.dispose();
      this.statusEmitter.dispose();
    });
  }
}
