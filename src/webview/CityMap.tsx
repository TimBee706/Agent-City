import { Fragment, ReactNode, memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { Agent } from '../models/Agent';
import type { Session } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';
import { WALK_IN_WINDOW_MS } from './AgentCharacter';
import { CityDefs, CityGround, PlotDecos, RoadProps } from './CityGround';
import { BuildingPlacement, CityCell, Decoration, buildingRect, computeCityGrid, computeCityLayout } from './cityLayout';
import { FACADE, computeFacade } from './facade';
import { BuildingPlate, IsoBuilding, buildingSignature } from './IsoBuilding';
import { prefersReducedMotion } from './motion';
import { ArrowDir, nextNeedingAttention, spatialNext } from './navigation';
import { Select, Selection } from './selection';
import { ToyCars } from './ToyCars';
import { usePanZoom } from './usePanZoom';
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
  /** False while the building level is shown (map hidden, cars paused). */
  active: boolean;
  empty: ReactNode;
}

/** A fit request also re-fits on layout changes within this window (the new state may arrive later). */
const FIT_PENDING_MS = 3000;
/** Level of detail: below these zoom levels small decorations / labels are hidden. */
export const LOD_FAR = 0.5;
export const LOD_TINY = 0.28;

const NO_AGENTS: readonly Agent[] = [];
const NO_SESSIONS: readonly Session[] = [];
const NO_DECOS: readonly Decoration[] = [];

/** CSS classes for a zoom level (level of detail). */
export function lodClasses(k: number): { far: boolean; tiny: boolean } {
  return { far: k < LOD_FAR, tiny: k < LOD_TINY };
}

function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}

/**
 * Level 1: the city as an isometric play rug - streets, parks, trees, toy cars and one toy house
 * per workspace. Zoom / pan is ref-based (no React re-render), the ground is memoised per grid.
 */
function CityMapImpl(props: Props) {
  const { workspaces, sessions, agents, selection, onSelect, onOpen, initialTransform, onTransformChange, focusRequest, fitRequest, active, empty } =
    props;

  const grid = useMemo(() => computeCityGrid(workspaces.length), [workspaces.length]);
  const layout = useMemo(() => computeCityLayout({ workspaces, sessions }, grid), [workspaces, sessions, grid]);

  const svgRef = useRef<SVGSVGElement>(null);
  const onFrame = useCallback((t: ViewTransform) => {
    const svg = svgRef.current;
    if (!svg) return;
    const lod = lodClasses(t.k);
    svg.classList.toggle('lod-far', lod.far);
    svg.classList.toggle('lod-tiny', lod.tiny);
  }, []);
  const pz = usePanZoom({
    // no buildings yet (e.g. the first, empty state): no content, so the first real city is fitted
    content: workspaces.length ? { width: grid.width, height: grid.height } : { width: 0, height: 0 },
    initial: initialTransform,
    onChange: onTransformChange,
    onFrame,
  });
  const { fitAll, zoomToRect, zoomCenter, ensureVisible, handlers } = pz;

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

  const rectOf = useCallback(
    (b: BuildingPlacement) => {
      const ss = data.perWs.get(b.workspaceId) ?? NO_SESSIONS;
      const ws = workspacesById.get(b.workspaceId);
      const h = ws ? computeFacade(ss, ws).heightPx + 30 : FACADE.BASE_H + FACADE.FLOOR_H;
      const r = buildingRect(grid, b, h);
      return { x: r.x - 10, y: r.y, width: r.width + 20, height: r.height + 24 };
    },
    [data, workspacesById, grid],
  );

  // ------------------------------------------------------------------ fit / focus requests
  const fitPendingUntil = useRef(0);
  useEffect(() => {
    if (!fitRequest) return;
    fitPendingUntil.current = Date.now() + FIT_PENDING_MS;
    if (layout.buildings.length > 0) fitAll();
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
      const ss = data.perWs.get(b.workspaceId) ?? NO_SESSIONS;
      const ws = workspacesById.get(b.workspaceId);
      if (!ws) continue;
      const f = computeFacade(ss, ws);
      urgency.set(b.workspaceId, f.waiting ? 3 : f.failed ? 2 : f.working ? 1 : 0);
    }
    const target = nextNeedingAttention(
      layout.buildings.map((b) => b.workspaceId),
      urgency,
      lastTaxi.current,
    );
    if (!target) return;
    lastTaxi.current = target;
    zoomToWorkspace(target);
    focusBuilding(target);
    onSelect({ kind: 'workspace', id: target }, { keepFocus: true });
  };
  const taxiRef = useRef(taxiImpl);
  taxiRef.current = taxiImpl;
  const onTaxi = useCallback(() => taxiRef.current(), []);

  // ------------------------------------------------------------------ selection per building
  const selectedWs = useMemo(() => {
    if (!selection) return '';
    if (selection.kind === 'workspace') return selection.id;
    if (selection.kind === 'history') return selection.workspaceId;
    if (selection.kind === 'session') return data.wsOfSession.get(selection.id) ?? '';
    return data.agentWs.get(selection.id) ?? '';
  }, [selection, data]);

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

  const isEmpty = layout.buildings.length === 0;

  return (
    <div
      className={`city-map${active ? '' : ' is-hidden'}`}
      ref={pz.ref}
      tabIndex={0}
      role="region"
      aria-label="City map. Arrow keys pan, plus and minus zoom, 0 fits the whole city. Tab to a building; arrow keys then move between buildings, Enter opens a building, Space shows its details."
      onKeyDown={handlers.onKeyDown}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onClickCapture={handlers.onClickCapture}
      onClick={() => onSelect(undefined)}
    >
      {isEmpty ? (
        empty
      ) : (
        <svg
          ref={svgRef}
          className="city-svg"
          width="100%"
          height="100%"
          role="group"
          aria-label={`City with ${layout.buildings.length} companies`}
        >
          <CityDefs />
          <g ref={pz.gRef} className="city-viewport">
            <CityGround grid={grid} />
            <ToyCars cars={grid.cars} running={active} onTaxi={onTaxi} />
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
                      walkers={data.walkers.get(ws.id) ?? NO_AGENTS}
                      sig={buildingSignature(ws, data.perWs.get(ws.id) ?? NO_SESSIONS, data.walkers.get(ws.id) ?? NO_AGENTS)}
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
      )}
      {!isEmpty && (
        <div className="zoom-controls" role="toolbar" aria-label="Zoom" onClick={(e) => e.stopPropagation()}>
          <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomCenter(ZOOM_STEP)}>
            +
          </button>
          <button className="icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomCenter(1 / ZOOM_STEP)}>
            −
          </button>
          <button className="icon-button" aria-label="Fit whole city" title="Fit whole city (0)" onClick={fitAll}>
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}

export const CityMap = memo(CityMapImpl);
