import type { ArchiveReason, HistoryTier, Session } from '../models/Session';
import type { HistoricalSessionInfo } from './HistoricalSessions';

/**
 * Pure tier classification of past (non-running) sessions.
 *
 * Marker AVAILABLE (Claude Code's `hiddenSessionIds` could be read):
 *    archived <=> id is in the marker ('claude'); everything else is recent. No age rule:
 *    Claude Code already auto-archives after its own `claudeCode.archiveInactiveSessions` days.
 * Marker UNAVAILABLE / disabled (fallback):
 *    last activity within `recentDays` (inclusive boundary) -> recent, otherwise archived ('age').
 *    `recentDays = 0` archives everything that is not running.
 */

export const DAY_MS = 86_400_000;
export const DEFAULT_RECENT_DAYS = 14;

export interface TierOptions {
  now: number;
  recentDays: number;
  /** Archived session ids from Claude Code (lower case); undefined = marker unavailable. */
  archivedIds?: ReadonlySet<string>;
}

export interface TierResult {
  tier: HistoryTier;
  archivedBy?: ArchiveReason;
}

export function normalizeRecentDays(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : DEFAULT_RECENT_DAYS;
}

export function classifyHistoryTier(info: Pick<HistoricalSessionInfo, 'sessionId' | 'lastActivityAt'>, o: TierOptions): TierResult {
  if (o.archivedIds) {
    return o.archivedIds.has(info.sessionId.toLowerCase()) ? { tier: 'archived', archivedBy: 'claude' } : { tier: 'recent' };
  }
  const days = normalizeRecentDays(o.recentDays);
  if (days > 0 && o.now - info.lastActivityAt <= days * DAY_MS) return { tier: 'recent' };
  return { tier: 'archived', archivedBy: 'age' };
}

/** Converts extracted metadata to a (not yet grouped) history session of the given tier. */
export function toHistorySession(info: HistoricalSessionInfo, t: TierResult): Session {
  const s: Session = {
    id: info.sessionId,
    sessionId: info.sessionId,
    cwd: info.cwd,
    kind: 'history',
    state: 'unknown',
    status: 'unknown',
    origin: 'history',
    tier: t.tier,
    lastActivityAt: info.lastActivityAt,
  };
  if (t.tier === 'archived' && t.archivedBy) s.archivedBy = t.archivedBy;
  if (info.title) s.name = info.title;
  if (info.startedAt !== undefined) s.startedAt = info.startedAt;
  if (info.gitBranch) s.gitBranch = info.gitBranch;
  if (info.subagentCount !== undefined) s.subagentCount = info.subagentCount;
  return s;
}
