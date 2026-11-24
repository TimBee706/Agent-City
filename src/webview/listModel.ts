/**
 * Pure model of the list view: the city as a tree (company -> sessions -> agents, plus an
 * "Archived" group per company), flattened to the rows that are currently visible. No DOM / React.
 */
import type { Agent } from '../models/Agent';
import type { HistorySummary, WorkspaceHistoryIndex } from '../models/CityState';
import { Session, SessionPhase, isArchived, sessionLabel, sessionPhase } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';
import { FacadeModel, computeFacade, orderRoomSessions, paletteFor } from './facade';
import { orderWorkspaces } from './layout';
import type { Selection } from './selection';

export type ViewMode = 'city' | 'list';
export const VIEW_MODES: readonly ViewMode[] = ['city', 'list'];

export type ListSort = 'attention' | 'name' | 'activity';
export const LIST_SORTS: readonly ListSort[] = ['attention', 'name', 'activity'];

/** Persisted expanded row keys are capped (oldest dropped first). */
export const MAX_EXPANDED = 300;

export const wsKey = (id: string) => `w:${id}`;
export const sessionKey = (id: string) => `s:${id}`;
export const agentKey = (id: string) => `a:${id}`;
export const archiveKey = (wsId: string) => `g:${wsId}`;
export const historyKey = (wsId: string, id: string) => `h:${wsId}:${id}`;

interface RowBase {
  /** Stable key, also the id in the expanded set. */
  key: string;
  /** Tree depth, 1 = company. */
  level: number;
  /** Key of the parent row (undefined for companies). */
  parent?: string;
  /** Has children that can be shown / hidden. */
  expandable: boolean;
  expanded: boolean;
  /** What selecting the row shows in the details panel. */
  selection: Selection;
}

export interface WorkspaceRow extends RowBase {
  kind: 'workspace';
  ws: CityWorkspace;
  counts: Pick<FacadeModel, 'live' | 'working' | 'waiting' | 'failed' | 'recent' | 'archived'>;
  palette: number;
  lastActivityAt?: number;
}
export interface SessionRow extends RowBase {
  kind: 'session';
  session: Session;
  phase: SessionPhase;
  label: string;
  workspaceId: string;
  /** Agents incl. the main agent. */
  agents: number;
}
export interface AgentRow extends RowBase {
  kind: 'agent';
  agent: Agent;
}
export interface GroupRow extends RowBase {
  kind: 'group';
  workspaceId: string;
  count: number;
}
/** A past session known only from the history index (no room in the city). */
export interface HistoryRow extends RowBase {
  kind: 'history';
  item: HistorySummary;
  label: string;
  workspaceId: string;
}
/** "+N older sessions not listed" / "No sessions". */
export interface NoteRow extends RowBase {
  kind: 'note';
  text: string;
}
export type ListRow = WorkspaceRow | SessionRow | AgentRow | GroupRow | HistoryRow | NoteRow;

export interface ListInput {
  workspaces: readonly CityWorkspace[];
  sessions: readonly Session[];
  agents: readonly Agent[];
  historyIndex?: readonly WorkspaceHistoryIndex[];
  expanded: ReadonlySet<string>;
  sort: ListSort;
}

function historyLabel(h: HistorySummary): string {
  return h.title ?? `session ${h.id.slice(0, 8)}`;
}

function lastActivity(ws: CityWorkspace, sessions: readonly Session[]): number | undefined {
  let last = 0;
  for (const s of sessions) last = Math.max(last, s.lastActivityAt ?? s.startedAt ?? 0);
  return last || ws.lastSeen || undefined;
}

export function sortWorkspaces(workspaces: readonly CityWorkspace[], sessionsById: ReadonlyMap<string, Session>, sort: ListSort): CityWorkspace[] {
  if (sort === 'attention') return orderWorkspaces(workspaces, sessionsById);
  const name = (w: CityWorkspace) => w.name.toLowerCase();
  const byName = (a: CityWorkspace, b: CityWorkspace) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sort === 'name') return [...workspaces].sort(byName);
  const last = new Map(
    workspaces.map((w) => [w.id, lastActivity(w, w.sessionIds.map((id) => sessionsById.get(id)).filter((s): s is Session => !!s)) ?? 0]),
  );
  return [...workspaces].sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || byName(a, b));
}

/**
 * The visible rows, top to bottom. Children are only produced for expanded parents, so the cost
 * follows what is on screen - not the size of the history.
 */
export function buildListRows(input: ListInput): ListRow[] {
  const { expanded } = input;
  const sessionsById = new Map(input.sessions.map((s) => [s.id, s]));
  const agentsBySession = new Map<string, Agent[]>();
  for (const a of input.agents) {
    const list = agentsBySession.get(a.parentSessionId) ?? [];
    list.push(a);
    agentsBySession.set(a.parentSessionId, list);
  }
  const indexByWs = new Map((input.historyIndex ?? []).map((x) => [x.workspaceId, x]));
  const rows: ListRow[] = [];

  for (const ws of sortWorkspaces(input.workspaces, sessionsById, input.sort)) {
    const own = ws.sessionIds.map((id) => sessionsById.get(id)).filter((s): s is Session => !!s);
    const f = computeFacade(own, ws);
    const key = wsKey(ws.id);
    const open = expanded.has(key);
    rows.push({
      kind: 'workspace',
      key,
      level: 1,
      expandable: true,
      expanded: open,
      selection: { kind: 'workspace', id: ws.id },
      ws,
      counts: { live: f.live, working: f.working, waiting: f.waiting, failed: f.failed, recent: f.recent, archived: f.archived },
      palette: paletteFor(ws.id),
      lastActivityAt: lastActivity(ws, own),
    });
    if (!open) continue;

    // rooms: live sessions by urgency, then recent ones
    const rooms = orderRoomSessions(own);
    for (const s of rooms) {
      const agents = agentsBySession.get(s.id) ?? [];
      const subs = agents.filter((a) => a.role === 'subagent');
      const sKey = sessionKey(s.id);
      const sOpen = subs.length > 0 && expanded.has(sKey);
      rows.push({
        kind: 'session',
        key: sKey,
        level: 2,
        parent: key,
        expandable: subs.length > 0,
        expanded: sOpen,
        selection: { kind: 'session', id: s.id },
        session: s,
        phase: sessionPhase(s),
        label: sessionLabel(s),
        workspaceId: ws.id,
        agents: agents.length,
      });
      if (!sOpen) continue;
      for (const a of subs) {
        rows.push({ kind: 'agent', key: agentKey(a.agentId), level: 3, parent: sKey, expandable: false, expanded: false, selection: { kind: 'agent', id: a.agentId }, agent: a });
      }
    }

    // past sessions without a room: recent ones over the room limit, then the archive group
    const index = indexByWs.get(ws.id);
    const roomIds = new Set<string>();
    for (const s of own) {
      roomIds.add(s.id);
      if (s.sessionId) roomIds.add(s.sessionId);
    }
    const extraRecent = (index?.items ?? []).filter((h) => h.tier === 'recent' && !roomIds.has(h.id));
    for (const h of extraRecent) {
      rows.push({
        kind: 'history',
        key: historyKey(ws.id, h.id),
        level: 2,
        parent: key,
        expandable: false,
        expanded: false,
        selection: { kind: 'history', id: h.id, workspaceId: ws.id },
        item: h,
        label: historyLabel(h),
        workspaceId: ws.id,
      });
    }

    if (f.archived > 0) {
      const gKey = archiveKey(ws.id);
      const gOpen = expanded.has(gKey);
      rows.push({ kind: 'group', key: gKey, level: 2, parent: key, expandable: true, expanded: gOpen, selection: { kind: 'workspace', id: ws.id }, workspaceId: ws.id, count: f.archived });
      if (gOpen) {
        const archivedRooms = own.filter(isArchived).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || (a.id < b.id ? -1 : 1));
        for (const s of archivedRooms) {
          rows.push({
            kind: 'session',
            key: sessionKey(s.id),
            level: 3,
            parent: gKey,
            expandable: false,
            expanded: false,
            selection: { kind: 'session', id: s.id },
            session: s,
            phase: 'archived',
            label: sessionLabel(s),
            workspaceId: ws.id,
            agents: 0,
          });
        }
        const indexOnly = (index?.items ?? []).filter((h) => h.tier === 'archived' && !roomIds.has(h.id));
        for (const h of indexOnly) {
          rows.push({
            kind: 'history',
            key: historyKey(ws.id, h.id),
            level: 3,
            parent: gKey,
            expandable: false,
            expanded: false,
            selection: { kind: 'history', id: h.id, workspaceId: ws.id },
            item: h,
            label: historyLabel(h),
            workspaceId: ws.id,
          });
        }
        const rest = f.archived - archivedRooms.length - indexOnly.length;
        if (rest > 0) {
          rows.push({ kind: 'note', key: `n:${ws.id}:more`, level: 3, parent: gKey, expandable: false, expanded: false, selection: undefined, text: `+${rest} older archived session${rest === 1 ? '' : 's'} not listed` });
        }
      }
    }

    if (rooms.length === 0 && extraRecent.length === 0 && f.archived === 0) {
      rows.push({ kind: 'note', key: `n:${ws.id}:empty`, level: 2, parent: key, expandable: false, expanded: false, selection: undefined, text: ws.missing ? 'Folder not found - no sessions.' : 'No sessions yet.' });
    }
  }
  return rows;
}

/** True if the row shows what is selected. */
export function isRowSelected(row: ListRow, sel: Selection): boolean {
  const r = row.selection;
  if (!sel || !r || row.kind === 'group' || row.kind === 'note') return false;
  if (r.kind !== sel.kind || r.id !== sel.id) return false;
  return r.kind !== 'history' || (sel.kind === 'history' && r.workspaceId === sel.workspaceId);
}

export function toggleExpanded(expanded: ReadonlySet<string>, key: string, open?: boolean): Set<string> {
  const next = new Set(expanded);
  const want = open ?? !next.has(key);
  if (want) {
    next.delete(key); // re-insert: most recently opened last
    next.add(key);
    while (next.size > MAX_EXPANDED) next.delete(next.values().next().value as string);
  } else next.delete(key);
  return next;
}

/** "Expand all": every company (archive groups and subagents stay as they are - they can be long). */
export function expandAll(expanded: ReadonlySet<string>, workspaces: readonly Pick<CityWorkspace, 'id'>[]): Set<string> {
  const next = new Set(expanded);
  for (const w of workspaces.slice(0, MAX_EXPANDED)) next.add(wsKey(w.id));
  return next;
}

/** Keys that must be open so that the row for a selection is visible. */
export function keysToReveal(sel: Selection, input: Pick<ListInput, 'workspaces' | 'sessions' | 'agents'>): string[] {
  if (!sel) return [];
  if (sel.kind === 'workspace') return [];
  if (sel.kind === 'history') return [wsKey(sel.workspaceId), archiveKey(sel.workspaceId)];
  const sessionId = sel.kind === 'agent' ? input.agents.find((a) => a.agentId === sel.id)?.parentSessionId : sel.id;
  if (!sessionId) return [];
  const ws = input.workspaces.find((w) => w.sessionIds.includes(sessionId));
  if (!ws) return [];
  const keys = [wsKey(ws.id)];
  const s = input.sessions.find((x) => x.id === sessionId);
  if (s && isArchived(s)) keys.push(archiveKey(ws.id));
  if (sel.kind === 'agent' && input.agents.find((a) => a.agentId === sel.id)?.role === 'subagent') keys.push(sessionKey(sessionId));
  return keys;
}

/** Row key of a selection (to focus / scroll to it). A main agent is shown as its session row. */
export function keyOfSelection(sel: Selection, agents: readonly Pick<Agent, 'agentId' | 'role' | 'parentSessionId'>[] = []): string | undefined {
  if (!sel) return undefined;
  switch (sel.kind) {
    case 'workspace':
      return wsKey(sel.id);
    case 'session':
      return sessionKey(sel.id);
    case 'agent': {
      const a = agents.find((x) => x.agentId === sel.id);
      return a && a.role === 'main' ? sessionKey(a.parentSessionId) : agentKey(sel.id);
    }
    case 'history':
      return historyKey(sel.workspaceId, sel.id);
  }
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/**
 * Tree keyboard navigation (WAI-ARIA tree pattern): what to focus and / or toggle for a key on the
 * row at `index`. Right opens a closed row or moves to its first child; Left closes an open row or
 * moves to its parent.
 */
export function treeNav(rows: readonly ListRow[], index: number, key: TreeKey): { focus?: string; toggle?: { key: string; open: boolean } } {
  const row = rows[index];
  if (!row) return rows.length ? { focus: rows[0].key } : {};
  const at = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))].key;
  switch (key) {
    case 'ArrowDown':
      return { focus: at(index + 1) };
    case 'ArrowUp':
      return { focus: at(index - 1) };
    case 'Home':
      return { focus: at(0) };
    case 'End':
      return { focus: at(rows.length - 1) };
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { toggle: { key: row.key, open: true } };
      if (row.expanded && rows[index + 1]?.parent === row.key) return { focus: rows[index + 1].key };
      return {};
    case 'ArrowLeft':
      if (row.expandable && row.expanded) return { toggle: { key: row.key, open: false } };
      return row.parent ? { focus: row.parent } : {};
  }
}

export function sanitizeViewMode(v: unknown): ViewMode {
  return v === 'list' ? 'list' : 'city';
}

export function sanitizeListSort(v: unknown): ListSort {
  return v === 'name' || v === 'activity' ? v : 'attention';
}

export function sanitizeExpanded(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((k): k is string => typeof k === 'string' && k.length > 2 && k.length <= 400).slice(-MAX_EXPANDED);
}
