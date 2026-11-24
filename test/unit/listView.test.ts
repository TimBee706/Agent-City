import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/models/Agent';
import type { WorkspaceHistoryIndex } from '../../src/models/CityState';
import { Session, normalizeSession } from '../../src/models/Session';
import type { CityWorkspace } from '../../src/models/Workspace';
import { ListView, rowLabel } from '../../src/webview/ListView';
import {
  MAX_EXPANDED,
  agentKey,
  archiveKey,
  buildListRows,
  expandAll,
  historyKey,
  isRowSelected,
  keyOfSelection,
  keysToReveal,
  sanitizeExpanded,
  sanitizeListSort,
  sanitizeViewMode,
  sessionKey,
  sortWorkspaces,
  toggleExpanded,
  treeNav,
  wsKey,
} from '../../src/webview/listModel';
import { Toolbar } from '../../src/webview/Toolbar';
import { DEFAULT_FILTERS } from '../../src/webview/filters';
import { migrateUiState } from '../../src/webview/uiState';

const NOW = Date.UTC(2026, 10, 1);
const DAY = 86_400_000;
const hid = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;

function live(id: string, ws: string, status: string, startedAt: number): Session {
  return { ...normalizeSession({ sessionId: id, cwd: `/w/${ws}`, status, name: `task-${id}`, startedAt })!, workspaceId: ws };
}
function past(n: number, ws: string, tier: 'recent' | 'archived'): Session {
  return { id: hid(n), sessionId: hid(n), kind: 'history', state: 'unknown', status: 'unknown', origin: 'history', tier, name: `Old ${n}`, lastActivityAt: NOW - n * DAY, gitBranch: 'main', workspaceId: ws };
}
function workspace(id: string, name: string, sessions: Session[], extra: Partial<CityWorkspace> = {}): CityWorkspace {
  return { id, name, path: `/w/${id}`, firstSeen: 0, lastSeen: 0, source: 'session', pinned: false, open: false, sessionIds: sessions.map((s) => s.id), ...extra };
}

function fixture() {
  const a1 = live('a1', 'a', 'busy', NOW - 60_000);
  const a2 = live('a2', 'a', 'waiting', NOW - 120_000);
  const aRecent = past(1, 'a', 'recent');
  const aArch = [past(5, 'a', 'archived'), past(3, 'a', 'archived')];
  const b1 = live('b1', 'b', 'idle', NOW - 30_000);
  const sessions = [a1, a2, aRecent, ...aArch, b1];
  const workspaces = [
    workspace('b', 'Beta', [b1]),
    workspace('a', 'alpha', [a1, a2, aRecent, ...aArch], { archivedOverflow: 4 }),
    workspace('c', 'Cold', [], { missing: true }),
  ];
  const agents: Agent[] = [
    { agentId: 'a1:main', agentType: 'main', role: 'main', parentSessionId: 'a1', name: 'task-a1', characterState: 'busy' },
    { agentId: 'a1:sub1', agentType: 'Explore', role: 'subagent', parentSessionId: 'a1', name: 'Explore', characterState: 'working', task: 'find the bug' },
  ];
  const historyIndex: WorkspaceHistoryIndex[] = [
    {
      workspaceId: 'a',
      total: 5,
      items: [
        { id: hid(3), title: 'Old 3', lastActivityAt: NOW - 3 * DAY, tier: 'archived' }, // also a room
        { id: hid(7), title: 'Index only', lastActivityAt: NOW - 7 * DAY, tier: 'archived' },
        { id: hid(2), title: 'Recent overflow', lastActivityAt: NOW - 2 * DAY, tier: 'recent' },
      ],
    },
  ];
  return { sessions, workspaces, agents, historyIndex };
}

const rowsFor = (open: string[], sort: 'attention' | 'name' | 'activity' = 'attention') => {
  const f = fixture();
  return buildListRows({ ...f, expanded: new Set(open), sort });
};
const keys = (open: string[]) => rowsFor(open).map((r) => r.key);

describe('list model', () => {
  it('collapsed: one row per company, companies that need attention first', () => {
    const rows = rowsFor([]);
    expect(rows.map((r) => r.key)).toEqual([wsKey('a'), wsKey('b'), wsKey('c')]);
    expect(rows.every((r) => r.kind === 'workspace' && r.level === 1 && r.expandable && !r.expanded)).toBe(true);
    const a = rows[0];
    expect(a.kind === 'workspace' && a.counts).toEqual({ live: 2, working: 1, waiting: 1, failed: 0, recent: 1, archived: 6 });
  });

  it('an open company lists its sessions by urgency, then recent ones, then the archive group', () => {
    expect(keys([wsKey('a')])).toEqual([
      wsKey('a'),
      sessionKey('a2'), // waiting
      sessionKey('a1'), // working
      sessionKey(hid(1)), // recent room
      historyKey('a', hid(2)), // recent, only in the index
      archiveKey('a'),
      wsKey('b'),
      wsKey('c'),
    ]);
    const rows = rowsFor([wsKey('a')]);
    const group = rows.find((r) => r.key === archiveKey('a'));
    expect(group).toMatchObject({ kind: 'group', count: 6, level: 2, parent: wsKey('a'), expanded: false });
    const a1 = rows.find((r) => r.key === sessionKey('a1'));
    expect(a1).toMatchObject({ kind: 'session', expandable: true, expanded: false, agents: 2, phase: 'working' });
    expect(rows.find((r) => r.key === sessionKey('a2'))).toMatchObject({ expandable: false });
  });

  it('the archive group shows rooms and index-only sessions newest first, without duplicates, plus what is not listed', () => {
    const rows = rowsFor([wsKey('a'), archiveKey('a')]);
    const start = rows.findIndex((r) => r.key === archiveKey('a'));
    const inside = rows.slice(start + 1).filter((r) => r.parent === archiveKey('a'));
    expect(inside.map((r) => r.key)).toEqual([sessionKey(hid(3)), sessionKey(hid(5)), historyKey('a', hid(7)), 'n:a:more']);
    expect(inside.every((r) => r.level === 3)).toBe(true);
    expect(inside[3]).toMatchObject({ kind: 'note', text: '+3 older archived sessions not listed' }); // 6 - 2 rooms - 1 index
    expect(inside[2].selection).toEqual({ kind: 'history', id: hid(7), workspaceId: 'a' });
  });

  it('subagents appear under their session; a company without sessions says so', () => {
    const rows = rowsFor([wsKey('a'), sessionKey('a1'), wsKey('c')]);
    const i = rows.findIndex((r) => r.key === sessionKey('a1'));
    expect(rows[i + 1]).toMatchObject({ kind: 'agent', key: agentKey('a1:sub1'), level: 3, parent: sessionKey('a1') });
    expect(rows.filter((r) => r.kind === 'agent')).toHaveLength(1); // the main agent is the session row itself
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'note', text: 'Folder not found - no sessions.', parent: wsKey('c') });
  });

  it('sorts by attention, name or last activity', () => {
    const f = fixture();
    const byId = new Map(f.sessions.map((s) => [s.id, s]));
    const order = (sort: 'attention' | 'name' | 'activity') => sortWorkspaces(f.workspaces, byId, sort).map((w) => w.id);
    expect(order('attention')).toEqual(['a', 'b', 'c']);
    expect(order('name')).toEqual(['a', 'b', 'c']); // case-insensitive: alpha, Beta, Cold
    expect(order('activity')).toEqual(['b', 'a', 'c']); // b1 started last
  });

  it('selection marks exactly its row', () => {
    const rows = rowsFor([wsKey('a'), archiveKey('a')]);
    const selected = (sel: Parameters<typeof isRowSelected>[1]) => rows.filter((r) => isRowSelected(r, sel)).map((r) => r.key);
    expect(selected({ kind: 'workspace', id: 'a' })).toEqual([wsKey('a')]); // not the archive group
    expect(selected({ kind: 'session', id: 'a2' })).toEqual([sessionKey('a2')]);
    expect(selected({ kind: 'history', id: hid(7), workspaceId: 'a' })).toEqual([historyKey('a', hid(7))]);
    expect(selected(undefined)).toEqual([]);
  });

  it('toggle, expand all and the size cap', () => {
    let open = toggleExpanded(new Set(), 'w:a');
    expect([...open]).toEqual(['w:a']);
    open = toggleExpanded(open, 'w:a');
    expect(open.size).toBe(0);
    expect(toggleExpanded(new Set(['w:a']), 'w:a', true).has('w:a')).toBe(true);
    expect([...expandAll(new Set(['g:a']), [{ id: 'a' }, { id: 'b' }])]).toEqual(['g:a', 'w:a', 'w:b']);
    let many: Set<string> = new Set();
    for (let i = 0; i < MAX_EXPANDED + 5; i++) many = toggleExpanded(many, `w:${i}`, true);
    expect(many.size).toBe(MAX_EXPANDED);
    expect(many.has('w:0')).toBe(false); // oldest dropped
    expect(many.has(`w:${MAX_EXPANDED + 4}`)).toBe(true);
  });

  it('reveals the parents of a selection and knows its row', () => {
    const f = fixture();
    expect(keysToReveal({ kind: 'session', id: 'a2' }, f)).toEqual([wsKey('a')]);
    expect(keysToReveal({ kind: 'session', id: hid(5) }, f)).toEqual([wsKey('a'), archiveKey('a')]);
    expect(keysToReveal({ kind: 'agent', id: 'a1:sub1' }, f)).toEqual([wsKey('a'), sessionKey('a1')]);
    expect(keysToReveal({ kind: 'agent', id: 'a1:main' }, f)).toEqual([wsKey('a')]);
    expect(keysToReveal({ kind: 'history', id: hid(7), workspaceId: 'a' }, f)).toEqual([wsKey('a'), archiveKey('a')]);
    expect(keysToReveal({ kind: 'workspace', id: 'a' }, f)).toEqual([]);
    expect(keysToReveal({ kind: 'session', id: 'gone' }, f)).toEqual([]);
    expect(keyOfSelection({ kind: 'agent', id: 'a1:main' }, f.agents)).toBe(sessionKey('a1'));
    expect(keyOfSelection({ kind: 'agent', id: 'a1:sub1' }, f.agents)).toBe(agentKey('a1:sub1'));
    expect(keyOfSelection({ kind: 'workspace', id: 'a' })).toBe(wsKey('a'));
  });

  it('tree keyboard navigation', () => {
    const rows = rowsFor([wsKey('a')]);
    const idx = (k: string) => rows.findIndex((r) => r.key === k);
    expect(treeNav(rows, 0, 'ArrowDown')).toEqual({ focus: sessionKey('a2') });
    expect(treeNav(rows, 0, 'ArrowUp')).toEqual({ focus: wsKey('a') }); // stays on the first row
    expect(treeNav(rows, 0, 'End')).toEqual({ focus: wsKey('c') });
    expect(treeNav(rows, 3, 'Home')).toEqual({ focus: wsKey('a') });
    // Right: open a closed row, or step into an open one; nothing on a leaf
    expect(treeNav(rows, idx(wsKey('b')), 'ArrowRight')).toEqual({ toggle: { key: wsKey('b'), open: true } });
    expect(treeNav(rows, 0, 'ArrowRight')).toEqual({ focus: sessionKey('a2') });
    expect(treeNav(rows, idx(sessionKey('a2')), 'ArrowRight')).toEqual({});
    // Left: close an open row, or go to the parent
    expect(treeNav(rows, 0, 'ArrowLeft')).toEqual({ toggle: { key: wsKey('a'), open: false } });
    expect(treeNav(rows, idx(sessionKey('a2')), 'ArrowLeft')).toEqual({ focus: wsKey('a') });
    expect(treeNav(rows, idx(wsKey('b')), 'ArrowLeft')).toEqual({});
    expect(treeNav([], 0, 'ArrowDown')).toEqual({});
  });

  it('persisted values are sanitized', () => {
    expect(sanitizeViewMode('list')).toBe('list');
    expect(sanitizeViewMode('grid')).toBe('city');
    expect(sanitizeListSort('name')).toBe('name');
    expect(sanitizeListSort(7)).toBe('attention');
    expect(sanitizeExpanded(['w:a', 5, '', 'x', 'g:a'])).toEqual(['w:a', 'g:a']);
    expect(sanitizeExpanded('w:a')).toEqual([]);
    const m = migrateUiState({ v: 4, view: 'list', listExpanded: ['w:a', null], listSort: 'activity' });
    expect(m).toMatchObject({ view: 'list', listExpanded: ['w:a'], listSort: 'activity' });
    expect(migrateUiState({ v: 4 })).not.toHaveProperty('view');
    expect(migrateUiState({ v: 99, view: 'list' })).not.toHaveProperty('view'); // unknown newer state
  });
});

describe('list view rendering', () => {
  const render = (open: string[], extra: Record<string, unknown> = {}) => {
    const f = fixture();
    return renderToStaticMarkup(
      createElement(ListView, {
        ...f,
        selection: undefined,
        onSelect: () => undefined,
        onOpenBuilding: () => undefined,
        expanded: open,
        onExpandedChange: () => undefined,
        sort: 'attention',
        onSortChange: () => undefined,
        focusRequest: undefined,
        now: NOW,
        empty: null,
        ...extra,
      }),
    );
  };
  const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

  it('is an accessible tree with one focusable row and expand / collapse state', () => {
    const html = render([wsKey('a')]);
    expect(html).toContain('role="tree"');
    expect(count(html, /role="treeitem"/g)).toBe(8);
    expect(count(html, /tabindex="0" data-row-key/g)).toBe(1); // roving tabindex
    expect(html).toMatch(/aria-level="1" aria-expanded="true"[^>]*data-row-key="w:a"/);
    expect(html).toMatch(/aria-level="1" aria-expanded="false"[^>]*data-row-key="w:b"/);
    expect(html).toMatch(/aria-level="2" aria-selected="false"[^>]*data-row-key="s:a2"/); // leaf: no aria-expanded
    expect(html).toContain('alpha: 2 live sessions, 1 waiting for input, 1 working, 1 recent, 6 archived');
    expect(html).toContain('Cold (folder not found): 0 live sessions, 0 recent, 0 archived');
    expect(html).toContain('3 companies');
    expect(html).not.toMatch(/style=/);
  });

  it('marks the selection and offers expand all / collapse all / sorting', () => {
    const html = render([wsKey('a')], { selection: { kind: 'session', id: 'a2' } });
    expect(html).toMatch(/lv-row--session lv-level-2 is-selected"[^>]*aria-selected="true"/);
    expect(html).toContain('Expand all');
    expect(html).toContain('Collapse all');
    expect(html).toContain('Needs attention first');
    expect(render([])).toMatch(/<button[^>]*disabled=""[^>]*>Collapse all/);
  });

  it('row labels never rely on colour', () => {
    const rows = rowsFor([wsKey('a'), sessionKey('a1'), archiveKey('a')]);
    const label = (k: string) => rowLabel(rows.find((r) => r.key === k)!, NOW);
    expect(label(sessionKey('a2'))).toBe('task-a2, waiting for input');
    expect(label(sessionKey('a1'))).toBe('task-a1, working, 2 agents');
    expect(label(agentKey('a1:sub1'))).toBe('Subagent Explore, working: find the bug');
    expect(label(archiveKey('a'))).toBe('Archived sessions, 6');
    expect(label(historyKey('a', hid(7)))).toBe('Index only, archived session, 7d ago');
  });

  it('the toolbar shows the city / list switch only when it can switch', () => {
    const base = { filters: DEFAULT_FILTERS, onChange: () => undefined, hiddenWorkspaces: 0, hiddenSessions: 0, active: false };
    expect(renderToStaticMarkup(createElement(Toolbar, base))).not.toContain('view-switch');
    const html = renderToStaticMarkup(createElement(Toolbar, { ...base, view: 'list', onViewChange: () => undefined }));
    expect(html).toMatch(/view-switch-button" aria-pressed="false"[^>]*>.*City/);
    expect(html).toMatch(/view-switch-button is-on" aria-pressed="true"[^>]*>.*List/);
  });
});
