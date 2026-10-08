import { AgentEvent } from '../models/AgentEvent';
import { Session, sessionLabel, sessionPhase } from '../models/Session';
import { stableStringify } from '../util/hash';

/** Deterministic fingerprint of a session list (order-independent). */
export function sessionsFingerprint(sessions: readonly Session[]): string {
  return stableStringify([...sessions].sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * Synthesizes events from two consecutive session snapshots (phase 2 has no hooks yet):
 * appeared, phase changed, disappeared.
 */
export function diffSessions(
  prev: readonly Session[] | undefined,
  next: readonly Session[],
  now: number,
  source: AgentEvent['source'] = 'diff',
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const prevById = new Map((prev ?? []).map((s) => [s.id, s]));
  const nextIds = new Set<string>();
  const sorted = [...next].sort((a, b) => a.id.localeCompare(b.id));

  for (const s of sorted) {
    nextIds.add(s.id);
    const before = prevById.get(s.id);
    const phase = sessionPhase(s);
    const agentId = `${s.id}:main`;
    if (!before) {
      // On the first snapshot every session "appears"; the bounded EventStore keeps the feed small.
      events.push({
        id: `appeared:${s.id}:${now}`,
        type: 'session.appeared',
        timestamp: now,
        sessionId: s.id,
        agentId,
        workspaceId: s.workspaceId,
        source,
        message: `${sessionLabel(s)} joined (${phase})`,
        to: phase,
      });
      continue;
    }
    const beforePhase = sessionPhase(before);
    if (beforePhase !== phase) {
      events.push({
        id: `phase:${s.id}:${now}`,
        type: 'session.phaseChanged',
        timestamp: now,
        sessionId: s.id,
        agentId,
        workspaceId: s.workspaceId,
        source,
        message: `${sessionLabel(s)}: ${beforePhase} → ${phase}`,
        from: beforePhase,
        to: phase,
      });
    }
  }

  for (const [id, s] of prevById) {
    if (nextIds.has(id)) continue;
    events.push({
      id: `gone:${id}:${now}`,
      type: 'session.disappeared',
      timestamp: now,
      sessionId: id,
      agentId: `${id}:main`,
      workspaceId: s.workspaceId,
      source,
      message: `${sessionLabel(s)} left`,
      from: sessionPhase(s),
    });
  }
  return events;
}
