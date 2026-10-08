import { ReactNode, useEffect, useRef } from 'react';
import { CHARACTER_STATE_LABEL } from '../models/Agent';
import type { AgentEvent } from '../models/AgentEvent';
import type { CityState, HistorySummary } from '../models/CityState';
import type { ArchiveReason, Session } from '../models/Session';
import { isArchived, isHistory, isRecent, sessionLabel, sessionPhase } from '../models/Session';
import { isValidSessionId } from '../shared/sessionLinks';
import { CHARACTER_GLYPH, PHASE_GLYPH, PHASE_LABEL, relativeTime } from './format';
import { Select, Selection } from './selection';
import { postToExtension } from './vscodeApi';

interface Props {
  state: CityState;
  events: readonly AgentEvent[];
  selection: Selection;
  onSelect: Select;
  now: number;
  /** Move focus into the panel when it opens (false for arrow-key navigation on the map). */
  autoFocus?: boolean;
  /** Workspace whose building view is open (level 2), if any. */
  currentBuilding?: string;
  onOpenBuilding?: (workspaceId: string) => void;
  onBackToCity?: () => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children === undefined || children === null || children === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  open: 'opened in VS Code',
  session: 'Claude session',
  history: 'past session / discovery',
  imported: 'folder import',
  manual: 'manually',
};

function when(ts: number | undefined, now: number): string | undefined {
  return ts ? `${relativeTime(ts, now)} (${new Date(ts).toLocaleString()})` : undefined;
}

/** Copy button for a validated Claude session id. */
function CopyId({ id }: { id: string }) {
  if (!isValidSessionId(id)) return null;
  return (
    <button
      className="icon-button"
      aria-label="Copy session id"
      title="Copy session id"
      onClick={() => postToExtension({ type: 'copySessionId', sessionId: id })}
    >
      ⧉
    </button>
  );
}

/** One past session in a building list (a room in the city, or only a summary from the history index). */
interface HistoryItem {
  sessionId: string;
  /** City session id if it is shown as a room (selectable). */
  roomId?: string;
  title: string;
  lastActivityAt?: number;
  gitBranch?: string;
  archivedBy?: ArchiveReason;
}

function itemFromSession(s: Session): HistoryItem {
  return {
    sessionId: s.sessionId ?? s.id,
    roomId: s.id,
    title: sessionLabel(s),
    lastActivityAt: s.lastActivityAt,
    gitBranch: s.gitBranch,
    archivedBy: s.archivedBy,
  };
}

function itemFromSummary(h: HistorySummary, rooms: ReadonlyMap<string, Session>): HistoryItem {
  const room = rooms.get(h.id);
  return {
    sessionId: h.id,
    roomId: room?.id,
    title: h.title ?? `session ${h.id.slice(0, 8)}`,
    lastActivityAt: h.lastActivityAt,
    gitBranch: h.gitBranch,
    archivedBy: h.archivedBy,
  };
}

/** Building panel: recent or archived (past) sessions with title, last activity, branch and actions. */
function HistoryList({
  kind,
  items,
  total,
  live,
  onSelect,
  now,
}: {
  kind: 'recent' | 'archived';
  items: HistoryItem[];
  total: number;
  live: boolean;
  onSelect: Select;
  now: number;
}) {
  if (!items.length && !total) return null;
  const glyph = kind === 'recent' ? PHASE_GLYPH.resting : PHASE_GLYPH.archived;
  const heading = kind === 'recent' ? 'Recent sessions' : 'Archived sessions';
  const rest = Math.max(0, total - items.length);
  return (
    <section className={`detail-archive detail-history--${kind}`} aria-label={heading}>
      <h3 className="detail-subtitle">
        {heading} ({total})
      </h3>
      <ul className="detail-links">
        {items.map((s) => (
          <li key={s.sessionId} className="archived-item">
            {s.roomId ? (
              <button className="link-button" onClick={() => onSelect({ kind: 'session', id: s.roomId! })}>
                <span aria-hidden="true">{glyph}</span> {s.title}
              </button>
            ) : (
              <span>
                <span aria-hidden="true">{glyph}</span> {s.title}
              </span>
            )}
            <span className="muted small">
              {relativeTime(s.lastActivityAt, now)}
              {s.gitBranch ? ` · ${s.gitBranch}` : ''}
              {s.archivedBy === 'claude' ? ' · archived in Claude Code' : ''}
            </span>
            <span className="archived-actions">
              {live && isValidSessionId(s.sessionId) && (
                <button
                  className="secondary-button small-button"
                  aria-label={`Open ${kind} session ${s.title}`}
                  onClick={() => postToExtension({ type: 'openSession', sessionId: s.sessionId })}
                >
                  Open Session
                </button>
              )}
              <CopyId id={s.sessionId} />
            </span>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="muted small">
          +{rest} older {kind} session{rest === 1 ? '' : 's'} not listed
        </p>
      )}
    </section>
  );
}

/** Detail panel for the selected building / room / agent, with actions. Escape closes (see App). */
export function DetailPanel({ state, events, selection, onSelect, now, autoFocus = true, currentBuilding, onOpenBuilding, onBackToCity }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);
  const isOpen = !!selection;

  // Move focus into the panel when it opens (not when switching between items).
  useEffect(() => {
    if (isOpen && !wasOpen.current && autoFocus) headingRef.current?.focus({ preventScroll: true });
    wasOpen.current = isOpen;
  }, [isOpen]);

  if (!selection) {
    return (
      <aside className="detail-panel glass" aria-label="Details">
        <h2 className="panel-title">Details</h2>
        <p className="muted">
          Select a building, room, agent or archive box. Double-click a building (or press Enter on it) to go inside; Escape
          returns to the city.
        </p>
      </aside>
    );
  }

  const live = state.source === 'live' || state.source === 'error';
  let body: ReactNode = <p className="muted">This item is no longer present (it may be hidden by a filter or gone).</p>;
  let title = 'Details';

  if (selection.kind === 'workspace') {
    const ws = state.workspaces.find((w) => w.id === selection.id);
    if (ws) {
      title = ws.name;
      const all = state.sessions.filter((s) => s.workspaceId === ws.id);
      const sessions = all.filter((s) => !isHistory(s));
      const newest = (a: Session, b: Session) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.id.localeCompare(b.id);
      const recentRooms = all.filter(isRecent).sort(newest);
      const archivedRooms = all.filter(isArchived).sort(newest);
      const rooms = new Map(all.filter(isHistory).map((s) => [s.sessionId ?? s.id, s]));
      const index = state.historyIndex?.find((x) => x.workspaceId === ws.id);
      const recentItems = [
        ...recentRooms.map(itemFromSession),
        ...(index?.items.filter((h) => h.tier === 'recent').map((h) => itemFromSummary(h, rooms)) ?? []),
      ];
      const recentTotal = recentRooms.length + (ws.recentOverflow ?? 0);
      // The index lists every archived session (rooms included); fall back to the rooms without it.
      const indexArchived = index?.items.filter((h) => h.tier === 'archived') ?? [];
      const archivedItems = indexArchived.length ? indexArchived.map((h) => itemFromSummary(h, rooms)) : archivedRooms.map(itemFromSession);
      const archivedTotal = archivedRooms.length + (ws.archivedOverflow ?? 0);
      const archived = archivedRooms;
      const ids = new Set(sessions.map((s) => s.id));
      const activeAgents = state.agents.filter(
        (a) => ids.has(a.parentSessionId) && a.characterState !== 'idle' && a.characterState !== 'stopped' && a.characterState !== 'done',
      ).length;
      const lastEvent = events.find((e) => e.workspaceId === ws.id || ids.has(e.sessionId));
      const canOpen = live && !!ws.path && ws.id !== 'unassigned' && !ws.missing;
      const manageable = state.source !== 'demo' && ws.id !== 'unassigned' && !!ws.path;
      body = (
        <>
          <dl className="detail-list">
            <Row label="Type">Company (workspace)</Row>
            <Row label="Path">{ws.path || '—'}</Row>
            <Row label="Open here">{ws.open ? 'yes' : 'no'}</Row>
            <Row label="Added by">{ws.id === 'unassigned' ? undefined : SOURCE_TEXT[ws.source] ?? ws.source}</Row>
            <Row label="Import root">{ws.root}</Row>
            <Row label="Pinned">{ws.id === 'unassigned' ? undefined : ws.pinned ? 'yes' : 'no'}</Row>
            <Row label="Folder">{ws.missing ? 'not found (last scan)' : undefined}</Row>
            <Row label="Sessions">{String(sessions.length)}</Row>
            <Row label="Active agents">{String(activeAgents)}</Row>
            <Row label="Recent">{recentTotal ? String(recentTotal) : undefined}</Row>
            <Row label="Archived">{archived.length || ws.archivedOverflow ? String(archivedTotal) : undefined}</Row>
            <Row label="Last activity">{when(lastEvent?.timestamp ?? ws.lastSeen, now)}</Row>
          </dl>
          {(onOpenBuilding || onBackToCity) && (
            <div className="detail-actions">
              {currentBuilding === ws.id ? (
                <button className="secondary-button" onClick={() => onBackToCity?.()}>
                  ← Back to city
                </button>
              ) : (
                <button className="primary-button" onClick={() => onOpenBuilding?.(ws.id)}>
                  Enter building
                </button>
              )}
            </div>
          )}
          {sessions.length > 0 && (
            <ul className="detail-links" aria-label="Sessions">
              {sessions.map((s) => {
                const p = sessionPhase(s);
                return (
                  <li key={s.id}>
                    <button className="link-button" onClick={() => onSelect({ kind: 'session', id: s.id })}>
                      <span aria-hidden="true">{PHASE_GLYPH[p]}</span> {sessionLabel(s)} — {PHASE_LABEL[p]}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <HistoryList kind="recent" items={recentItems} total={recentTotal} live={state.source !== 'demo'} onSelect={onSelect} now={now} />
          <HistoryList kind="archived" items={archivedItems} total={archivedTotal} live={state.source !== 'demo'} onSelect={onSelect} now={now} />
          {ws.missing && (
            <p className="muted small" role="note">
              This folder was not found during the last scan of its root. The building is kept until you remove it.
            </p>
          )}
          {canOpen && (
            <div className="detail-actions">
              <button
                className="primary-button"
                onClick={() => postToExtension({ type: 'openWorkspace', workspaceId: ws.id, newWindow: false })}
              >
                Open Workspace
              </button>
              <button
                className="secondary-button"
                onClick={() => postToExtension({ type: 'openWorkspace', workspaceId: ws.id, newWindow: true })}
              >
                Open in New Window
              </button>
            </div>
          )}
          {manageable && (
            <div className="detail-actions">
              {ws.source !== 'imported' && ws.source !== 'manual' && (
                <button
                  className="secondary-button"
                  aria-pressed={ws.pinned}
                  title={ws.pinned ? 'Allow automatic cleanup of this workspace' : 'Keep this workspace (never cleaned up automatically)'}
                  onClick={() => postToExtension({ type: 'setWorkspacePinned', workspaceId: ws.id, pinned: !ws.pinned })}
                >
                  {ws.pinned ? 'Unpin' : 'Pin'}
                </button>
              )}
              <button
                className="secondary-button"
                title="Removes the building (asks for confirmation). The folder is not touched."
                onClick={() => postToExtension({ type: 'removeWorkspace', workspaceId: ws.id })}
              >
                Remove from City
              </button>
            </div>
          )}
        </>
      );
    }
  } else if (selection.kind === 'history') {
    const ws = state.workspaces.find((w) => w.id === selection.workspaceId);
    const h = state.historyIndex?.find((x) => x.workspaceId === selection.workspaceId)?.items.find((x) => x.id === selection.id);
    if (h) {
      title = h.title ?? `session ${h.id.slice(0, 8)}`;
      const p = h.tier === 'recent' ? 'resting' : 'archived';
      body = (
        <>
          <p className={`phase-pill phase--${p}`}>
            <span aria-hidden="true">{PHASE_GLYPH[p]}</span> {PHASE_LABEL[p]}
          </p>
          <p className="muted small">
            {h.tier === 'recent'
              ? 'Recent session (not running) from the building list. Open Session resumes it.'
              : h.archivedBy === 'claude'
                ? 'Archived in the Claude Code session list - stored in the basement. Open Session resumes it.'
                : 'Archived (no activity within claudeCity.history.recentDays) - stored in the basement. Open Session resumes it.'}
          </p>
          <dl className="detail-list">
            <Row label="Title">{h.title}</Row>
            <Row label="Session ID">
              <span className="copy-row">
                <code>{h.id}</code>
                <CopyId id={h.id} />
              </span>
            </Row>
            <Row label="Company">
              {ws ? (
                <button className="link-button" onClick={() => onSelect({ kind: 'workspace', id: ws.id })}>
                  {ws.name}
                </button>
              ) : undefined}
            </Row>
            <Row label="Branch">{h.gitBranch}</Row>
            <Row label="Last activity">{when(h.lastActivityAt, now)}</Row>
          </dl>
          {state.source !== 'demo' && (
            <div className="detail-actions">
              {isValidSessionId(h.id) && (
                <button className="primary-button" onClick={() => postToExtension({ type: 'openSession', sessionId: h.id })}>
                  Open Session
                </button>
              )}
              {ws?.path && (
                <button
                  className="secondary-button"
                  onClick={() => postToExtension({ type: 'openWorkspace', workspaceId: ws.id, newWindow: false })}
                >
                  Open Workspace
                </button>
              )}
            </div>
          )}
        </>
      );
    }
  } else if (selection.kind === 'session') {
    const s = state.sessions.find((x) => x.id === selection.id);
    if (s && isHistory(s)) {
      const ws = state.workspaces.find((w) => w.id === s.workspaceId);
      const sid = s.sessionId ?? s.id;
      const p = sessionPhase(s);
      title = sessionLabel(s);
      const note = isRecent(s)
        ? 'Recent session from a local transcript: not running, still listed in Claude Code. Open Session resumes it.'
        : s.archivedBy === 'claude'
          ? 'Archived in the Claude Code session list. Not running - Open Session resumes it in Claude Code.'
          : 'Archived: no activity within claudeCity.history.recentDays. Not running - Open Session resumes it in Claude Code.';
      body = (
        <>
          <p className={`phase-pill phase--${p}`}>
            <span aria-hidden="true">{PHASE_GLYPH[p]}</span> {PHASE_LABEL[p]}
          </p>
          <p className="muted small">{note}</p>
          <dl className="detail-list">
            <Row label="Title">{s.name}</Row>
            <Row label="Session ID">
              <span className="copy-row">
                <code>{sid}</code>
                <CopyId id={sid} />
              </span>
            </Row>
            <Row label="Company">
              {ws ? (
                <button className="link-button" onClick={() => onSelect({ kind: 'workspace', id: ws.id })}>
                  {ws.name}
                </button>
              ) : undefined}
            </Row>
            <Row label="Branch">{s.gitBranch}</Row>
            <Row label="Started">{when(s.startedAt, now)}</Row>
            <Row label="Last activity">{when(s.lastActivityAt, now)}</Row>
            <Row label="Subagents">{s.subagentCount !== undefined ? String(s.subagentCount) : undefined}</Row>
            <Row label="Directory">{s.cwd}</Row>
          </dl>
          {state.source !== 'demo' && (
            <div className="detail-actions">
              {isValidSessionId(sid) && (
                <button className="primary-button" onClick={() => postToExtension({ type: 'openSession', sessionId: sid })}>
                  Open Session
                </button>
              )}
              {ws?.path && (
                <button
                  className="secondary-button"
                  onClick={() => postToExtension({ type: 'openWorkspace', workspaceId: ws.id, newWindow: false })}
                >
                  Open Workspace
                </button>
              )}
            </div>
          )}
        </>
      );
    } else if (s) {
      const p = sessionPhase(s);
      const ws = state.workspaces.find((w) => w.id === s.workspaceId);
      const agents = state.agents.filter((a) => a.parentSessionId === s.id);
      const sid = s.sessionId ?? s.id;
      title = sessionLabel(s);
      body = (
        <>
          <p className={`phase-pill phase--${p}`}>
            <span aria-hidden="true">{PHASE_GLYPH[p]}</span> {PHASE_LABEL[p]}
          </p>
          {s.attention && (
            <p className="attention-note" role="note">
              <span aria-hidden="true">❗</span> {s.attention}
            </p>
          )}
          {s.transient && <p className="muted small">Known from live events only - not (yet) reported by `claude agents`.</p>}
          <dl className="detail-list">
            <Row label="Session ID">
              <span className="copy-row">
                <code>{sid}</code>
                {isValidSessionId(sid) && (
                  <button
                    className="icon-button"
                    aria-label="Copy session id"
                    title="Copy session id"
                    onClick={() => postToExtension({ type: 'copySessionId', sessionId: sid })}
                  >
                    ⧉
                  </button>
                )}
              </span>
            </Row>
            <Row label="Company">
              {ws ? (
                <button className="link-button" onClick={() => onSelect({ kind: 'workspace', id: ws.id })}>
                  {ws.name}
                </button>
              ) : undefined}
            </Row>
            <Row label="State">{s.rawState ?? s.state}</Row>
            <Row label="Status">{s.rawStatus ?? s.status}</Row>
            <Row label="Waiting for">{s.waitingFor}</Row>
            <Row label="Started">{when(s.startedAt, now)}</Row>
            <Row label="Agents">{String(agents.length)}</Row>
            <Row label="Kind">{s.kind}</Row>
            <Row label="Directory">{s.cwd}</Row>
            <Row label="PID">{s.pid !== undefined ? String(s.pid) : undefined}</Row>
          </dl>
          {agents.length > 0 && (
            <ul className="detail-links" aria-label="Agents">
              {agents.map((a) => (
                <li key={a.agentId}>
                  <button className="link-button" onClick={() => onSelect({ kind: 'agent', id: a.agentId })}>
                    <span aria-hidden="true">{CHARACTER_GLYPH[a.characterState]}</span> {a.role === 'main' ? 'Main agent' : a.agentType} —{' '}
                    {CHARACTER_STATE_LABEL[a.characterState]}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {live && (
            <div className="detail-actions">
              {s.sessionId && (
                <button className="primary-button" onClick={() => postToExtension({ type: 'openSession', sessionId: s.sessionId! })}>
                  Open Session
                </button>
              )}
              {ws?.path && (
                <button
                  className="secondary-button"
                  onClick={() => postToExtension({ type: 'openWorkspace', workspaceId: ws.id, newWindow: false })}
                >
                  Open Workspace
                </button>
              )}
            </div>
          )}
        </>
      );
    }
  } else {
    const a = state.agents.find((x) => x.agentId === selection.id);
    if (a) {
      const s = state.sessions.find((x) => x.id === a.parentSessionId);
      title = a.role === 'main' ? `Main agent · ${a.name}` : `${a.agentType} · subagent`;
      body = (
        <>
          <p className={`phase-pill char-pill--${a.characterState}`}>
            <span aria-hidden="true">{CHARACTER_GLYPH[a.characterState]}</span> {CHARACTER_STATE_LABEL[a.characterState]}
            {a.leaving ? ' · leaving' : ''}
          </p>
          {a.attention && (
            <p className="attention-note" role="note">
              <span aria-hidden="true">❗</span> {a.attention}
            </p>
          )}
          <dl className="detail-list">
            <Row label="Agent type">{a.agentType}</Row>
            <Row label="Role">{a.role === 'main' ? 'main agent' : 'subagent'}</Row>
            <Row label="Session">
              {s ? (
                <button className="link-button" onClick={() => onSelect({ kind: 'session', id: s.id })}>
                  {sessionLabel(s)}
                </button>
              ) : undefined}
            </Row>
            <Row label="State">{CHARACTER_STATE_LABEL[a.characterState]}</Row>
            <Row label="Task">{a.task}</Row>
            <Row label="Latest event">{a.lastEvent ? `${a.lastEvent} (${relativeTime(a.lastEventAt, now)})` : undefined}</Row>
            <Row label="Joined">{a.spawnedAt ? when(a.spawnedAt, now) : undefined}</Row>
          </dl>
          {live && s?.sessionId && (
            <div className="detail-actions">
              <button className="primary-button" onClick={() => postToExtension({ type: 'openSession', sessionId: s.sessionId! })}>
                Open Session
              </button>
            </div>
          )}
        </>
      );
    }
  }

  return (
    <aside className="detail-panel glass" aria-label={`Details: ${title}`}>
      <div className="panel-head">
        <h2 className="panel-title" ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        <button className="icon-button" aria-label="Close details (Escape)" title="Close (Escape)" onClick={() => onSelect(undefined)}>
          ✕
        </button>
      </div>
      {body}
    </aside>
  );
}
