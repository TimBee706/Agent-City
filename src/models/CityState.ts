import { Agent } from './Agent';
import { AgentEvent } from './AgentEvent';
import { ArchiveReason, HistoryTier, Session, sessionPhase } from './Session';
import { CityWorkspace } from './Workspace';

/** Where the data shown in the city comes from. */
export type DataSource = 'live' | 'demo' | 'unavailable' | 'error' | 'loading';

/** Status of the loopback hook bridge (live events). */
export type HookBridgeStatus = 'disabled' | 'starting' | 'running' | 'unavailable';
/** Whether Claude City hooks are present in a Claude settings file (user or open workspace). */
export type HookInstallState = 'none' | 'current' | 'outdated' | 'unknown';

export interface HookStatus {
  bridge: HookBridgeStatus;
  install: HookInstallState;
  port?: number;
  error?: string;
  /** Time of the last received hook event (volatile, not part of the fingerprint). */
  lastEventAt?: number;
}

export interface CityStats {
  /** TaskCompleted hook events seen today (local time) while the extension was running. */
  tasksCompletedToday: number;
}

/** UI-relevant settings forwarded to the webviews. */
export interface CityUiConfig {
  dayNight: boolean;
}

/**
 * Lightweight summary of a past session that is not (necessarily) shown as a room: all archived
 * sessions of a workspace plus recent ones over the room limit (for lists / a future basement view).
 */
export interface HistorySummary {
  /** Claude session id (validated UUID-like). */
  id: string;
  title?: string;
  lastActivityAt: number;
  gitBranch?: string;
  tier: HistoryTier;
  archivedBy?: ArchiveReason;
}

/** Per-workspace history index (newest first, capped; `total` is the uncapped count). */
export interface WorkspaceHistoryIndex {
  workspaceId: string;
  total: number;
  items: HistorySummary[];
}

export interface CityState {
  workspaces: CityWorkspace[];
  sessions: Session[];
  agents: Agent[];
  events: AgentEvent[];
  source: DataSource;
  /** Reason shown when source is unavailable/error, or why demo is active. */
  error?: string;
  /** Claude CLI version string if known. */
  cliVersion?: string;
  updatedAt: number;
  hooks?: HookStatus;
  stats?: CityStats;
  config?: CityUiConfig;
  /** History index per workspace (only workspaces that have archived / overflowing recent sessions). */
  historyIndex?: WorkspaceHistoryIndex[];
}

export interface CityCounts {
  workspaces: number;
  sessions: number;
  working: number;
  waiting: number;
  idle: number;
  done: number;
  failed: number;
  stopped: number;
  /** Recent (not running, resumable) past sessions incl. those over the room limit - not part of `sessions`. */
  recent: number;
  /** Archived past sessions incl. those over the room limit - not part of `sessions` nor of any phase counter. */
  archived: number;
}

export function computeCounts(state: Pick<CityState, 'workspaces' | 'sessions'>): CityCounts {
  const c: CityCounts = {
    workspaces: state.workspaces.length,
    sessions: 0,
    working: 0,
    waiting: 0,
    idle: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    recent: 0,
    archived: 0,
  };
  for (const w of state.workspaces) {
    c.archived += w.archivedOverflow ?? 0;
    c.recent += w.recentOverflow ?? 0;
  }
  for (const s of state.sessions) {
    const p = sessionPhase(s);
    if (p === 'archived') {
      c.archived++;
      continue;
    }
    if (p === 'resting') {
      c.recent++;
      continue;
    }
    c.sessions++;
    if (p === 'unknown') c.idle++;
    else c[p]++;
  }
  return c;
}

export function emptyCityState(source: DataSource = 'loading'): CityState {
  return { workspaces: [], sessions: [], agents: [], events: [], source, updatedAt: Date.now() };
}

/** Short status bar text, e.g. "3 working · 1 waiting". */
export function summaryText(c: CityCounts): string {
  const parts: string[] = [];
  if (c.working) parts.push(`${c.working} working`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (!parts.length) parts.push(c.sessions ? `${c.sessions} idle` : 'no sessions');
  return parts.join(' · ');
}
