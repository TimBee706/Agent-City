/**
 * Incremental, vscode-free state derived from hook events: subagents per session, attention
 * hints, ended sessions, tasks. Polling stays authoritative for the session list and phases;
 * this only enriches (see SessionManager).
 */
import { AgentEvent } from '../models/AgentEvent';
import { isAttentionNotification } from './hookPayload';

/** A stopped subagent stays visible (walking out) this long. */
export const SUBAGENT_LEAVE_GRACE_MS = 6_000;
/** Subagents / attention hints without any event for this long are dropped (no ghosts). */
export const STALE_MS = 10 * 60_000;
/** Ended sessions keep their "winding down" look this long (polling removes them anyway). */
export const ENDED_SESSION_KEEP_MS = 60_000;
/** Tracked sessions without events are forgotten after this long. */
export const SESSION_FORGET_MS = 30 * 60_000;
const MAX_SUBAGENTS_PER_SESSION = 24;
const MAX_SESSIONS = 300;

export interface SubagentActivity {
  /** City agent id `${sessionId}:${hookAgentId}`. */
  agentId: string;
  sessionId: string;
  agentType: string;
  startedAt: number;
  lastEventAt: number;
  lastEvent?: string;
  stoppedAt?: number;
  idle?: boolean;
  task?: string;
  taskId?: string;
  completedAt?: number;
}

export interface SessionActivity {
  sessionId: string;
  cwd?: string;
  firstEventAt: number;
  lastEventAt: number;
  attentionAt?: number;
  attention?: string;
  endedAt?: number;
  endReason?: string;
  /** Task attached to the main agent (TaskCreated without subagent context). */
  mainTask?: string;
  mainTaskId?: string;
  completedAt?: number;
  failedAt?: number;
  failure?: string;
}

/** Read-only view used by the pure deriveAgents(). */
export interface ActivitySnapshot {
  sessions: ReadonlyMap<string, SessionActivity>;
  subagents: ReadonlyMap<string, SubagentActivity>;
}

export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class HookActivityTracker implements ActivitySnapshot {
  readonly sessions = new Map<string, SessionActivity>();
  readonly subagents = new Map<string, SubagentActivity>();
  private completedDay = '';
  private completedCount = 0;
  lastEventAt: number | undefined;

  tasksCompletedToday(now: number): number {
    return localDayKey(now) === this.completedDay ? this.completedCount : 0;
  }

  clear(): void {
    this.sessions.clear();
    this.subagents.clear();
    this.completedCount = 0;
    this.completedDay = '';
    this.lastEventAt = undefined;
  }

  private session(e: AgentEvent): SessionActivity {
    let s = this.sessions.get(e.sessionId);
    if (!s) {
      if (this.sessions.size >= MAX_SESSIONS) this.evictOldestSession();
      s = { sessionId: e.sessionId, firstEventAt: e.timestamp, lastEventAt: e.timestamp };
      this.sessions.set(e.sessionId, s);
    }
    s.lastEventAt = Math.max(s.lastEventAt, e.timestamp);
    if (e.cwd) s.cwd = e.cwd;
    return s;
  }

  private evictOldestSession(): void {
    let oldest: SessionActivity | undefined;
    for (const s of this.sessions.values()) if (!oldest || s.lastEventAt < oldest.lastEventAt) oldest = s;
    if (oldest) this.forgetSession(oldest.sessionId);
  }

  private forgetSession(id: string): void {
    this.sessions.delete(id);
    for (const [k, a] of this.subagents) if (a.sessionId === id) this.subagents.delete(k);
  }

  private findSubagentForTask(e: AgentEvent): SubagentActivity | undefined {
    if (e.agentId) {
      const direct = this.subagents.get(e.agentId);
      if (direct) return direct;
    }
    if (e.teammate) {
      for (const a of this.subagents.values()) {
        if (a.sessionId === e.sessionId && !a.stoppedAt && a.agentType.toLowerCase() === e.teammate.toLowerCase()) return a;
      }
    }
    return undefined;
  }

  /** Applies events in timestamp order. Hook events only; other sources are ignored. */
  apply(events: readonly AgentEvent[]): void {
    const sorted = [...events].filter((e) => e.source === 'hook').sort((a, b) => a.timestamp - b.timestamp);
    for (const e of sorted) this.applyOne(e);
  }

  private applyOne(e: AgentEvent): void {
    const s = this.session(e);
    this.lastEventAt = Math.max(this.lastEventAt ?? 0, e.timestamp);
    const isMain = !e.agentId || e.agentId.endsWith(':main');
    const sub = !isMain && e.agentId ? this.subagents.get(e.agentId) : undefined;
    if (sub) {
      sub.lastEventAt = e.timestamp;
      sub.lastEvent = e.message;
    }

    // Any activity after a notification means the user has responded.
    if (e.type !== 'notification' && s.attentionAt !== undefined && e.type !== 'teammate-idle') {
      s.attentionAt = undefined;
      s.attention = undefined;
    }

    // Resume: SessionStart cannot be delivered via http hooks (command/mcp_tool only), so any later
    // hook event of an ended session means it was resumed (`claude --resume`) and is alive again.
    if (s.endedAt !== undefined && e.type !== 'session-end' && e.timestamp > s.endedAt) {
      s.endedAt = undefined;
      s.endReason = undefined;
    }

    switch (e.type) {
      case 'session-start': // only from manually configured / legacy hooks
        s.endedAt = undefined;
        s.endReason = undefined;
        break;
      case 'session-end':
        s.endedAt = e.timestamp;
        s.endReason = e.detail;
        for (const a of this.subagents.values()) if (a.sessionId === e.sessionId && !a.stoppedAt) a.stoppedAt = e.timestamp;
        break;
      case 'subagent-start': {
        if (isMain || !e.agentId) break;
        const count = [...this.subagents.values()].filter((a) => a.sessionId === e.sessionId).length;
        if (!sub && count >= MAX_SUBAGENTS_PER_SESSION) break;
        this.subagents.set(e.agentId, {
          agentId: e.agentId,
          sessionId: e.sessionId,
          agentType: e.agentType ?? 'subagent',
          startedAt: sub?.startedAt ?? e.timestamp,
          lastEventAt: e.timestamp,
          lastEvent: e.message,
        });
        break;
      }
      case 'subagent-stop':
        if (sub) {
          sub.stoppedAt = e.timestamp;
          sub.idle = false;
        }
        break;
      case 'task-created': {
        const target = this.findSubagentForTask(e);
        const label = e.task ?? e.taskId;
        if (target) {
          target.task = label;
          target.taskId = e.taskId;
          target.lastEventAt = e.timestamp;
          target.lastEvent = e.message;
        } else {
          s.mainTask = label;
          s.mainTaskId = e.taskId;
        }
        break;
      }
      case 'task-completed': {
        const day = localDayKey(e.timestamp);
        if (day !== this.completedDay) {
          this.completedDay = day;
          this.completedCount = 0;
        }
        this.completedCount++;
        const target =
          this.findSubagentForTask(e) ??
          [...this.subagents.values()].find((a) => a.sessionId === e.sessionId && !!e.taskId && a.taskId === e.taskId);
        if (target) {
          target.completedAt = e.timestamp;
          target.lastEventAt = e.timestamp;
          target.lastEvent = e.message;
          if (!e.taskId || target.taskId === e.taskId) target.task = undefined;
        } else {
          s.completedAt = e.timestamp;
          if (!e.taskId || s.mainTaskId === e.taskId) {
            s.mainTask = undefined;
            s.mainTaskId = undefined;
          }
        }
        break;
      }
      case 'notification':
        if (isAttentionNotification(e)) {
          s.attentionAt = e.timestamp;
          s.attention = e.message.replace(/^Needs attention:\s*/, '');
        }
        break;
      case 'teammate-idle': {
        const t = this.findSubagentForTask(e);
        if (t) t.idle = true;
        break;
      }
      case 'stop-failure':
        s.failedAt = e.timestamp;
        s.failure = e.detail;
        break;
      case 'stop':
        s.failedAt = undefined;
        s.failure = undefined;
        break;
      default:
        break;
    }
  }

  /** Poll reported a phase change for a session -> polling wins over the attention hint. */
  clearAttention(sessionId: string, before: number): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.attentionAt === undefined || s.attentionAt > before) return false;
    s.attentionAt = undefined;
    s.attention = undefined;
    return true;
  }

  /** Removes departed / stale entries. Returns true if anything visible changed. */
  prune(now: number): boolean {
    let changed = false;
    for (const [k, a] of this.subagents) {
      const gone = a.stoppedAt !== undefined && now - a.stoppedAt >= SUBAGENT_LEAVE_GRACE_MS;
      if (gone || now - a.lastEventAt >= STALE_MS) {
        this.subagents.delete(k);
        changed = true;
      }
    }
    for (const [id, s] of this.sessions) {
      if (s.attentionAt !== undefined && now - s.attentionAt >= STALE_MS) {
        s.attentionAt = undefined;
        s.attention = undefined;
        changed = true;
      }
      if (s.endedAt !== undefined && now - s.endedAt >= ENDED_SESSION_KEEP_MS) {
        this.forgetSession(id);
        changed = true;
      } else if (now - s.lastEventAt >= SESSION_FORGET_MS) {
        this.forgetSession(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Earliest future time at which prune() would change something (for a one-shot timer). */
  nextExpiry(now: number): number | undefined {
    let next = Infinity;
    const consider = (t: number) => {
      if (t > now && t < next) next = t;
      else if (t <= now) next = Math.min(next, now + 1);
    };
    for (const a of this.subagents.values()) {
      if (a.stoppedAt !== undefined) consider(a.stoppedAt + SUBAGENT_LEAVE_GRACE_MS);
      consider(a.lastEventAt + STALE_MS);
    }
    for (const s of this.sessions.values()) {
      if (s.attentionAt !== undefined) consider(s.attentionAt + STALE_MS);
      if (s.endedAt !== undefined) consider(s.endedAt + ENDED_SESSION_KEEP_MS);
      consider(s.lastEventAt + SESSION_FORGET_MS);
    }
    return Number.isFinite(next) ? next : undefined;
  }
}
