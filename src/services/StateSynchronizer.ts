import { AgentEvent } from '../models/AgentEvent';
import { CityState } from '../models/CityState';
import { Disposable } from '../util/emitter';
import { Timers } from '../backend/SessionManager';
import { MessageBus } from './MessageBus';

export interface SyncTarget extends Disposable {
  /** Webview signalled `ready` -> send full snapshot, then live updates. */
  markReady(): void;
  readonly isReady: boolean;
}

interface TargetEntry {
  bus: Pick<MessageBus, 'post'>;
  ready: boolean;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Fans out state to all open webviews (sidebar + panel).
 * - full snapshot when a webview reports ready
 * - state pushes throttled (leading + trailing edge)
 * - events forwarded immediately
 */
export class StateSynchronizer implements Disposable {
  private readonly targets = new Set<TargetEntry>();
  private throttleTimer: unknown;
  private pending = false;
  private readonly timers: Timers;

  constructor(
    private readonly getState: () => CityState,
    private readonly throttleMs = 150,
    timers?: Timers,
  ) {
    this.timers = timers ?? defaultTimers;
  }

  attach(bus: Pick<MessageBus, 'post'>): SyncTarget {
    const entry: TargetEntry = { bus, ready: false };
    this.targets.add(entry);
    return {
      markReady: () => {
        entry.ready = true;
        void entry.bus.post({ type: 'state', state: this.getState() });
      },
      get isReady() {
        return entry.ready;
      },
      dispose: () => {
        this.targets.delete(entry);
      },
    };
  }

  get targetCount(): number {
    return this.targets.size;
  }

  /** Throttled state push to all ready targets. */
  pushState(): void {
    if (this.throttleTimer !== undefined) {
      this.pending = true;
      return;
    }
    this.broadcastState();
    this.throttleTimer = this.timers.setTimeout(() => this.onThrottleEnd(), this.throttleMs);
  }

  private onThrottleEnd(): void {
    this.throttleTimer = undefined;
    if (this.pending) {
      this.pending = false;
      this.pushState();
    }
  }

  private broadcastState(): void {
    const state = this.getState();
    for (const t of this.targets) if (t.ready) void t.bus.post({ type: 'state', state });
  }

  /** Asks all ready webviews to zoom-to-fit (after the next state they receive). */
  requestFit(): void {
    for (const t of this.targets) if (t.ready) void t.bus.post({ type: 'fitCity' });
  }

  /** Events are forwarded immediately (they are small and drive animations). */
  pushEvents(events: AgentEvent[]): void {
    if (!events.length) return;
    for (const t of this.targets) if (t.ready) void t.bus.post({ type: 'events', events });
  }

  dispose(): void {
    if (this.throttleTimer !== undefined) this.timers.clearTimeout(this.throttleTimer);
    this.throttleTimer = undefined;
    this.targets.clear();
  }
}
