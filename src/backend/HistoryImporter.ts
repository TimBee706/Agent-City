import { Session } from '../models/Session';
import { Disposable } from '../util/emitter';
import type { ArchiveMarker } from './ClaudeArchiveMarker';
import { HistoryScanOptions, HistoryScanStats } from './HistoricalSessions';
import type { HistoryScanResult } from './HistoricalSessions';
import { classifyHistoryTier, toHistorySession } from './historyTiers';
import type { Timers } from './SessionManager';

/** Rescan interval for past sessions (never part of the fast poll loop). */
export const HISTORY_RESCAN_MS = 120_000;

export interface HistoryConfig {
  enabled: boolean;
  maxAgeDays: number;
  /** Non-running sessions active within this many days are "recent" (0 = everything archived). */
  recentDays: number;
  /** Use Claude Code's own archive marker (best effort) in addition to the age rule. */
  useClaudeArchive: boolean;
}

export interface HistoryScannerLike {
  scan(opts: HistoryScanOptions): Promise<HistoryScanResult>;
  persist(): Promise<void>;
  clear(): Promise<void>;
}

export interface HistoryImporterDeps {
  scanner: HistoryScannerLike;
  getConfig: () => HistoryConfig;
  /** Reads Claude Code's archived session ids (best effort, never rejects). */
  readArchiveMarker?: () => Promise<ArchiveMarker>;
  /** Receives the history sessions (recent + archived, ungrouped). Empty array = import off / nothing found. */
  onSessions: (sessions: Session[]) => void;
  /** Aggregate numbers only - never titles or content. */
  log?: (msg: string) => void;
  /**
   * Runs at the start of every cycle (activation, refresh, every `intervalMs`) even when history
   * import is off - used for the workspace-root rescan so imported buildings exist before archived
   * sessions are grouped. Errors are logged, never fatal.
   */
  beforeScan?: () => Promise<void>;
  timers?: Timers;
  intervalMs?: number;
  now?: () => number;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function formatScanStats(s: HistoryScanStats): string {
  return (
    `history: ${s.imported} session(s) imported from ${s.scanned} file(s) ` +
    `(${s.parsed} read, ${s.cacheHits} cached, ${s.failures} failed, ${s.skippedNoCwd} without cwd, ` +
    `${s.candidates} found in ${s.projectDirs} project folder(s)) in ${s.durationMs} ms`
  );
}

/**
 * Schedules history scans: once after `start(after)` resolves (e.g. the first live poll, so
 * activation is never blocked), on `refresh()` and every `intervalMs`. Scans never overlap.
 * Each scan classifies the sessions into recent / archived (see historyTiers.ts).
 */
export class HistoryImporter implements Disposable {
  private timer: unknown;
  private inFlight: Promise<void> | undefined;
  private rerun = false;
  private started = false;
  private disposed = false;
  private lastLogKey = '';
  private readonly timers: Timers;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: HistoryImporterDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.intervalMs = deps.intervalMs ?? HISTORY_RESCAN_MS;
    this.now = deps.now ?? Date.now;
  }

  start(after: Promise<unknown> = Promise.resolve()): void {
    if (this.started || this.disposed) return;
    this.started = true;
    after.then(
      () => void this.refresh(),
      () => void this.refresh(),
    );
  }

  /** Runs a scan now (coalesced with a running one). Never rejects. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = this.runOnce().catch((err) => this.deps.log?.(`history scan failed: ${(err as Error)?.message ?? String(err)}`));
    this.inFlight = run.finally(() => {
      this.inFlight = undefined;
      if (this.disposed) return;
      if (this.rerun) {
        this.rerun = false;
        void this.refresh();
      } else {
        this.schedule();
      }
    });
    return this.inFlight;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.intervalMs);
  }

  private async readMarker(cfg: HistoryConfig): Promise<ArchiveMarker | undefined> {
    if (!cfg.useClaudeArchive || !this.deps.readArchiveMarker) return undefined;
    try {
      return await this.deps.readArchiveMarker();
    } catch {
      return undefined;
    }
  }

  private async runOnce(): Promise<void> {
    if (this.deps.beforeScan) {
      try {
        await this.deps.beforeScan();
      } catch (err) {
        this.deps.log?.(`workspace root rescan failed: ${(err as Error)?.message ?? String(err)}`);
      }
      if (this.disposed) return;
    }
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      this.deps.onSessions([]);
      await this.deps.scanner.clear();
      return;
    }
    const [{ sessions, stats }, marker] = await Promise.all([
      this.deps.scanner.scan({ maxAgeDays: cfg.maxAgeDays }),
      this.readMarker(cfg),
    ]);
    if (this.disposed) return;
    const now = this.now();
    const archivedIds = marker?.available ? marker.ids : undefined;
    let recent = 0;
    let byClaude = 0;
    const out = sessions.map((info) => {
      const t = classifyHistoryTier(info, { now, recentDays: cfg.recentDays, archivedIds });
      if (t.tier === 'recent') recent++;
      else if (t.archivedBy === 'claude') byClaude++;
      return toHistorySession(info, t);
    });
    this.deps.onSessions(out);
    // Periodic rescans are usually pure cache hits - only log when the outcome changed.
    const markerText = !cfg.useClaudeArchive
      ? 'Claude Code archive marker off'
      : marker?.available
        ? `Claude Code archive marker: ${marker.ids.size} id(s)`
        : `Claude Code archive marker unavailable (${marker?.reason ?? 'unknown'})`;
    const key = `${stats.imported}|${stats.scanned}|${stats.failures}|${stats.skippedNoCwd}|${recent}|${byClaude}|${markerText}`;
    if (key !== this.lastLogKey || stats.parsed > 0) {
      this.deps.log?.(
        `${formatScanStats(stats)}; ${recent} recent, ${out.length - recent} archived (${byClaude} archived in Claude Code); ${markerText}`,
      );
    }
    this.lastLogKey = key;
    await this.deps.scanner.persist();
  }

  get isScheduled(): boolean {
    return this.timer !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
