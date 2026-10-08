import { AgentEvent } from '../models/AgentEvent';
import type { WorkspaceHistoryIndex } from '../models/CityState';
import { CityState, DataSource, HookStatus, emptyCityState } from '../models/CityState';
import { Session } from '../models/Session';
import { demoSessions } from '../demo/demoData';
import { Disposable, Emitter } from '../util/emitter';
import { AgentsResult } from './ClaudeCliClient';
import { EventStore } from './EventStore';
import { MementoLike, WorkspaceRegistry } from './WorkspaceRegistry';
import {
  DEFAULT_ARCHIVED_PER_WORKSPACE,
  DEFAULT_RECENT_PER_WORKSPACE,
  applyArchivedOverflow,
  buildCityState,
  cityFingerprint,
  mergeHistorySessions,
  overlaySessions,
  suppressRedundantDiffEvents,
  transientSessions,
} from './cityStateBuilder';
import { HookActivityTracker } from './hookActivity';
import { diffSessions } from './sessionDiff';

export type DemoMode = 'auto' | 'on' | 'off';

export interface SessionManagerConfig {
  pollIntervalSeconds: number;
  demoMode: DemoMode;
  /** Forwarded to the webviews (ambient day/night tint). */
  dayNight?: boolean;
  /** Maximum archived (history) rooms per building; the rest is shown as "+N archived". */
  historyMaxPerWorkspace?: number;
  /** Maximum recent (resting) rooms per building; the rest is listed in the history index. */
  historyMaxRecentPerWorkspace?: number;
}

export interface SessionSource {
  listSessions(): Promise<AgentsResult>;
  version(): Promise<string | undefined>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionManagerDeps {
  client: SessionSource;
  registry: WorkspaceRegistry;
  events: EventStore;
  getConfig: () => SessionManagerConfig;
  timers?: Timers;
  now?: () => number;
}

export const MIN_POLL_SECONDS = 2;
/** Default poll interval (each `claude agents` call costs ~1.8 s CPU on Windows). */
export const DEFAULT_POLL_SECONDS = 5;
/** Poll interval while no City view is visible (status bar still needs fresh counts). */
export const HIDDEN_POLL_MS = 15_000;
/** Back-off while the CLI is unavailable. */
export const UNAVAILABLE_BACKOFF_MS = 30_000;
/** After this many consecutive errors the last known sessions are dropped (stale data). */
export const MAX_STALE_ERRORS = 3;
/** A hook-only session must show up in polls started this long after its first event, or it is dropped. */
export const TRANSIENT_GRACE_MS = 10_000;

class MemoryMemento implements MementoLike {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Polls `claude agents --json --all` (never overlapping), groups sessions into workspaces,
 * synthesizes diff events and emits a new CityState only when something visible changed.
 */
export class SessionManager implements Disposable {
  private readonly stateEmitter = new Emitter<CityState>();
  private readonly eventsEmitter = new Emitter<AgentEvent[]>();
  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidAddEvents = this.eventsEmitter.event;

  private current: CityState = emptyCityState('loading');
  private fingerprint = '';
  private prevSessions: Session[] | undefined;
  private prevMode: 'live' | 'demo' | undefined;
  private lastLiveSessions: Session[] = [];
  private consecutiveErrors = 0;
  private demoTick = 0;
  private unavailableSince: number | undefined;
  private lastCliCheckAt = 0;
  private demoOverride: boolean | undefined;
  private readonly demoRegistry = new WorkspaceRegistry(new MemoryMemento());
  /** Hook-derived enrichment (subagents, attention, ended sessions). */
  readonly activity = new HookActivityTracker();
  /** Hook-only session ids that polling did not confirm (never shown as transient rooms again). */
  private readonly polledOut = new Set<string>();
  private hookStatus: HookStatus = { bridge: 'disabled', install: 'unknown' };
  private base:
    | {
        sessions: Session[];
        registry: WorkspaceRegistry;
        source: DataSource;
        error: string | undefined;
        cliVersion: string | undefined;
      }
    | undefined;
  private activityTimer: unknown;
  private pollStartedAt = 0;
  /** Imported past sessions (already grouped into workspaces), merged in publish(). */
  private history: Session[] = [];
  /** Ungrouped archived sessions as delivered by the importer (regrouped after registry changes). */
  private rawHistory: readonly Session[] = [];
  private resolveFirstPoll!: () => void;
  /** Resolves after the first poll finished (history import waits for it; never rejects). */
  readonly firstPoll: Promise<void> = new Promise<void>((r) => (this.resolveFirstPoll = r));

  private timer: unknown;
  private inFlight: Promise<void> | undefined;
  private rerunRequested = false;
  private viewsVisible = false;
  private lastPollAt = 0;
  private started = false;
  private disposed = false;

  private readonly timers: Timers;
  private readonly now: () => number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.now = deps.now ?? Date.now;
  }

  get state(): CityState {
    return this.current;
  }

  get isDemoActive(): boolean {
    return this.current.source === 'demo';
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.poll();
  }

  /** Called by the view layer; visible views poll at the configured interval. */
  setViewsVisible(visible: boolean): void {
    const was = this.viewsVisible;
    this.viewsVisible = visible;
    if (visible && !was && this.started && this.now() - this.lastPollAt > this.intervalMs()) {
      void this.refresh();
    }
  }

  /** Runtime demo override from the toggle command (undefined = follow the setting). */
  setDemoOverride(value: boolean | undefined): void {
    this.demoOverride = value;
    void this.refresh();
  }

  toggleDemo(): void {
    this.setDemoOverride(!this.isDemoActive);
  }

  /** Immediately poll (coalesced with an in-flight poll). Never rejects. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.lastCliCheckAt = 0; // explicit refresh always re-checks the CLI
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    return this.poll();
  }

  private intervalMs(): number {
    const s = Number(this.deps.getConfig().pollIntervalSeconds);
    return Math.max(MIN_POLL_SECONDS, Number.isFinite(s) ? s : DEFAULT_POLL_SECONDS) * 1000;
  }

  private poll(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const run = (async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        // Defensive: pollOnce is designed not to throw.
        console.error('[claude-city] poll failed', err);
      }
    })();
    this.inFlight = run.finally(() => {
      this.inFlight = undefined;
      this.lastPollAt = this.now();
      this.resolveFirstPoll();
      if (this.disposed) return;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.poll();
      } else {
        this.schedule();
      }
    });
    return this.inFlight;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    let delay = this.viewsVisible ? this.intervalMs() : Math.max(this.intervalMs(), HIDDEN_POLL_MS);
    if (this.current.source === 'unavailable') delay = Math.max(delay, UNAVAILABLE_BACKOFF_MS);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, delay);
  }

  private wantsDemo(): 'force' | 'auto' | 'never' {
    if (this.demoOverride === true) return 'force';
    if (this.demoOverride === false) return 'never';
    const mode = this.deps.getConfig().demoMode;
    return mode === 'on' ? 'force' : mode === 'off' ? 'never' : 'auto';
  }

  private async pollOnce(): Promise<void> {
    const demo = this.wantsDemo();
    if (demo === 'force') {
      this.applyDemo(undefined);
      return;
    }
    // Back-off: while the CLI is known to be unavailable, only re-check every UNAVAILABLE_BACKOFF_MS.
    // In auto-demo mode the demo city keeps ticking at the normal interval meanwhile.
    if (
      demo === 'auto' &&
      this.unavailableSince !== undefined &&
      this.now() - this.lastCliCheckAt < UNAVAILABLE_BACKOFF_MS
    ) {
      this.applyDemo(this.current.error);
      return;
    }
    this.lastCliCheckAt = this.now();
    this.pollStartedAt = this.now();
    const result = await this.deps.client.listSessions();
    if (this.disposed) return;
    const cliVersion = result.kind === 'ok' ? await this.deps.client.version().catch(() => undefined) : undefined;

    switch (result.kind) {
      case 'ok':
        this.unavailableSince = undefined;
        this.consecutiveErrors = 0;
        this.lastLiveSessions = result.sessions;
        this.applyLive(result.sessions, 'live', undefined, cliVersion);
        break;
      case 'unavailable':
        this.unavailableSince ??= this.now();
        this.consecutiveErrors = 0;
        this.lastLiveSessions = [];
        if (demo === 'auto') this.applyDemo(`Claude CLI unavailable: ${result.reason}`);
        else this.applyLive([], 'unavailable', result.reason, undefined);
        break;
      case 'error':
        this.unavailableSince = undefined;
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= MAX_STALE_ERRORS) this.lastLiveSessions = [];
        this.applyLive(this.lastLiveSessions, 'error', result.message, this.current.cliVersion);
        break;
    }
  }

  private resetIfModeChanged(mode: 'live' | 'demo'): void {
    if (this.prevMode !== mode) {
      // The very first mode keeps hook events that may have arrived before the first poll.
      if (this.prevMode !== undefined) {
        this.deps.events.clear();
        this.activity.clear();
        this.polledOut.clear();
      }
      this.prevSessions = undefined;
      this.prevMode = mode;
    }
  }

  private applyLive(sessions: Session[], source: DataSource, error: string | undefined, cliVersion: string | undefined): void {
    this.resetIfModeChanged('live');
    const grouped = this.deps.registry.groupSessions(sessions);
    if (source === 'live') this.reconcileTransients(grouped);
    void this.deps.registry.flush();
    this.commit(grouped, this.deps.registry, source, error, cliVersion);
  }

  private applyDemo(reason: string | undefined): void {
    this.resetIfModeChanged('demo');
    const sessions = demoSessions(this.demoTick++, this.now());
    const grouped = this.demoRegistry.groupSessions(sessions);
    this.commit(grouped, this.demoRegistry, 'demo', reason, undefined);
  }

  /**
   * Polling is authoritative: hook-only (transient) sessions that a poll started well after their
   * first event still does not report are dropped and not re-created by later hook events.
   */
  private reconcileTransients(polled: readonly Session[]): void {
    const ids = new Set<string>();
    for (const s of polled) {
      ids.add(s.id);
      if (s.sessionId) ids.add(s.sessionId);
    }
    for (const id of ids) this.polledOut.delete(id);
    for (const a of this.activity.sessions.values()) {
      if (ids.has(a.sessionId) || this.polledOut.has(a.sessionId)) continue;
      if (this.pollStartedAt - a.firstEventAt >= TRANSIENT_GRACE_MS) {
        this.polledOut.add(a.sessionId);
        if (this.polledOut.size > 500) this.polledOut.delete(this.polledOut.values().next().value as string);
      }
    }
  }

  private commit(
    sessions: Session[],
    registry: WorkspaceRegistry,
    source: DataSource,
    error: string | undefined,
    cliVersion: string | undefined,
  ): void {
    const now = this.now();
    const rawDiff = diffSessions(this.prevSessions, sessions, now, source === 'demo' ? 'demo' : 'diff');
    this.prevSessions = sessions;
    // A polled phase change overrides an older hook attention hint.
    for (const e of rawDiff) {
      if (e.type === 'session.phaseChanged') this.activity.clearAttention(e.sessionId, this.pollStartedAt);
    }
    const diffEvents = suppressRedundantDiffEvents(rawDiff, this.deps.events.list(), now);
    const added = this.deps.events.add(diffEvents);
    this.base = { sessions, registry, source, error, cliVersion };
    if (added.length) this.eventsEmitter.fire(added);
    this.publish();
  }

  /** Rebuilds the CityState from the last poll + hook activity and emits if it changed. */
  private publish(): void {
    const base = this.base;
    if (!base || this.disposed) return;
    const now = this.now();
    const live = base.source !== 'demo';
    if (live) this.activity.prune(now);
    let sessions = live ? overlaySessions(base.sessions, this.activity) : base.sessions;
    let overflow: ReadonlyMap<string, number> = new Map();
    let recentOverflow: ReadonlyMap<string, number> = new Map();
    let historyIndex: WorkspaceHistoryIndex[] | undefined;
    if (live) {
      const polledIds = new Set<string>();
      for (const s of base.sessions) {
        polledIds.add(s.id);
        if (s.sessionId) polledIds.add(s.sessionId);
      }
      const transient = transientSessions(
        this.activity,
        polledIds,
        this.polledOut,
        (cwd) => this.deps.registry.findForPath(cwd)?.id,
      );
      sessions = [...sessions, ...transient];
      if (this.history.length) {
        // Live and hook-only rooms win over recent / archived ones with the same session id.
        const c = this.deps.getConfig();
        const merged = mergeHistorySessions(sessions, this.history, {
          maxArchivedPerWorkspace: c.historyMaxPerWorkspace ?? DEFAULT_ARCHIVED_PER_WORKSPACE,
          maxRecentPerWorkspace: c.historyMaxRecentPerWorkspace ?? DEFAULT_RECENT_PER_WORKSPACE,
        });
        sessions = merged.sessions;
        overflow = merged.overflow;
        recentOverflow = merged.recentOverflow;
        historyIndex = merged.index;
      }
    }
    const workspaces = applyArchivedOverflow(base.registry.buildCityWorkspaces(sessions), overflow, recentOverflow);
    const cfg = this.deps.getConfig();
    const hooks: HookStatus = { ...this.hookStatus };
    if (this.activity.lastEventAt !== undefined) hooks.lastEventAt = this.activity.lastEventAt;
    const next = buildCityState({
      workspaces,
      sessions,
      events: this.deps.events.list(),
      source: base.source,
      error: base.error,
      cliVersion: base.cliVersion,
      now,
      activity: live ? this.activity : undefined,
      hooks,
      stats: { tasksCompletedToday: live ? this.activity.tasksCompletedToday(now) : 0 },
      config: { dayNight: cfg.dayNight ?? true },
      historyIndex,
    });
    const fp = cityFingerprint(next);
    this.current = next;
    if (fp !== this.fingerprint) {
      this.fingerprint = fp;
      this.stateEmitter.fire(next);
    }
    if (live) this.scheduleActivityTimer(now);
  }

  private scheduleActivityTimer(now: number): void {
    if (this.activityTimer !== undefined) {
      this.timers.clearTimeout(this.activityTimer);
      this.activityTimer = undefined;
    }
    const at = this.activity.nextExpiry(now);
    if (at === undefined || this.disposed) return;
    this.activityTimer = this.timers.setTimeout(() => {
      this.activityTimer = undefined;
      this.publish();
    }, Math.max(250, at - now));
  }

  /**
   * Merges live hook events (from the HookBridge). Events are deduped, forwarded immediately and
   * reflected in the state without waiting for the next poll. Ignored while demo data is shown.
   */
  ingestHookEvents(events: readonly AgentEvent[]): void {
    if (this.disposed || !events.length || this.current.source === 'demo' || this.prevMode === 'demo') return;
    const enriched = events.map((e) => {
      if (e.workspaceId) return e;
      const polled = this.base?.sessions.find((s) => s.id === e.sessionId || s.sessionId === e.sessionId);
      const wsId = polled?.workspaceId ?? (e.cwd ? this.deps.registry.findForPath(e.cwd)?.id : undefined);
      return wsId ? { ...e, workspaceId: wsId } : e;
    });
    const added = this.deps.events.add(enriched);
    if (!added.length) return;
    this.activity.apply(added);
    this.eventsEmitter.fire(added);
    if (this.base) this.publish();
  }

  /**
   * Replaces the imported past sessions. They are grouped into workspaces here (registering new
   * workspaces without touching lastSeen) and never produce feed events.
   */
  setHistorySessions(sessions: readonly Session[]): void {
    if (this.disposed) return;
    this.rawHistory = sessions;
    this.regroupHistory();
  }

  /**
   * Re-assigns archived sessions to workspaces (e.g. after an import or a removal changed the
   * registry) and re-publishes. Live sessions are regrouped by the next poll / refresh.
   */
  regroupHistory(): void {
    if (this.disposed) return;
    this.history = this.rawHistory.length ? this.deps.registry.groupSessions(this.rawHistory, { touch: false }) : [];
    void this.deps.registry.flush();
    if (this.base) this.publish();
  }

  /** Number of imported past sessions currently known (before dedupe / per-workspace limit). */
  get historyCount(): number {
    return this.history.length;
  }

  /** Bridge / installer status shown in the HUD and sidebar. */
  setHookStatus(status: HookStatus): void {
    this.hookStatus = { ...status };
    if (this.base) this.publish();
  }

  /** Re-publish after UI config changes (no poll needed). */
  republish(): void {
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    if (this.activityTimer !== undefined) this.timers.clearTimeout(this.activityTimer);
    this.timer = undefined;
    this.activityTimer = undefined;
    this.stateEmitter.dispose();
    this.eventsEmitter.dispose();
    void this.deps.registry.flush();
  }
}
