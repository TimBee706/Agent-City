/**
 * Pure building ordering shared by the city layout (no DOM / React). The isometric placement lives
 * in cityLayout.ts, the building view in buildingInterior.ts.
 */
import { Session, sessionPhase } from '../models/Session';

export interface LayoutWorkspace {
  id: string;
  name: string;
  open?: boolean;
  sessionIds: string[];
  /** Archived sessions over the per-building limit (only counted, "+N archived"). */
  archivedOverflow?: number;
}
export interface LayoutSession extends Partial<Pick<Session, 'state' | 'status' | 'waitingFor' | 'attention' | 'endedAt'>> {
  id: string;
  startedAt?: number;
  /** 'history' = past session (recent or archived). */
  origin?: 'live' | 'history';
  tier?: 'recent' | 'archived';
  lastActivityAt?: number;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True if the session is working or waiting (past sessions never are). */
export function isActiveSession(s: LayoutSession): boolean {
  const p = sessionPhase({ ...s, state: s.state ?? 'unknown', status: s.status ?? 'unknown' });
  return p === 'working' || p === 'waiting';
}

/**
 * Building order: workspaces with a working/waiting session first, then by last activity (newest
 * session activity, archived included) descending, then name, then id. Independent of input order.
 */
export function orderWorkspaces<W extends LayoutWorkspace>(
  workspaces: readonly W[],
  sessionsById: ReadonlyMap<string, LayoutSession>,
): W[] {
  const keyed = workspaces.map((ws) => {
    let active = false;
    let last = 0;
    for (const id of ws.sessionIds) {
      const s = sessionsById.get(id);
      if (!s) continue;
      if (!active && s.origin !== 'history' && isActiveSession(s)) active = true;
      const t = s.lastActivityAt ?? s.startedAt ?? 0;
      if (t > last) last = t;
    }
    return { ws, active, last, name: ws.name.toLowerCase() };
  });
  keyed.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || b.last - a.last || byString(a.name, b.name) || byString(a.ws.id, b.ws.id),
  );
  return keyed.map((k) => k.ws);
}
