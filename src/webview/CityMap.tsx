import { Fragment, ReactNode, memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { Agent } from '../models/Agent';
import type { Session } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';
import { WALK_IN_WINDOW_MS } from './AgentCharacter';
import { CityFxHandle, CityFxLayer, FxItem, fxActive, fxViewKey } from './CityFx';
import { CityGround, PlotDecos, RoadProps } from './CityGround';
import { BuildingPlacement, CityCell, Decoration, buildingRect, computeCityGrid, computeCityLayout } from './cityLayout';
import { FACADE, FacadeModel, computeFacade } from './facade';
import { BuildingPlate, IsoBuilding, buildingAnchors, buildingSignature } from './IsoBuilding';
import { makeProjector } from './iso';
import { MiniBuilding, MiniMap, MiniTone, viewRect } from './MiniMap';
import { prefersReducedMotion, useReducedMotion } from './motion';
import { ArrowDir, nextNeedingAttention, spatialNext } from './navigation';
import { Select, Selection } from './selection';
import { Birds, Sky } from './Sky';
import { ToyCars } from './ToyCars';
import { PZ_LAYER, usePanZoom } from './usePanZoom';
import { ViewTransform, ZOOM_STEP } from './zoom';

export interface FocusRequest {
  kind: 'workspace' | 'session';
  id: string;
  nonce: number;
}

interface Props {
  workspaces: readonly CityWorkspace[];
  sessions: readonly Session[];
  agents: readonly Agent[];
  selection: Selection;
  onSelect: Select;
  /** Enter a building (level 2). */
  onOpen: (workspaceId: string) => void;
  initialTransform: ViewTransform | undefined;
  onTransformChange: (t: ViewTransform) => void;
  focusRequest: FocusRequest | undefined;
  /** Changes (nonce) when the extension asks to zoom-to-fit, e.g. after an import. */
  fitRequest?: number;
  /** Changes (nonce) when the user asks for the next building that needs attention (command). */
  attentionRequest?: number;
  /** Called when such a request (or the taxi) finds nothing to show. */
  onNothingToAttend?: () => void;
  /** False while the building level is shown (map hidden, cars paused). */
  active: boolean;
  empty: ReactNode;
  /** Agent ids whose task was just completed (fireworks over their building). */
  sparkles?: ReadonlySet<string>;
  /** Ambient effects (clouds, birds, smoke). Default on; always off with reduced motion. */
  effects?: boolean;
}

/** A fit request also re-fits on layout changes within this window (the new state may arrive later). */
const FIT_PENDING_MS = 3000;
/** Level of detail: below these zoom levels small decorations / labels are hidden. */
export const LOD_FAR = 0.5;
export const LOD_TINY = 0.28;

/** The minimap appears from this many buildings on. */
export const MINIMAP_MIN_BUILDINGS = 6;
/** Period of the slow clock that switches traffic lights, window flicker and beacons. */
export const TICK_MS = 700;

const NO_AGENTS: readonly Agent[] = [];
const NO_SPARKLES: ReadonlySet<string> = new Set();
const NO_SESSIONS: readonly Session[] = [];
const NO_DECOS: readonly Decoration[] = [];

/** CSS classes for a zoom level (level of detail). */
export function lodClasses(k: number): { far: boolean; tiny: boolean } {
  return { far: k < LOD_FAR, tiny: k < LOD_TINY };
}

/** Minimap colour of a building: what needs attention wins. */
export function miniTone(f: Pick<FacadeModel, 'waiting' | 'failed' | 'working' | 'live'>): MiniTone {
  if (f.waiting) return 'waiting';
  if (f.failed) return 'failed';
  if (f.working) return 'working';
  return f.live ? 'live' : 'quiet';
}

function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}

/**
 * Level 1: the city as an isometric play rug - streets, parks, trees, toy cars and one toy house
 * per workspace. Zoom / pan is ref-based (no React re-render), the ground is memoised per grid.
 *
 * The scene is split into stacked SVG layers that share one camera: ground, cars, buildings and
 * effects. Everything that animates continuously lives in the small cars / effects layers, so a
 * moving car or a puff of smoke never makes the browser redraw (or re-layer) the whole city.
 */
function CityMapImpl(props: Props) {
  const { workspaces, sessions, agents, selection, onSelect, onOpen, initialTransform, onTransformChange, focusRequest, fitRequest, active, empty } =
    props;
  const sparkles = props.sparkles ?? NO_SPARKLES;
  const reduced = useReducedMotion();
  const effects = props.effects !== false && !reduced;

  const grid = useMemo(() => computeCityGrid(workspaces.length), [workspaces.length]);
  const layout = useMemo(() => computeCityLayout({ workspaces, sessions }, grid), [workspaces, sessions, grid]);

  const frameRef = useRef<SVGRectElement>(null);
  /** Buildings that could show effects, with their screen rect (for view culling in onFrame). */
  const fxCandidates = useRef<{ id: string; x: number; y: number; width: number; height: number }[]>([]);
  const fxRef = useRef<CityFxHandle>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onFrame = useCallback((t: ViewTransform) => {
    const root = rootRef.current;
    if (!root) return;
    const lod = lodClasses(t.k);
    root.classList.toggle('lod-far', lod.far);
    root.classList.toggle('lod-tiny', lod.tiny);
    const v = viewRect(t, sizeRef.current);
    const frame = frameRef.current;
    if (frame) {
      frame.setAttribute('x', String(Math.round(v.x)));
      frame.setAttribute('y', String(Math.round(v.y)));
      frame.setAttribute('width', String(Math.round(v.width)));
      frame.setAttribute('height', String(Math.round(v.height)));
    }
    const m = 80 / t.k;
    const inView: string[] = [];
    for (const c of fxCandidates.current) {
      if (c.x + c.width >= v.x - m && c.x <= v.x + v.width + m && c.y + c.height >= v.y - m && c.y <= v.y + v.height + m) inView.push(c.id);
    }
    fxRef.current?.setView(fxViewKey(lod.far, inView));
  }, []);
  const pz = usePanZoom({
    // no buildings yet (e.g. the first, empty state): no content, so the first real city is fitted
    content: workspaces.length ? { width: grid.width, height: grid.height } : { width: 0, height: 0 },
    initial: initialTransform,
    onChange: onTransformChange,
    onFrame,
  });
  const { fitAll, zoomToRect, zoomCenter, centerOn, ensureVisible, handlers } = pz;
  sizeRef.current = pz.size;
  /** One element, two refs: the pan / zoom surface and the root that onFrame toggles classes on. */
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      (pz.ref as { current: HTMLDivElement | null }).current = el;
    },
    [pz.ref],
  );

  // ------------------------------------------------------------------ per-workspace data
  const data = useMemo(() => {
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const wsOfSession = new Map<string, string>();
    const perWs = new Map<string, Session[]>();
    for (const w of workspaces) {
      const list: Session[] = [];
      for (const id of w.sessionIds) {
        const s = sessionsById.get(id);
        if (s) {
          list.push(s);
          wsOfSession.set(s.id, w.id);
        }
      }
      perWs.set(w.id, list);
    }
    // subagents that just spawned or are leaving walk between the street and the door
    const walkers = new Map<string, Agent[]>();
    const now = Date.now();
    for (const a of agents) {
      if (a.role !== 'subagent') continue;
      if (!a.leaving && !(a.spawnedAt && now - a.spawnedAt < WALK_IN_WINDOW_MS)) continue;
      const wsId = wsOfSession.get(a.parentSessionId);
      if (!wsId) continue;
      const list = walkers.get(wsId) ?? [];
      list.push(a);
      walkers.set(wsId, list);
    }
    const agentWs = new Map<string, string>();
    for (const a of agents) {
      const wsId = wsOfSession.get(a.parentSessionId);
      if (wsId) agentWs.set(a.agentId, wsId);
    }
    return { perWs, walkers, wsOfSession, agentWs };
  }, [workspaces, sessions, agents]);

  const workspacesById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const placementById = useMemo(() => new Map(layout.buildings.map((b) => [b.workspaceId, b])), [layout]);
  const buildingByCell = useMemo(() => new Map(layout.buildings.map((b) => [b.cell, b])), [layout]);

  // painter's order of plots + their back / front decorations (static per grid)
  const plots = useMemo(() => {
    const back = new Map<number, Decoration[]>();
    const front = new Map<number, Decoration[]>();
    for (const d of grid.decorations) {
      if (d.layer !== 'back' && d.layer !== 'front') continue;
      const m = d.layer === 'back' ? back : front;
      const list = m.get(d.cell) ?? [];
      list.push(d);
      m.set(d.cell, list);
    }
    for (const m of [back, front]) for (const list of m.values()) list.sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.gx - b.gx);
    const order: CityCell[] = [...grid.cells].sort((a, b) => a.col + a.row - (b.col + b.row) || a.col - a.row - (b.col - b.row));
    return { order, back, front };
  }, [grid]);

  /** Facade model per building (also used by the effects layer, the minimap and the taxi). */
  const facades = useMemo(() => {
    const m = new Map<string, FacadeModel>();
    for (const b of layout.buildings) {
      const ws = workspacesById.get(b.workspaceId);
      if (ws) m.set(b.workspaceId, computeFacade(data.perWs.get(b.workspaceId) ?? NO_SESSIONS, ws));
    }
    return m;
  }, [layout, workspacesById, data]);

  const rectOf = useCallback(
    (b: BuildingPlacement) => {
      const f = facades.get(b.workspaceId);
      const h = f ? f.heightPx + 30 : FACADE.BASE_H + FACADE.FLOOR_H;
      const r = buildingRect(grid, b, h);
      return { x: r.x - 10, y: r.y, width: r.width + 20, height: r.height + 24 };
    },
    [facades, grid],
  );

  // ------------------------------------------------------------------ fit / focus requests
  const fitPendingUntil = useRef(0);
  useEffect(() => {
    if (!fitRequest) return;
    fitPendingUntil.current = Date.now() + FIT_PENDING_MS;
    if (layout.buildings.length > 0) fitAll({ animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);
  useEffect(() => {
    if (fitPendingUntil.current > Date.now() && layout.buildings.length > 0) fitAll();
  }, [grid, fitAll, layout.buildings.length]);

  const zoomToWorkspace = useCallback(
    (id: string) => {
      const b = placementById.get(id);
      if (b) zoomToRect(rectOf(b), 1.6);
    },
    [placementById, rectOf, zoomToRect],
  );

  useEffect(() => {
    if (!focusRequest) return;
    const wsId = focusRequest.kind === 'workspace' ? focusRequest.id : data.wsOfSession.get(focusRequest.id);
    if (wsId) zoomToWorkspace(wsId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const focusBuilding = useCallback(
    (id: string) => {
      const el = document.querySelector<SVGGElement>(`.city-map [data-workspace-id="${cssEscape(id)}"] .bld-shell`);
      el?.focus({ preventScroll: true });
      const b = placementById.get(id);
      if (b) ensureVisible(rectOf(b), 60);
    },
    [placementById, ensureVisible, rectOf],
  );

  // ------------------------------------------------------------------ keyboard: spatial navigation
  const navPoints = useMemo(() => layout.buildings.map((b) => ({ id: b.workspaceId, x: b.center.x, y: b.center.y })), [layout]);
  const arrowImpl = (id: string, dir: ArrowDir) => {
    const next = spatialNext(navPoints, id, dir);
    if (!next || next === id) return;
    focusBuilding(next);
    onSelect({ kind: 'workspace', id: next }, { keepFocus: true });
  };
  const arrowRef = useRef(arrowImpl);
  arrowRef.current = arrowImpl;
  /** Stable identity (buildings are memoised), always calls the latest implementation. */
  const onArrow = useCallback((id: string, dir: ArrowDir) => arrowRef.current(id, dir), []);

  // ------------------------------------------------------------------ taxi
  const lastTaxi = useRef<string | undefined>();
  const taxiImpl = () => {
    const urgency = new Map<string, number>();
    for (const b of layout.buildings) {
      const f = facades.get(b.workspaceId);
      if (f) urgency.set(b.workspaceId, f.waiting ? 3 : f.failed ? 2 : f.working ? 1 : 0);
    }
    const target = nextNeedingAttention(
      layout.buildings.map((b) => b.workspaceId),
      urgency,
      lastTaxi.current,
    );
    if (!target) {
      props.onNothingToAttend?.();
      return;
    }
    lastTaxi.current = target;
    zoomToWorkspace(target);
    focusBuilding(target);
    onSelect({ kind: 'workspace', id: target }, { keepFocus: true });
  };
  const taxiRef = useRef(taxiImpl);
  taxiRef.current = taxiImpl;
  const onTaxi = useCallback(() => taxiRef.current(), []);
  const attentionRequest = props.attentionRequest;
  useEffect(() => {
    if (attentionRequest) taxiRef.current();
  }, [attentionRequest]);

  // ------------------------------------------------------------------ selection per building
  const selectedWs = useMemo(() => {
    if (!selection) return '';
    if (selection.kind === 'workspace') return selection.id;
    if (selection.kind === 'history') return selection.workspaceId;
    if (selection.kind === 'session') return data.wsOfSession.get(selection.id) ?? '';
    return data.agentWs.get(selection.id) ?? '';
  }, [selection, data]);

  const isEmpty = layout.buildings.length === 0;
  /** Layers are laid out in world pixels; the camera is a CSS transform (see usePanZoom). */
  const W = Math.ceil(grid.width);
  const H = Math.ceil(grid.height);

  // ------------------------------------------------------------------ effects layer + minimap
  const sparkleWs = useMemo(() => {
    const out = new Set<string>();
    for (const agentId of sparkles) {
      const wsId = data.agentWs.get(agentId) ?? data.wsOfSession.get(agentId.slice(0, Math.max(0, agentId.lastIndexOf(':'))));
      if (wsId) out.add(wsId);
    }
    return out;
  }, [sparkles, data]);

  const fxAll = useMemo(() => {
    const p = makeProjector(grid.ox, grid.oy);
    const out: FxItem[] = [];
    for (const b of layout.buildings) {
      const f = facades.get(b.workspaceId);
      if (!f) continue;
      const item: FxItem = {
        id: b.workspaceId,
        ...buildingAnchors(p, b, f),
        door: b.door,
        street: b.street,
        waiting: f.waiting > 0,
        smoke: f.working > 0,
        sparkle: sparkleWs.has(b.workspaceId),
        selected: selectedWs === b.workspaceId,
        walkers: (data.walkers.get(b.workspaceId) ?? NO_AGENTS).map((a) => ({ id: a.agentId, leaving: !!a.leaving, spawnedAt: a.spawnedAt })),
      };
      if (fxActive(item)) out.push(item);
    }
    return out;
  }, [layout, facades, grid, sparkleWs, selectedWs, data]);

  fxCandidates.current = useMemo(() => {
    const byId = new Map(layout.buildings.map((b) => [b.workspaceId, b]));
    return fxAll.map((i) => ({ id: i.id, ...rectOf(byId.get(i.id) as BuildingPlacement) }));
  }, [fxAll, layout, rectOf]);
  // new candidates: cull again with the current camera
  useEffect(() => {
    if (pz.ref.current) onFrame(pz.tRef.current);
  }, [fxAll, onFrame, pz.ref, pz.tRef]);

  const fountains = useMemo(() => {
    const p = makeProjector(grid.ox, grid.oy);
    return grid.decorations.filter((d) => d.kind === 'fountain').map((d) => p(d.gx, d.gy));
  }, [grid]);

  const miniBuildings = useMemo<MiniBuilding[]>(
    () =>
      layout.buildings.map((b) => {
        const f = facades.get(b.workspaceId);
        return { id: b.workspaceId, center: b.center, tone: f ? miniTone(f) : 'quiet', selected: selectedWs === b.workspaceId };
      }),
    [layout, facades, selectedWs],
  );
  const onNavigate = useCallback((wx: number, wy: number, animate: boolean) => centerOn(wx, wy, { animate }), [centerOn]);

  // slow clock for blinking lights in the static layers (see city.css): a class swap, no per-frame work
  useEffect(() => {
    if (!active || reduced || isEmpty) return undefined;
    let n = 0;
    const tick = () => {
      const root = rootRef.current;
      if (!root || document.hidden) return;
      root.classList.remove(`tick-${n % 4}`, `tlp-${Math.floor(n / 2) % 6}`);
      n++;
      root.classList.add(`tick-${n % 4}`, `tlp-${Math.floor(n / 2) % 6}`);
    };
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      rootRef.current?.classList.remove(`tick-${n % 4}`, `tlp-${Math.floor(n / 2) % 6}`);
    };
  }, [active, reduced, isEmpty]);

  // back from a building: short zoom-out + fade (instant with reduced motion)
  const wasActive = useRef(active);
  useEffect(() => {
    const el = pz.ref.current;
    if (active && !wasActive.current && el && typeof el.animate === 'function' && !prefersReducedMotion()) {
      el.animate(
        [
          { opacity: 0, transform: 'scale(1.05)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: 280, easing: 'ease-out' },
      );
    }
    wasActive.current = active;
  }, [active, pz.ref]);


  return (
    <div
      className={`city-map${active ? '' : ' is-hidden'}`}
      ref={setRoot}
      tabIndex={0}
      role="region"
      aria-label="City map. Arrow keys pan, plus and minus zoom, 0 fits the whole city, N goes to the next building that needs attention. Tab to a building; arrow keys then move between buildings, Enter opens a building, Space shows its details."
      onKeyDown={(e) => {
        // N: next building that needs attention (same as the taxi), from anywhere on the map
        if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          onTaxi();
          return;
        }
        handlers.onKeyDown(e);
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onClickCapture={handlers.onClickCapture}
      onClick={() => onSelect(undefined)}
    >
      <Sky effects={effects} />
      {isEmpty ? (
        empty
      ) : (
        <>
          <svg className={`city-svg city-layer city-layer--ground ${PZ_LAYER}`} width={W} height={H} aria-hidden="true">
            <g className="city-viewport">
              <CityGround grid={grid} />
            </g>
          </svg>
          <svg className={`city-svg city-layer city-layer--cars ${PZ_LAYER}`} width={W} height={H}>
            <g className="city-viewport">
              <ToyCars cars={grid.cars} running={active} onTaxi={onTaxi} />
            </g>
          </svg>
          <svg
            className={`city-svg city-layer city-layer--buildings ${PZ_LAYER}`}
            width={W}
            height={H}
            role="group"
            aria-label={`City with ${layout.buildings.length} companies`}
          >
            <g className="city-viewport">
              <RoadProps grid={grid} />
              {plots.order.map((cell) => {
                const b = buildingByCell.get(cell.index);
                const ws = b ? workspacesById.get(b.workspaceId) : undefined;
                return (
                  <Fragment key={cell.index}>
                    <PlotDecos items={plots.back.get(cell.index) ?? NO_DECOS} ox={grid.ox} oy={grid.oy} />
                    {b && ws && (
                      <IsoBuilding
                        b={b}
                        ox={grid.ox}
                        oy={grid.oy}
                        workspace={ws}
                        sessions={data.perWs.get(ws.id) ?? NO_SESSIONS}
                        sig={buildingSignature(ws, data.perWs.get(ws.id) ?? NO_SESSIONS)}
                        selected={selectedWs === ws.id}
                        onSelect={onSelect}
                        onOpen={onOpen}
                        onArrow={onArrow}
                      />
                    )}
                    <PlotDecos items={plots.front.get(cell.index) ?? NO_DECOS} ox={grid.ox} oy={grid.oy} />
                  </Fragment>
                );
              })}
              <g className="plates">
                {layout.buildings.map((b) => {
                  const ws = workspacesById.get(b.workspaceId);
                  return ws ? <BuildingPlate key={b.workspaceId} b={b} ox={grid.ox} oy={grid.oy} name={ws.name} /> : null;
                })}
              </g>
            </g>
          </svg>
          <svg className={`city-svg city-layer city-layer--fx ${PZ_LAYER}`} width={W} height={H} aria-hidden="true">
            <g className="city-viewport">
              <CityFxLayer ref={fxRef} all={fxAll} fountains={fountains} effects={effects} />
            </g>
          </svg>
          {effects && <Birds />}
        </>
      )}
      {!isEmpty && layout.buildings.length >= MINIMAP_MIN_BUILDINGS && (
        <MiniMap ref={frameRef} grid={grid} buildings={miniBuildings} onNavigate={onNavigate} />
      )}
      {!isEmpty && (
        <div className="zoom-controls" role="toolbar" aria-label="Zoom" onClick={(e) => e.stopPropagation()}>
          <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomCenter(ZOOM_STEP)}>
            +
          </button>
          <button className="icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomCenter(1 / ZOOM_STEP)}>
            −
          </button>
          <button className="icon-button" aria-label="Fit whole city" title="Fit whole city (0)" onClick={() => fitAll({ animate: true })}>
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}

export const CityMap = memo(CityMapImpl);
