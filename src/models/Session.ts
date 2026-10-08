import { stableId } from '../util/hash';

/** Normalized lifecycle state of a Claude Code session. */
export type SessionState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | 'unknown';
/** Normalized activity status of a Claude Code session. */
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'unknown';
/**
 * Single derived "phase" used for counts, colors and character animation.
 * Combines state + status (the live CLI currently reports only `status` for interactive sessions).
 */
export type SessionPhase = 'working' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped' | 'unknown' | 'resting' | 'archived';
/** Where a session comes from: live polling/hooks, or an imported past transcript (read-only). */
export type SessionOrigin = 'live' | 'history';
/**
 * Visibility tier:
 *  - live: reported by `claude agents --json --all` / hooks (running, or finished but still listed)
 *  - recent: not running, resumable, still in Claude Code's normal session list (phase "resting")
 *  - archived: archived in Claude Code (marker available), or - fallback without marker - inactive
 *    longer than `claudeCity.history.recentDays`
 */
export type SessionTier = 'live' | 'recent' | 'archived';
/** History tiers (a history session is never 'live'). */
export type HistoryTier = Exclude<SessionTier, 'live'>;
/** Why a history session is archived: Claude Code's own archive marker, or the age fallback. */
export type ArchiveReason = 'claude' | 'age';

/** Raw entry as emitted by `claude agents --json --all` (all fields optional / untrusted). */
export interface RawSession {
  cwd?: unknown;
  kind?: unknown;
  startedAt?: unknown;
  id?: unknown;
  state?: unknown;
  pid?: unknown;
  status?: unknown;
  waitingFor?: unknown;
  sessionId?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

export interface Session {
  /** Stable id: sessionId ?? id ?? hash(cwd+startedAt+pid). */
  id: string;
  sessionId?: string;
  name?: string;
  cwd?: string;
  kind: string;
  pid?: number;
  startedAt?: number;
  state: SessionState;
  status: SessionStatus;
  waitingFor?: string;
  /** Raw values kept for the detail panel / debugging. */
  rawState?: string;
  rawStatus?: string;
  /** Assigned by WorkspaceRegistry grouping. */
  workspaceId?: string;
  /** Hook-only room for a session not (yet) reported by polling. Polling wins on the next poll. */
  transient?: boolean;
  /** SessionEnd hook received (room winds down until polling removes it). */
  endedAt?: number;
  /** Notification hook: session needs user attention (until polling/activity says otherwise). */
  attention?: string;
  /** Undefined = live. 'history' = imported from a past transcript (no agents, see `tier`). */
  origin?: SessionOrigin;
  /** History only: 'recent' (phase "resting") or 'archived' (the default when missing). */
  tier?: HistoryTier;
  /** History + archived only: why it is archived. */
  archivedBy?: ArchiveReason;
  /** History: git branch recorded in the transcript. */
  gitBranch?: string;
  /** History: last transcript activity (epoch ms). */
  lastActivityAt?: number;
  /** History: number of subagent transcripts, if known. */
  subagentCount?: number;
}

const MAX_TEXT = 300;

function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t.slice(0, MAX_TEXT) : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * Converts seconds / milliseconds epoch numbers, numeric strings and ISO strings to epoch ms.
 * Values below 1e11 are treated as seconds (1e11 s is year 5138; 1e11 ms is 1973).
 */
export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return undefined;
    return Math.round(v < 1e11 ? v * 1000 : v);
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return undefined;
    if (/^\d+(\.\d+)?$/.test(t)) return parseTimestamp(Number(t));
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

const STATE_MAP: Record<string, SessionState> = {
  working: 'working', running: 'working', active: 'working', busy: 'working', in_progress: 'working', started: 'working',
  blocked: 'blocked', waiting: 'blocked', needs_input: 'blocked', waiting_for_input: 'blocked', awaiting_input: 'blocked',
  paused: 'blocked', permission: 'blocked',
  done: 'done', completed: 'done', complete: 'done', finished: 'done', succeeded: 'done', success: 'done',
  failed: 'failed', failure: 'failed', error: 'failed', errored: 'failed', crashed: 'failed',
  stopped: 'stopped', killed: 'stopped', cancelled: 'stopped', canceled: 'stopped', exited: 'stopped',
  terminated: 'stopped', aborted: 'stopped',
};

const STATUS_MAP: Record<string, SessionStatus> = {
  busy: 'busy', working: 'busy', running: 'busy', thinking: 'busy', active: 'busy',
  waiting: 'waiting', blocked: 'waiting', needs_input: 'waiting', waiting_for_input: 'waiting', awaiting_input: 'waiting',
  idle: 'idle', ready: 'idle',
};

function mapKey(v: string | undefined): string {
  return (v ?? '').toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeState(v: unknown): SessionState {
  return STATE_MAP[mapKey(str(v))] ?? 'unknown';
}

export function normalizeStatus(v: unknown): SessionStatus {
  return STATUS_MAP[mapKey(str(v))] ?? 'unknown';
}

function waitingForText(v: unknown): string | undefined {
  const s = str(v);
  if (s) return s;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return str(o.type) ?? str(o.reason) ?? str(o.tool) ?? str(o.message) ?? 'input';
  }
  if (v === true) return 'input';
  return undefined;
}

/**
 * Normalizes one raw CLI entry. Returns undefined if the entry carries no identity at all
 * (no sessionId, id, cwd or pid) - such entries are counted as malformed by the caller.
 */
export function normalizeSession(raw: unknown): Session | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as RawSession;
  const sessionId = str(r.sessionId);
  const rawId = str(r.id);
  const cwd = str(r.cwd);
  const pid = int(r.pid);
  const startedAt = parseTimestamp(r.startedAt);
  if (!sessionId && !rawId && !cwd && pid === undefined) return undefined;

  const id = sessionId ?? rawId ?? 'h' + stableId(`${cwd ?? ''}|${startedAt ?? ''}|${pid ?? ''}`);
  const rawState = str(r.state);
  const rawStatus = str(r.status);
  const session: Session = {
    id,
    kind: str(r.kind) ?? 'unknown',
    state: normalizeState(rawState),
    status: normalizeStatus(rawStatus),
  };
  if (sessionId) session.sessionId = sessionId;
  const name = str(r.name);
  if (name) session.name = name;
  if (cwd) session.cwd = cwd;
  if (pid !== undefined) session.pid = pid;
  if (startedAt !== undefined) session.startedAt = startedAt;
  const waitingFor = waitingForText(r.waitingFor);
  if (waitingFor) session.waitingFor = waitingFor;
  if (rawState) session.rawState = rawState;
  if (rawStatus) session.rawStatus = rawStatus;
  return session;
}

/** Derives the single display phase. Terminal states win over live status. */
export function sessionPhase(
  s: Pick<Session, 'state' | 'status' | 'waitingFor'> & Partial<Pick<Session, 'attention' | 'endedAt' | 'origin' | 'tier'>>,
): SessionPhase {
  if (s.origin === 'history') return s.tier === 'recent' ? 'resting' : 'archived';
  if (s.endedAt !== undefined && s.state !== 'failed' && s.state !== 'done') return 'stopped';
  switch (s.state) {
    case 'failed':
      return 'failed';
    case 'done':
      return 'done';
    case 'stopped':
      return 'stopped';
    case 'blocked':
      return 'waiting';
    default:
      break;
  }
  if (s.status === 'waiting' || s.waitingFor || s.attention) return 'waiting';
  if (s.status === 'busy') return 'working';
  if (s.status === 'idle') return 'idle';
  if (s.state === 'working') return 'working';
  return 'unknown';
}

/** Tier of a session (live for everything that does not come from a transcript). */
export function sessionTier(s: Partial<Pick<Session, 'origin' | 'tier'>>): SessionTier {
  if (s.origin !== 'history') return 'live';
  return s.tier === 'recent' ? 'recent' : 'archived';
}

/** True for imported past sessions (recent or archived): read-only, no agents, never counted as active. */
export function isHistory(s: Partial<Pick<Session, 'origin'>>): boolean {
  return s.origin === 'history';
}

/** True for archived past sessions (shown in the building's archive section). */
export function isArchived(s: Partial<Pick<Session, 'origin' | 'tier'>>): boolean {
  return sessionTier(s) === 'archived';
}

/** True for recent (resumable, not archived, not running) past sessions. */
export function isRecent(s: Partial<Pick<Session, 'origin' | 'tier'>>): boolean {
  return sessionTier(s) === 'recent';
}

/** Human readable label for a session. */
export function sessionLabel(s: Pick<Session, 'name' | 'id'>): string {
  return s.name ?? `session ${s.id.slice(0, 8)}`;
}
