import { Agent, mainAgentForSession } from '../models/Agent';
import { AgentEvent } from '../models/AgentEvent';
import { CityState, CityStats, CityUiConfig, DataSource, HistorySummary, HookStatus, WorkspaceHistoryIndex } from '../models/CityState';
import { Session, isArchived, isHistory } from '../models/Session';
import { CityWorkspace } from '../models/Workspace';
import { stableStringify } from '../util/hash';
import type { ActivitySnapshot, SessionActivity } from './hookActivity';

export interface BuildInput {
  workspaces: CityWorkspace[];
  sessions: Session[];
  events: AgentEvent[];
  source: DataSource;
  error?: string;
  cliVersion?: string;
  now: number;
  activity?: ActivitySnapshot;
  hooks?: HookStatus;
  stats?: CityStats;
  config?: CityUiConfig;
  historyIndex?: WorkspaceHistoryIndex[];
}

/** Number of events embedded in full snapshots (the extension keeps up to 500). */
export const SNAPSHOT_EVENT_LIMIT = 100;
/** Window in which a hook SessionEnd (or legacy SessionStart) makes the synthesized left/appeared redundant. */
export const REDUNDANT_DIFF_WINDOW_MS = 60_000;

/** Applies hook-derived overlays (attention, ended) to polled sessions. Returns new objects. */
export function overlaySessions(sessions: readonly Session[], activity: ActivitySnapshot | undefined): Session[] {
  if (!activity || activity.sessions.size === 0) return [...sessions];
  return sessions.map((s) => {
    const a = activity.sessions.get(s.sessionId ?? s.id) ?? activity.sessions.get(s.id);
    if (!a) return s;
    const out: Session = { ...s };
    if (a.attention !== undefined && a.attentionAt !== undefined) out.attention = a.attention;
    if (a.endedAt !== undefined) out.endedAt = a.endedAt;
    return out;
  });
}

/**
 * Hook-only rooms: sessions seen via hooks but not in the polled list. Created only if the cwd maps
 * to a known workspace (`resolveWorkspace`), never for ended sessions or ids polling already
 * rejected (`excluded`).
 */
export function transientSessions(
  activity: ActivitySnapshot | undefined,
  polledIds: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  resolveWorkspace: (cwd: string) => string | undefined,
): Session[] {
  if (!activity) return [];
  const out: Session[] = [];
  for (const a of activity.sessions.values()) {
    if (polledIds.has(a.sessionId) || excluded.has(a.sessionId) || a.endedAt !== undefined || !a.cwd) continue;
    const workspaceId = resolveWorkspace(a.cwd);
    if (!workspaceId) continue;
    const hasActiveSub = [...activity.subagents.values()].some((x) => x.sessionId === a.sessionId && !x.stoppedAt);
    const s: Session = {
      id: a.sessionId,
      sessionId: a.sessionId,
      cwd: a.cwd,
      kind: 'hook',
      state: hasActiveSub ? 'working' : 'unknown',
      status: hasActiveSub ? 'busy' : 'unknown',
      startedAt: a.firstEventAt,
      workspaceId,
      transient: true,
    };
    if (a.attention !== undefined) s.attention = a.attention;
    out.push(s);
  }
  return out;
}

/**
 * Drops synthesized `session.disappeared` events when a hook SessionEnd for the same session was seen
 * recently (the hook event already tells the story). SessionStart is not available as an http hook,
 * so `session.appeared` normally stays - it is only dropped if a `session-start` hook event exists
 * (manually configured or legacy installs).
 */
export function suppressRedundantDiffEvents(
  diffEvents: readonly AgentEvent[],
  recent: readonly AgentEvent[],
  now: number,
  windowMs = REDUNDANT_DIFF_WINDOW_MS,
): AgentEvent[] {
  const started = new Set<string>();
  const ended = new Set<string>();
  for (const e of recent) {
    if (e.source !== 'hook' || now - e.timestamp > windowMs) continue;
    if (e.type === 'session-start') started.add(e.sessionId);
    if (e.type === 'session-end') ended.add(e.sessionId);
  }
  return diffEvents.filter(
    (e) =>
      !(e.type === 'session.appeared' && started.has(e.sessionId)) &&
      !(e.type === 'session.disappeared' && ended.has(e.sessionId)),
  );
}

/** Default number of archived rooms per building. */
export const DEFAULT_ARCHIVED_PER_WORKSPACE = 12;
/** Default number of recent (resting) rooms per building. */
export const DEFAULT_RECENT_PER_WORKSPACE = 20;
/** History index: summaries per workspace / in total (keeps the webview payload bounded). */
export const HISTORY_INDEX_PER_WORKSPACE = 200;
export const HISTORY_INDEX_TOTAL = 2000;

export interface HistoryLimits {
  /** Archived rooms per building (rest: `archivedOverflow`, still listed in the history index). */
  maxArchivedPerWorkspace: number;
  /** Recent rooms per building (rest: `recentOverflow`, listed in the history index). */
  maxRecentPerWorkspace: number;
  indexPerWorkspace?: number;
  indexTotal?: number;
}

export interface HistoryMerge {
  /** Active sessions followed by the recent and archived sessions that are shown as rooms. */
  sessions: Session[];
  /** Per workspace: archived sessions over the limit (not shown as rooms). */
  overflow: Map<string, number>;
  /** Per workspace: recent sessions over the limit (not shown as rooms). */
  recentOverflow: Map<string, number>;
  /** Lightweight summaries: every archived session + recent ones over the limit (capped). */
  index: WorkspaceHistoryIndex[];
}

function limitOf(v: number | undefined, fallback: number): number {
  return Math.max(0, Math.floor(typeof v === 'number' && Number.isFinite(v) ? v : fallback));
}

function summaryOf(s: Session): HistorySummary {
  const out: HistorySummary = {
    id: s.sessionId ?? s.id,
    lastActivityAt: s.lastActivityAt ?? 0,
    tier: isArchived(s) ? 'archived' : 'recent',
  };
  if (s.name) out.title = s.name;
  if (s.gitBranch) out.gitBranch = s.gitBranch;
  if (s.archivedBy) out.archivedBy = s.archivedBy;
  return out;
}

const newestFirst = (a: Session, b: Session) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.id.localeCompare(b.id);

/**
 * Adds history sessions (recent + archived) to the active ones. Live/polled and hook-only sessions
 * always win (dedupe by id and Claude session id) - this also covers finished sessions that
 * `claude agents --json --all` still reports. Per workspace only the most recent `maxRecent` recent
 * and `maxArchived` archived sessions become rooms; the rest is reported as overflow. All archived
 * sessions (and recent ones over the limit) are summarized in the bounded history index.
 * History sessions must already be grouped. A plain number is the archived limit (legacy signature).
 */
export function mergeHistorySessions(
  active: readonly Session[],
  history: readonly Session[],
  limits: number | HistoryLimits,
): HistoryMerge {
  const lim: HistoryLimits =
    typeof limits === 'number' ? { maxArchivedPerWorkspace: limits, maxRecentPerWorkspace: DEFAULT_RECENT_PER_WORKSPACE } : limits;
  const maxArchived = limitOf(lim.maxArchivedPerWorkspace, DEFAULT_ARCHIVED_PER_WORKSPACE);
  const maxRecent = limitOf(lim.maxRecentPerWorkspace, DEFAULT_RECENT_PER_WORKSPACE);
  const perWsIndex = limitOf(lim.indexPerWorkspace, HISTORY_INDEX_PER_WORKSPACE);
  const totalIndex = limitOf(lim.indexTotal, HISTORY_INDEX_TOTAL);

  const taken = new Set<string>();
  for (const s of active) {
    taken.add(s.id);
    if (s.sessionId) taken.add(s.sessionId);
  }
  const byWs = new Map<string, { recent: Session[]; archived: Session[] }>();
  for (const h of history) {
    if (!isHistory(h) || !h.workspaceId || taken.has(h.id) || (h.sessionId && taken.has(h.sessionId))) continue;
    taken.add(h.id);
    if (h.sessionId) taken.add(h.sessionId);
    const entry = byWs.get(h.workspaceId) ?? { recent: [], archived: [] };
    (isArchived(h) ? entry.archived : entry.recent).push(h);
    byWs.set(h.workspaceId, entry);
  }
  const shown: Session[] = [];
  const overflow = new Map<string, number>();
  const recentOverflow = new Map<string, number>();
  const indexCandidates: { wsId: string; total: number; items: Session[] }[] = [];
  for (const [wsId, { recent, archived }] of [...byWs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    recent.sort(newestFirst);
    archived.sort(newestFirst);
    shown.push(...recent.slice(0, maxRecent), ...archived.slice(0, maxArchived));
    if (recent.length > maxRecent) recentOverflow.set(wsId, recent.length - maxRecent);
    if (archived.length > maxArchived) overflow.set(wsId, archived.length - maxArchived);
    const listed = [...recent.slice(maxRecent), ...archived].sort(newestFirst);
    if (listed.length) indexCandidates.push({ wsId, total: listed.length, items: listed.slice(0, perWsIndex) });
  }
  // Global cap: keep the newest summaries across all workspaces.
  const all = indexCandidates.flatMap((c) => c.items).sort(newestFirst);
  const keep = new Set(all.slice(0, totalIndex));
  const index: WorkspaceHistoryIndex[] = indexCandidates.map((c) => ({
    workspaceId: c.wsId,
    total: c.total,
    items: c.items.filter((s) => keep.has(s)).map(summaryOf),
  }));
  return { sessions: [...active, ...shown], overflow, recentOverflow, index };
}

/** Sets `archivedOverflow` / `recentOverflow` on the workspaces (returns new objects only where needed). */
export function applyArchivedOverflow(
  workspaces: CityWorkspace[],
  overflow: ReadonlyMap<string, number>,
  recentOverflow: ReadonlyMap<string, number> = new Map(),
): CityWorkspace[] {
  if (!overflow.size && !recentOverflow.size) return workspaces;
  return workspaces.map((w) => {
    const n = overflow.get(w.id);
    const r = recentOverflow.get(w.id);
    if (!n && !r) return w;
    const out = { ...w };
    if (n) out.archivedOverflow = n;
    if (r) out.recentOverflow = r;
    return out;
  });
}

function activityFor(activity: ActivitySnapshot | undefined, s: Session): SessionActivity | undefined {
  return activity?.sessions.get(s.sessionId ?? s.id) ?? activity?.sessions.get(s.id);
}

/**
 * One main agent per session (state from polling, attention/task from hooks) plus hook-derived
 * subagent characters (SubagentStart -> working, SubagentStop -> leaving, TeammateIdle -> idle).
 */
export function deriveAgents(
  sessions: readonly Session[],
  events: readonly AgentEvent[],
  activity?: ActivitySnapshot,
): Agent[] {
  const lastByAgent = new Map<string, AgentEvent>();
  for (const e of events) if (e.agentId) lastByAgent.set(e.agentId, e);
  const out: Agent[] = [];
  for (const s of sessions) {
    if (isHistory(s)) continue; // past (recent / archived) rooms have no agents
    const a = mainAgentForSession(s);
    const act = activityFor(activity, s);
    if (act) {
      if (s.attention) {
        a.characterState = 'blocked';
        a.attention = s.attention;
      }
      if (s.endedAt !== undefined) a.characterState = 'stopped';
      if (act.mainTask && !s.waitingFor) a.task = act.mainTask;
      if (act.completedAt !== undefined) a.completedAt = act.completedAt;
    }
    const last = lastByAgent.get(a.agentId);
    if (last) {
      a.lastEvent = last.message;
      a.lastEventAt = last.timestamp;
    }
    out.push(a);

    if (!activity) continue;
    const sid = s.sessionId ?? s.id;
    const subs = [...activity.subagents.values()]
      .filter((x) => x.sessionId === sid || x.sessionId === s.id)
      .sort((x, y) => x.startedAt - y.startedAt || (x.agentId < y.agentId ? -1 : 1));
    for (const sub of subs) {
      const agent: Agent = {
        agentId: `${s.id}:${sub.agentId.slice(sub.sessionId.length + 1)}`,
        agentType: sub.agentType,
        role: 'subagent',
        parentSessionId: s.id,
        parentAgentId: a.agentId,
        name: sub.agentType,
        characterState: sub.stoppedAt !== undefined ? 'done' : sub.idle ? 'idle' : 'working',
        spawnedAt: sub.startedAt,
      };
      if (s.workspaceId) agent.workspaceId = s.workspaceId;
      if (sub.stoppedAt !== undefined) agent.leaving = true;
      if (sub.task) agent.task = sub.task;
      if (sub.completedAt !== undefined) agent.completedAt = sub.completedAt;
      if (sub.lastEvent) {
        agent.lastEvent = sub.lastEvent;
        agent.lastEventAt = sub.lastEventAt;
      }
      out.push(agent);
    }
  }
  return out;
}

export function buildCityState(input: BuildInput): CityState {
  const sessions = [...input.sessions].sort((a, b) => a.id.localeCompare(b.id));
  const state: CityState = {
    workspaces: input.workspaces,
    sessions,
    agents: deriveAgents(sessions, input.events, input.activity),
    events: input.events.slice(-SNAPSHOT_EVENT_LIMIT),
    source: input.source,
    updatedAt: input.now,
  };
  if (input.error) state.error = input.error;
  if (input.cliVersion) state.cliVersion = input.cliVersion;
  if (input.hooks) state.hooks = input.hooks;
  if (input.stats) state.stats = input.stats;
  if (input.config) state.config = input.config;
  if (input.historyIndex?.length) state.historyIndex = input.historyIndex;
  return state;
}

/**
 * Fingerprint of everything that is visually relevant, excluding volatile fields
 * (updatedAt, events, workspace firstSeen/lastSeen, agent lastEvent, hook lastEventAt) so that
 * unchanged polls do not trigger webview updates.
 */
export function cityFingerprint(state: CityState): string {
  return stableStringify({
    source: state.source,
    error: state.error,
    cliVersion: state.cliVersion,
    workspaces: state.workspaces.map((w) => ({
      id: w.id,
      path: w.path,
      name: w.name,
      open: w.open,
      source: w.source,
      pinned: w.pinned,
      missing: w.missing,
      root: w.root,
      sessionIds: w.sessionIds,
      archivedOverflow: w.archivedOverflow,
      recentOverflow: w.recentOverflow,
    })),
    sessions: state.sessions,
    agents: state.agents.map((a) => ({ ...a, lastEvent: undefined, lastEventAt: undefined })),
    hooks: state.hooks ? { ...state.hooks, lastEventAt: undefined } : undefined,
    stats: state.stats,
    config: state.config,
    historyIndex: state.historyIndex,
  });
}
