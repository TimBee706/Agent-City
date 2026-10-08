import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '../models/AgentEvent';
import type { CityState } from '../models/CityState';
import { computeCounts, emptyCityState } from '../models/CityState';
import { ViewKind, parseExtensionMessage } from '../shared/protocol';
import { BuildingView } from './BuildingView';
import { CityMap, FocusRequest } from './CityMap';
import { DetailPanel } from './DetailPanel';
import { EventFeed } from './EventFeed';
import { CityFilters, DEFAULT_FILTERS, applyFilters } from './filters';
import { SPARKLE_MS, announcementFor, combineAnnouncements, dayPeriod, sparkleTargets } from './highlights';
import { Hud } from './Hud';
import { CITY_NAV, NavState } from './navigation';
import { SelectOptions, Selection } from './selection';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { getPersistedUiState, postToExtension, setPersistedUiState } from './vscodeApi';
import { BuildingCamera, UiState, migrateUiState } from './uiState';
import { ViewTransform } from './zoom';

const FEED_LIMIT = 150;
const VISIBLE_EVENTS = 60;
const ANNOUNCE_INTERVAL_MS = 4000;

/** Merges events by id, newest first, bounded. */
export function mergeEvents(existing: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1)).slice(0, FEED_LIMIT);
}

function loadUi(): UiState {
  const ui = migrateUiState(getPersistedUiState<unknown>());
  setPersistedUiState<UiState>(ui); // store the migrated version right away (one-time reset)
  return ui;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Polite live region, throttled: at most one announcement every few seconds (coalesced). */
function useAnnouncer(): [string, (items: string[]) => void] {
  const [text, setText] = useState('');
  const queue = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const last = useRef(0);
  const flush = useCallback(() => {
    timer.current = undefined;
    if (!queue.current.length) return;
    setText(combineAnnouncements(queue.current));
    queue.current = [];
    last.current = Date.now();
  }, []);
  const announce = useCallback(
    (items: string[]) => {
      if (!items.length) return;
      queue.current.push(...items);
      if (timer.current) return;
      const wait = Math.max(0, last.current + ANNOUNCE_INTERVAL_MS - Date.now());
      timer.current = setTimeout(flush, wait);
    },
    [flush],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return [text, announce];
}

export function App({ view }: { view: ViewKind }) {
  const initial = useMemo(loadUi, []);
  const [state, setState] = useState<CityState>(() => emptyCityState('loading'));
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [selection, setSelection] = useState<Selection>(initial.selection);
  const [filters, setFilters] = useState<CityFilters>(initial.filters ?? DEFAULT_FILTERS);
  const [sparkles, setSparkles] = useState<ReadonlySet<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState<FocusRequest | undefined>();
  const [fitRequest, setFitRequest] = useState(0);
  const [nav, setNav] = useState<NavState>(initial.nav ?? CITY_NAV);
  const [panelAutoFocus, setPanelAutoFocus] = useState(true);
  const [announcement, announce] = useAnnouncer();
  const now = useNow(15_000);

  const ui = useRef<UiState>(initial);
  const persist = useCallback((patch: Partial<UiState>) => {
    ui.current = { ...ui.current, ...patch };
    setPersistedUiState<UiState>(ui.current);
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = parseExtensionMessage(ev.data);
      if (!msg) return;
      if (msg.type === 'state') {
        setState(msg.state);
        setEvents((prev) => mergeEvents(prev, msg.state.events));
        return;
      }
      if (msg.type === 'fitCity') {
        setFitRequest((n) => n + 1);
        return;
      }
      setEvents((prev) => mergeEvents(prev, msg.events));
      // Animations/announcements are driven by the live event stream (independent of polling).
      const targets = sparkleTargets(msg.events);
      if (targets.length) {
        setSparkles((prev) => new Set([...prev, ...targets]));
        setTimeout(() => {
          setSparkles((prev) => {
            const next = new Set(prev);
            for (const t of targets) next.delete(t);
            return next;
          });
        }, SPARKLE_MS);
      }
      announce(
        msg.events.map((e) => announcementFor(e, stateRef.current.sessions)).filter((t): t is string => !!t),
      );
    };
    window.addEventListener('message', onMessage);
    postToExtension({ type: 'ready', view });
    return () => window.removeEventListener('message', onMessage);
  }, [view, announce]);

  // Clear the feed when the data source flips between live and demo.
  const sourceKind = state.source === 'demo' ? 'demo' : 'live';
  useEffect(() => {
    setEvents((prev) => prev.filter((e) => (e.source === 'demo') === (sourceKind === 'demo')));
  }, [sourceKind]);

  // ------------------------------------------------------------------ selection + focus management
  const returnFocus = useRef<HTMLElement | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelect = useCallback(
    (sel: Selection, opts?: SelectOptions) => {
      setPanelAutoFocus(!opts?.keepFocus);
      if (!selectionRef.current && sel && document.activeElement instanceof HTMLElement) {
        returnFocus.current = document.activeElement;
      } else if (!selectionRef.current && sel && document.activeElement instanceof SVGElement) {
        returnFocus.current = document.activeElement as unknown as HTMLElement;
      }
      if (selectionRef.current && !sel) {
        const target = returnFocus.current;
        returnFocus.current = null;
        setTimeout(() => {
          if (target && target.isConnected) target.focus({ preventScroll: true });
          else document.querySelector<HTMLElement>('.city-map')?.focus({ preventScroll: true });
        }, 0);
      }
      setSelection(sel);
      persist({ selection: sel });
    },
    [persist],
  );

  // ------------------------------------------------------------------ levels: city <-> building
  const navRef = useRef(nav);
  navRef.current = nav;
  const openBuilding = useCallback(
    (workspaceId: string) => {
      const next: NavState = { level: 'building', workspaceId };
      setNav(next);
      persist({ nav: next });
    },
    [persist],
  );
  const backToCity = useCallback(() => {
    const from = navRef.current.workspaceId;
    setNav(CITY_NAV);
    persist({ nav: CITY_NAV });
    // restore focus on the building we came from (the city map keeps its camera while hidden)
    setTimeout(() => {
      const sel = from ? `.city-map [data-workspace-id="${CSS.escape(from)}"] .bld-shell` : '';
      const el = (sel && document.querySelector<SVGGElement>(sel)) || document.querySelector<HTMLElement>('.city-map');
      el?.focus({ preventScroll: true });
    }, 0);
  }, [persist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (t && t.tagName === 'INPUT' && (t as HTMLInputElement).value) return; // the search box clears itself first
        if (selectionRef.current) {
          e.preventDefault();
          onSelect(undefined);
        } else if (navRef.current.level === 'building') {
          e.preventDefault();
          backToCity();
        }
        return;
      }
      if (e.key === 'Backspace' && !typing && navRef.current.level === 'building') {
        e.preventDefault();
        backToCity();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onSelect, backToCity]);

  const onFilters = useCallback(
    (f: CityFilters) => {
      setFilters(f);
      persist({ filters: f });
    },
    [persist],
  );
  const onTransformChange = useCallback((t: ViewTransform) => persist({ zoom: t }), [persist]);
  const onBuildingTransformChange = useCallback(
    (t: ViewTransform) => {
      const id = navRef.current.workspaceId;
      if (id) persist({ buildingZoom: { workspaceId: id, t } satisfies BuildingCamera });
    },
    [persist],
  );
  const nonce = useRef(0);
  /** Shows a session where it lives: zoom to its building (city) or its room (that building's view). */
  const revealSession = useCallback(
    (id: string) => {
      const ws = stateRef.current.workspaces.find((w) => w.sessionIds.includes(id));
      const cur = navRef.current;
      if (cur.level === 'building' && ws && ws.id !== cur.workspaceId) openBuilding(ws.id);
      setFocusRequest({ kind: 'session', id, nonce: ++nonce.current });
    },
    [openBuilding],
  );
  const focusSession = useCallback(
    (id: string) => {
      onSelect({ kind: 'session', id });
      revealSession(id);
    },
    [onSelect, revealSession],
  );
  const focusWorkspace = useCallback(
    (id: string) => {
      onSelect({ kind: 'workspace', id });
      if (navRef.current.level === 'building' && navRef.current.workspaceId !== id) openBuilding(id);
      setFocusRequest({ kind: 'workspace', id, nonce: ++nonce.current });
    },
    [onSelect, openBuilding],
  );
  /** Activity feed: select the session / agent and show its building or room. */
  const onFeedSelect = useCallback(
    (sel: Selection) => {
      onSelect(sel);
      if (!sel) return;
      if (sel.kind === 'session') revealSession(sel.id);
      else if (sel.kind === 'agent') {
        const a = stateRef.current.agents.find((x) => x.agentId === sel.id);
        if (a) revealSession(a.parentSessionId);
      }
    },
    [onSelect, revealSession],
  );

  const filtered = useMemo(() => applyFilters(state, filters), [state, filters]);
  const buildingWs = nav.level === 'building' ? filtered.workspaces.find((w) => w.id === nav.workspaceId) : undefined;
  const buildingData = useMemo(() => {
    if (!buildingWs) return { sessions: [], agents: [], history: undefined };
    const ids = new Set(buildingWs.sessionIds);
    return {
      sessions: filtered.sessions.filter((s) => ids.has(s.id)),
      agents: filtered.agents.filter((a) => ids.has(a.parentSessionId)),
      history: state.historyIndex?.find((x) => x.workspaceId === buildingWs.id)?.items,
    };
  }, [buildingWs, filtered, state.historyIndex]);
  const visibleEvents = useMemo(() => events.slice(0, VISIBLE_EVENTS), [events]);

  if (view === 'sidebar') return <Sidebar state={state} />;

  const period = state.config?.dayNight === false ? undefined : dayPeriod(new Date(now).getHours());
  const live = state.source === 'live';
  const noSessions = live && computeCounts(state).sessions === 0; // recent / archived rooms do not count
  const hooks = state.hooks;

  let emptyContent;
  if (state.source === 'loading') {
    emptyContent = (
      <div className="city-empty" role="status">
        <span className="spinner" aria-hidden="true" />
        <p className="city-empty-title">Loading Claude sessions…</p>
        <p>Asking the Claude CLI which sessions are running.</p>
      </div>
    );
  } else if (filtered.active && state.workspaces.length > 0) {
    emptyContent = (
      <div className="city-empty" role="status">
        <p className="city-empty-title">Nothing matches the current filters.</p>
        <button className="secondary-button" onClick={() => onFilters({ ...DEFAULT_FILTERS })}>
          Clear filters
        </button>
      </div>
    );
  } else {
    emptyContent = (
      <div className="city-empty" role="status">
        <p className="city-empty-title">The city is quiet.</p>
        <p>
          No workspaces yet. Import the folder that contains your projects - every project becomes a building - or start{' '}
          <code>claude</code> in a terminal (or the Claude Code extension) and it appears here within a few seconds.
        </p>
        <div className="city-empty-actions">
          <button className="primary-button" onClick={() => postToExtension({ type: 'importWorkspaces' })}>
            Import Workspaces from Folder…
          </button>
          <button className="secondary-button" onClick={() => postToExtension({ type: 'toggleDemo' })}>
            Show demo data
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`app source-${state.source}${period ? ` tint-${period}` : ''}`}>
      <Hud state={state} onFocusSession={focusSession} onFocusWorkspace={focusWorkspace} />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {state.source === 'demo' && (
        <div className="banner banner--demo" role="note">
          <strong>DEMO</strong> — simulated data{state.error ? `. ${state.error}` : ''}
        </div>
      )}
      {(state.source === 'unavailable' || state.source === 'error') && (
        <div className="banner banner--error" role="alert">
          <span>
            {state.source === 'unavailable'
              ? 'Claude CLI unavailable - install Claude Code or set claudeCity.claudePath'
              : 'Could not read sessions'}
            : {state.error ?? 'unknown reason'}
          </span>
          <button className="secondary-button" onClick={() => postToExtension({ type: 'refresh' })}>
            Retry
          </button>
        </div>
      )}
      {noSessions && state.workspaces.length > 0 && (
        <div className="banner banner--info" role="status">
          No Claude Code sessions are running right now. Start <code>claude</code> in one of these workspaces and it moves in
          {state.sessions.length > 0 ? ' (recent sessions rest in their rooms, archived ones are boxes in each building’s basement).' : '.'}
        </div>
      )}
      {hooks?.bridge === 'unavailable' && live && (
        <div className="banner banner--warn" role="note">
          <span>Live events unavailable ({hooks.error ?? 'unknown'}). Polling still works.</span>
          <button className="secondary-button" onClick={() => postToExtension({ type: 'refresh' })}>
            Retry
          </button>
        </div>
      )}
      {hooks?.bridge === 'running' && (hooks.install === 'none' || hooks.install === 'outdated') && live && (
        <div className="banner banner--info" role="note">
          <span>
            {hooks.install === 'outdated'
              ? 'Claude City hooks use an old port or token.'
              : 'Tip: install Claude City hooks for live subagents, tasks and attention alerts.'}
          </span>
          <button className="secondary-button" onClick={() => postToExtension({ type: 'installHooks' })}>
            {hooks.install === 'outdated' ? 'Reinstall hooks…' : 'Install hooks…'}
          </button>
        </div>
      )}
      <Toolbar
        filters={filters}
        onChange={onFilters}
        active={filtered.active}
        hiddenWorkspaces={filtered.hiddenWorkspaces}
        hiddenSessions={filtered.hiddenSessions}
      />
      <div className="layout">
        <div className="map-area">
        <CityMap
          workspaces={filtered.workspaces}
          sessions={filtered.sessions}
          agents={filtered.agents}
          selection={selection}
          onSelect={onSelect}
          onOpen={openBuilding}
          active={nav.level === 'city'}
          initialTransform={initial.zoom}
          onTransformChange={onTransformChange}
          focusRequest={focusRequest}
          fitRequest={fitRequest}
          empty={emptyContent}
        />
        {nav.level === 'building' &&
          (buildingWs ? (
            <BuildingView
              key={buildingWs.id}
              workspace={buildingWs}
              sessions={buildingData.sessions}
              agents={buildingData.agents}
              history={buildingData.history}
              selection={selection}
              onSelect={onSelect}
              onBack={backToCity}
              sparkles={sparkles}
              initialTransform={ui.current.buildingZoom?.workspaceId === buildingWs.id ? ui.current.buildingZoom.t : undefined}
              onTransformChange={onBuildingTransformChange}
              focusRequest={focusRequest}
            />
          ) : (
            <div className="building-gone city-empty" role="status">
              <p className="city-empty-title">This building is not shown.</p>
              <p>It is hidden by the current filters or no longer part of the city.</p>
              <button className="primary-button" onClick={backToCity}>
                Back to city
              </button>
            </div>
          ))}
        </div>
        <div className="side-column">
          <DetailPanel
            state={state}
            events={events}
            selection={selection}
            onSelect={onSelect}
            now={now}
            autoFocus={panelAutoFocus}
            currentBuilding={nav.level === 'building' ? nav.workspaceId : undefined}
            onOpenBuilding={openBuilding}
            onBackToCity={backToCity}
          />
          <EventFeed events={visibleEvents} onSelect={onFeedSelect} />
        </div>
      </div>
    </div>
  );
}
