/**
 * Pure search/filter logic for the city (no DOM / React), unit-tested.
 */
import type { Agent } from '../models/Agent';
import type { Session, SessionTier } from '../models/Session';
import { sessionLabel, sessionPhase, sessionTier } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';

export type PhaseFilter = 'working' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped';

export const PHASE_FILTERS: readonly PhaseFilter[] = ['working', 'waiting', 'idle', 'done', 'failed', 'stopped'];

export type TierFilter = SessionTier;
export const TIER_FILTERS: readonly TierFilter[] = ['live', 'recent', 'archived'];

export interface CityFilters {
  /** Free text, matched case-insensitively against company/session/agent names, ids and paths. */
  query: string;
  /** Empty = all phases. Phase chips only match live sessions. */
  phases: PhaseFilter[];
  /** Empty = all tiers (live, recent, archived). */
  tiers: TierFilter[];
  /** Hide companies without a working or waiting session. */
  hideInactive: boolean;
  /** Hide companies without any (visible) session. */
  onlyWithSessions: boolean;
}

export const DEFAULT_FILTERS: CityFilters = {
  query: '',
  phases: [],
  tiers: [],
  hideInactive: false,
  onlyWithSessions: false,
};

export interface FilterInput {
  workspaces: readonly CityWorkspace[];
  sessions: readonly Session[];
  agents: readonly Agent[];
}

export interface FilterResult {
  workspaces: CityWorkspace[];
  sessions: Session[];
  agents: Agent[];
  /** True if any filter deviates from the defaults. */
  active: boolean;
  /** Number of hidden companies / sessions (for "x hidden" hints). */
  hiddenWorkspaces: number;
  hiddenSessions: number;
}

const MAX_QUERY = 200;

/** Maps a session to the filter phase (unknown counts as idle; past sessions have their own tiers). */
export function filterPhase(
  s: Pick<Session, 'state' | 'status' | 'waitingFor'> & Partial<Pick<Session, 'origin' | 'tier'>>,
): PhaseFilter | 'resting' | 'archived' {
  const p = sessionPhase(s);
  return p === 'unknown' ? 'idle' : p;
}

/** True if a tier is shown with these filters (empty tier list = all). */
export function tierVisible(f: Pick<CityFilters, 'tiers'>, t: TierFilter): boolean {
  return f.tiers.length === 0 || f.tiers.includes(t);
}

export function isFilterActive(f: CityFilters): boolean {
  const tiersActive = f.tiers.length > 0 && TIER_FILTERS.some((t) => !f.tiers.includes(t));
  return !!f.query.trim() || f.phases.length > 0 || f.hideInactive || f.onlyWithSessions || tiersActive;
}

function tokens(query: string): string[] {
  return query
    .slice(0, MAX_QUERY)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function haystackMatches(hay: string, toks: readonly string[]): boolean {
  return toks.every((t) => hay.includes(t));
}

export function applyFilters(input: FilterInput, f: CityFilters): FilterResult {
  const toks = tokens(f.query);
  const phaseSet = new Set(f.phases);
  const agentsBySession = new Map<string, Agent[]>();
  for (const a of input.agents) {
    const list = agentsBySession.get(a.parentSessionId) ?? [];
    list.push(a);
    agentsBySession.set(a.parentSessionId, list);
  }
  const sessionsById = new Map(input.sessions.map((s) => [s.id, s]));

  const sessionText = (s: Session): string => {
    const parts = [sessionLabel(s), s.id, s.sessionId ?? '', s.cwd ?? '', s.kind, s.gitBranch ?? ''];
    for (const a of agentsBySession.get(s.id) ?? []) parts.push(a.name, a.agentType, a.task ?? '');
    return parts.join('\n').toLowerCase();
  };

  const keptSessions: Session[] = [];
  const keptWorkspaces: CityWorkspace[] = [];

  for (const ws of input.workspaces) {
    const wsMatches = toks.length === 0 || haystackMatches(`${ws.name}\n${ws.path}`.toLowerCase(), toks);
    const all = ws.sessionIds.map((id) => sessionsById.get(id)).filter((s): s is Session => !!s);
    const visible = all.filter((s) => {
      if (!tierVisible(f, sessionTier(s))) return false;
      const fp = filterPhase(s);
      if (phaseSet.size && (fp === 'archived' || fp === 'resting' || !phaseSet.has(fp))) return false;
      if (toks.length && !wsMatches) return haystackMatches(sessionText(s), toks);
      return true;
    });

    if (toks.length && !wsMatches && visible.length === 0) continue;
    if (phaseSet.size && visible.length === 0) continue;
    if (f.onlyWithSessions && visible.length === 0) continue;
    if (f.hideInactive && !visible.some((s) => ['working', 'waiting'].includes(filterPhase(s)))) continue;

    const kept: CityWorkspace = { ...ws, sessionIds: visible.map((s) => s.id) };
    // The "+N" overflow counters only make sense while that tier is shown unfiltered.
    const narrowed = phaseSet.size > 0 || (toks.length > 0 && !wsMatches);
    if (kept.archivedOverflow && (!tierVisible(f, 'archived') || narrowed)) delete kept.archivedOverflow;
    if (kept.recentOverflow && (!tierVisible(f, 'recent') || narrowed)) delete kept.recentOverflow;
    keptWorkspaces.push(kept);
    keptSessions.push(...visible);
  }

  const keptIds = new Set(keptSessions.map((s) => s.id));
  return {
    workspaces: keptWorkspaces,
    sessions: keptSessions,
    agents: input.agents.filter((a) => keptIds.has(a.parentSessionId)),
    active: isFilterActive(f),
    hiddenWorkspaces: input.workspaces.length - keptWorkspaces.length,
    hiddenSessions: input.sessions.length - keptSessions.length,
  };
}

/**
 * Sanitizes persisted / untrusted filter state. Legacy `showArchived: false` (UI state v2) becomes
 * the tier filter "live + recent".
 */
export function sanitizeFilters(v: unknown): CityFilters {
  if (!v || typeof v !== 'object') return { ...DEFAULT_FILTERS, phases: [], tiers: [] };
  const o = v as Record<string, unknown>;
  const phases = Array.isArray(o.phases)
    ? [...new Set(o.phases.filter((p): p is PhaseFilter => PHASE_FILTERS.includes(p as PhaseFilter)))]
    : [];
  let tiers: TierFilter[] = Array.isArray(o.tiers)
    ? TIER_FILTERS.filter((t) => (o.tiers as unknown[]).includes(t))
    : o.showArchived === false
      ? ['live', 'recent']
      : [];
  if (tiers.length === TIER_FILTERS.length) tiers = []; // all = no filter
  return {
    query: typeof o.query === 'string' ? o.query.slice(0, MAX_QUERY) : '',
    phases,
    tiers,
    hideInactive: o.hideInactive === true,
    onlyWithSessions: o.onlyWithSessions === true,
  };
}

export function togglePhase(f: CityFilters, p: PhaseFilter): CityFilters {
  const has = f.phases.includes(p);
  return { ...f, phases: has ? f.phases.filter((x) => x !== p) : [...f.phases, p] };
}

/** Toggles a tier chip; selecting all three (or none) means "no tier filter". Order is canonical. */
export function toggleTier(f: CityFilters, t: TierFilter): CityFilters {
  const has = f.tiers.includes(t);
  const next = TIER_FILTERS.filter((x) => (x === t ? !has : f.tiers.includes(x)));
  return { ...f, tiers: next.length === TIER_FILTERS.length ? [] : next };
}
