/**
 * Pure helpers for HUD highlights, ambient lighting, live-region announcements and transient
 * visual effects (no DOM / React).
 */
import type { AgentEvent } from '../models/AgentEvent';
import type { CityState } from '../models/CityState';
import type { Session } from '../models/Session';
import { sessionLabel, sessionPhase } from '../models/Session';

export interface Highlights {
  mostActive?: { id: string; name: string; active: number };
  attention: Session[];
  working: number;
  idle: number;
  completedToday: number;
}

export function computeHighlights(state: Pick<CityState, 'workspaces' | 'sessions' | 'stats'>): Highlights {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  let mostActive: Highlights['mostActive'];
  for (const w of state.workspaces) {
    const active = w.sessionIds.filter((id) => {
      const s = byId.get(id);
      const p = s ? sessionPhase(s) : 'unknown';
      return p === 'working' || p === 'waiting';
    }).length;
    if (active > 0 && (!mostActive || active > mostActive.active || (active === mostActive.active && w.name < mostActive.name))) {
      mostActive = { id: w.id, name: w.name, active };
    }
  }
  let working = 0;
  let idle = 0;
  const attention: Session[] = [];
  for (const s of state.sessions) {
    const p = sessionPhase(s);
    if (p === 'working') working++;
    else if (p === 'waiting') attention.push(s);
    else if (p === 'idle' || p === 'unknown') idle++;
  }
  attention.sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || a.id.localeCompare(b.id));
  const out: Highlights = { attention, working, idle, completedToday: state.stats?.tasksCompletedToday ?? 0 };
  if (mostActive) out.mostActive = mostActive;
  return out;
}

export type DayPeriod = 'dawn' | 'day' | 'dusk' | 'night';

export function dayPeriod(hour: number): DayPeriod {
  if (hour >= 6 && hour < 9) return 'dawn';
  if (hour >= 9 && hour < 17) return 'day';
  if (hour >= 17 && hour < 21) return 'dusk';
  return 'night';
}

/** Text for the polite live region; undefined = not important enough to announce. */
export function announcementFor(e: AgentEvent, sessions: readonly Session[]): string | undefined {
  const s = sessions.find((x) => x.id === e.sessionId || x.sessionId === e.sessionId);
  const where = s ? sessionLabel(s) : `session ${e.sessionId.slice(0, 8)}`;
  switch (e.type) {
    case 'notification':
      return `${where} needs your attention`;
    case 'task-completed':
      return `${where}: ${e.message}`;
    case 'stop-failure':
      return `${where}: ${e.message}`;
    case 'subagent-start':
      return `${where}: ${e.message}`;
    case 'session.phaseChanged':
      return e.to === 'waiting' || e.to === 'failed' ? `${where} is now ${e.to === 'waiting' ? 'waiting for input' : 'failed'}` : undefined;
    default:
      return undefined;
  }
}

/** Combines several pending announcements into one short sentence. */
export function combineAnnouncements(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]}. ${items[1]}`;
  return `${items[items.length - 1]}, and ${items.length - 1} more updates`;
}

export const SPARKLE_MS = 1800;

/** Agent ids that should sparkle (TaskCompleted), mapped to the city agent id. */
export function sparkleTargets(events: readonly AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (e.type === 'task-completed' && e.agentId) out.push(e.agentId);
  return out;
}
