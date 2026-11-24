import { KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../models/Agent';
import type { WorkspaceHistoryIndex } from '../models/CityState';
import type { Session } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';
import type { FocusRequest } from './CityMap';
import { CHARACTER_GLYPH, PHASE_GLYPH, PHASE_LABEL, relativeTime } from './format';
import {
  LIST_SORTS,
  ListRow,
  ListSort,
  TreeKey,
  buildListRows,
  expandAll,
  isRowSelected,
  keyOfSelection,
  keysToReveal,
  toggleExpanded,
  treeNav,
  wsKey,
} from './listModel';
import type { Select, Selection } from './selection';

interface Props {
  workspaces: readonly CityWorkspace[];
  sessions: readonly Session[];
  agents: readonly Agent[];
  historyIndex?: readonly WorkspaceHistoryIndex[];
  selection: Selection;
  onSelect: Select;
  /** Show a building in the city (switches back to the map and goes inside). */
  onOpenBuilding: (workspaceId: string) => void;
  expanded: readonly string[];
  onExpandedChange: (keys: string[]) => void;
  sort: ListSort;
  onSortChange: (sort: ListSort) => void;
  /** HUD / feed asked to show a session or company: open its parents and scroll to it. */
  focusRequest: FocusRequest | undefined;
  now: number;
  empty: React.ReactNode;
}

const SORT_LABEL: Record<ListSort, string> = { attention: 'Needs attention first', name: 'Name', activity: 'Last activity' };
const TREE_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Accessible name of a row (state is never conveyed by colour or glyph alone). */
export function rowLabel(row: ListRow, now: number): string {
  switch (row.kind) {
    case 'workspace': {
      const c = row.counts;
      const parts = [plural(c.live, 'live session')];
      if (c.waiting) parts.push(`${c.waiting} waiting for input`);
      if (c.working) parts.push(`${c.working} working`);
      if (c.failed) parts.push(`${c.failed} failed`);
      parts.push(`${c.recent} recent`, `${c.archived} archived`);
      return `${row.ws.name}${row.ws.open ? ' (open in VS Code)' : ''}${row.ws.missing ? ' (folder not found)' : ''}: ${parts.join(', ')}`;
    }
    case 'session':
      return `${row.label}, ${PHASE_LABEL[row.phase]}${row.session.waitingFor ? `, waiting for ${row.session.waitingFor}` : ''}${
        row.agents > 1 ? `, ${row.agents} agents` : ''
      }`;
    case 'agent':
      return `Subagent ${row.agent.name}, ${row.agent.characterState}${row.agent.task ? `: ${row.agent.task}` : ''}`;
    case 'group':
      return `Archived sessions, ${row.count}`;
    case 'history':
      return `${row.label}, ${row.item.tier === 'recent' ? 'recent' : 'archived'} session, ${relativeTime(row.item.lastActivityAt, now)}`;
    case 'note':
      return row.text;
  }
}

function RowImpl({
  row,
  selected,
  focusable,
  now,
  onActivate,
  onToggle,
  onOpenBuilding,
}: {
  row: ListRow;
  selected: boolean;
  focusable: boolean;
  now: number;
  onActivate: (row: ListRow) => void;
  onToggle: (row: ListRow) => void;
  onOpenBuilding: (workspaceId: string) => void;
}) {
  const twisty = row.expandable ? (
    <span
      className={`lv-twisty${row.expanded ? ' is-open' : ''}`}
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(row);
      }}
    >
      ›
    </span>
  ) : (
    <span className="lv-twisty lv-twisty--none" aria-hidden="true" />
  );

  let body;
  switch (row.kind) {
    case 'workspace': {
      const c = row.counts;
      body = (
        <>
          <span className={`lv-house pal-${row.palette}${c.live ? '' : ' is-quiet'}`} aria-hidden="true" />
          <span className="lv-name">{row.ws.name}</span>
          {row.ws.open && <span className="lv-tag">open</span>}
          {row.ws.missing && <span className="lv-tag lv-tag--warn">folder not found</span>}
          <span className="lv-badges" aria-hidden="true">
            {c.waiting > 0 && <span className="lv-badge lv-badge--waiting">{PHASE_GLYPH.waiting} {c.waiting}</span>}
            {c.working > 0 && <span className="lv-badge lv-badge--working">{PHASE_GLYPH.working} {c.working}</span>}
            {c.failed > 0 && <span className="lv-badge lv-badge--failed">{PHASE_GLYPH.failed} {c.failed}</span>}
            {c.live > 0 && <span className="lv-badge lv-badge--live">● {c.live}</span>}
            {c.recent > 0 && <span className="lv-badge">{PHASE_GLYPH.resting} {c.recent}</span>}
            {c.archived > 0 && <span className="lv-badge">{PHASE_GLYPH.archived} {c.archived}</span>}
          </span>
          <button
            className="icon-button lv-enter"
            tabIndex={-1}
            title="Show this building in the city"
            aria-label={`Show ${row.ws.name} in the city`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenBuilding(row.ws.id);
            }}
          >
            ⌂
          </button>
          <span className="lv-meta">{row.lastActivityAt ? relativeTime(row.lastActivityAt, now) : ''}</span>
        </>
      );
      break;
    }
    case 'session': {
      const s = row.session;
      // past sessions: the glyph and the group say it already
      const detail =
        row.phase === 'archived' ? '' : row.phase === 'resting' ? 'recent' : (s.attention ?? (s.waitingFor ? `waiting for ${s.waitingFor}` : PHASE_LABEL[row.phase]));
      body = (
        <>
          <span className={`lv-glyph lv-glyph--${row.phase}`} aria-hidden="true">
            {PHASE_GLYPH[row.phase]}
          </span>
          <span className="lv-name">{row.label}</span>
          {detail && <span className="lv-detail">{detail}</span>}
          {s.gitBranch && <span className="lv-tag">{s.gitBranch}</span>}
          {row.agents > 1 && <span className="lv-badge" aria-hidden="true">{row.agents} agents</span>}
          <span className="lv-meta">{relativeTime(s.lastActivityAt ?? s.startedAt, now)}</span>
        </>
      );
      break;
    }
    case 'agent':
      body = (
        <>
          <span className={`lv-glyph lv-glyph--${row.agent.characterState}`} aria-hidden="true">
            {CHARACTER_GLYPH[row.agent.characterState]}
          </span>
          <span className="lv-name">{row.agent.name}</span>
          <span className="lv-detail">{row.agent.task ?? row.agent.agentType}</span>
        </>
      );
      break;
    case 'group':
      body = (
        <>
          <span className="lv-glyph lv-glyph--archived" aria-hidden="true">
            {PHASE_GLYPH.archived}
          </span>
          <span className="lv-name lv-name--group">Archived</span>
          <span className="lv-badge" aria-hidden="true">{row.count}</span>
        </>
      );
      break;
    case 'history':
      body = (
        <>
          <span className={`lv-glyph lv-glyph--${row.item.tier === 'recent' ? 'resting' : 'archived'}`} aria-hidden="true">
            {row.item.tier === 'recent' ? PHASE_GLYPH.resting : PHASE_GLYPH.archived}
          </span>
          <span className="lv-name">{row.label}</span>
          {row.item.gitBranch && <span className="lv-tag">{row.item.gitBranch}</span>}
          <span className="lv-meta">{relativeTime(row.item.lastActivityAt, now)}</span>
        </>
      );
      break;
    case 'note':
      body = <span className="lv-note">{row.text}</span>;
      break;
  }

  return (
    <div
      className={`lv-row lv-row--${row.kind} lv-level-${row.level}${selected ? ' is-selected' : ''}`}
      role="treeitem"
      aria-level={row.level}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      aria-label={rowLabel(row, now)}
      tabIndex={focusable ? 0 : -1}
      data-row-key={row.key}
      onClick={(e) => {
        e.stopPropagation();
        onActivate(row);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (row.expandable) onToggle(row);
      }}
    >
      {twisty}
      {body}
    </div>
  );
}

const Row = memo(RowImpl);

/**
 * The city as a list: a tree of companies -> sessions -> subagents with an "Archived" group per
 * company. Same data, filters, selection and details panel as the map - for when you want to scan
 * or search rather than look. Rows open with the arrow next to them, a double click or the arrow keys.
 */
function ListViewImpl(props: Props) {
  const { workspaces, sessions, agents, historyIndex, selection, onSelect, onOpenBuilding, onExpandedChange, sort, onSortChange, focusRequest, now, empty } = props;
  const expanded = useMemo(() => new Set(props.expanded), [props.expanded]);
  const rows = useMemo(
    () => buildListRows({ workspaces, sessions, agents, historyIndex, expanded, sort }),
    [workspaces, sessions, agents, historyIndex, expanded, sort],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  /** Roving tabindex: the row that Tab enters the tree on. */
  const [cursor, setCursor] = useState<string | undefined>();
  const cursorKey = cursor && rows.some((r) => r.key === cursor) ? cursor : rows[0]?.key;

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const setOpen = useCallback(
    (key: string, open?: boolean) => onExpandedChange([...toggleExpanded(expandedRef.current, key, open)]),
    [onExpandedChange],
  );
  const onToggle = useCallback((row: ListRow) => setOpen(row.key), [setOpen]);
  const onActivate = useCallback(
    (row: ListRow) => {
      setCursor(row.key);
      if (row.kind === 'group') setOpen(row.key);
      else if (row.selection) onSelect(row.selection, { keepFocus: true });
    },
    [onSelect, setOpen],
  );

  const focusRow = useCallback((key: string) => {
    setCursor(key);
    // after the render that makes the row focusable / visible
    setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    }, 0);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-row-key]');
    if (!el) return;
    const index = rows.findIndex((r) => r.key === el.dataset.rowKey);
    const row = rows[index];
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (row.kind === 'group') setOpen(row.key);
      else if (row.selection) onSelect(row.selection, { keepFocus: e.key === ' ' });
      return;
    }
    if (!TREE_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const nav = treeNav(rows, index, e.key as TreeKey);
    if (nav.toggle) setOpen(nav.toggle.key, nav.toggle.open);
    if (nav.focus) focusRow(nav.focus);
  };

  // show what the HUD / activity feed / details panel asked for
  const revealInput = useRef({ workspaces, sessions, agents });
  revealInput.current = { workspaces, sessions, agents };
  useEffect(() => {
    if (!focusRequest) return;
    const sel: Selection = { kind: focusRequest.kind, id: focusRequest.id };
    const need = keysToReveal(sel, revealInput.current);
    let next: Set<string> = new Set(expandedRef.current);
    for (const k of need) next = toggleExpanded(next, k, true);
    if (need.some((k) => !expandedRef.current.has(k))) onExpandedChange([...next]);
    const key = keyOfSelection(sel, revealInput.current.agents);
    if (key) focusRow(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const openCount = workspaces.reduce((n, w) => n + (expanded.has(wsKey(w.id)) ? 1 : 0), 0);

  return (
    <div className="list-view" ref={rootRef} onClick={() => onSelect(undefined)}>
      <div className="lv-bar glass" onClick={(e) => e.stopPropagation()}>
        <span className="lv-count" role="status">
          {workspaces.length} compan{workspaces.length === 1 ? 'y' : 'ies'}
        </span>
        <button className="secondary-button small-button" disabled={openCount === workspaces.length} onClick={() => onExpandedChange([...expandAll(expanded, workspaces)])}>
          Expand all
        </button>
        <button className="secondary-button small-button" disabled={props.expanded.length === 0} onClick={() => onExpandedChange([])}>
          Collapse all
        </button>
        <label className="lv-sort">
          Sort by
          <select value={sort} onChange={(e) => onSortChange(e.target.value as ListSort)}>
            {LIST_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        empty
      ) : (
        <div className="lv-tree" role="tree" aria-label="Companies, sessions and agents. Arrow keys move, Right opens, Left closes, Enter shows details." onKeyDown={onKeyDown}>
          {rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              selected={isRowSelected(row, selection)}
              focusable={row.key === cursorKey}
              now={now}
              onActivate={onActivate}
              onToggle={onToggle}
              onOpenBuilding={onOpenBuilding}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const ListView = memo(ListViewImpl);
