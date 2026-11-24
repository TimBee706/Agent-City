import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../models/Agent';
import type { HistorySummary } from '../models/CityState';
import type { Session } from '../models/Session';
import { sessionLabel, sessionPhase } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';
import { AgentCharacter } from './AgentCharacter';
import { BI, InteriorBox, InteriorRoom, interiorFor } from './buildingInterior';
import type { FocusRequest } from './CityMap';
import { paletteFor } from './facade';
import { PHASE_GLYPH, PHASE_LABEL, truncate } from './format';
import { prefersReducedMotion, useIsoLayoutEffect, useReducedMotion } from './motion';
import { Select, Selection, activatable } from './selection';
import { Deco } from './sprites';
import { usePanZoom } from './usePanZoom';
import { ViewTransform, ZOOM_STEP } from './zoom';

interface Props {
  workspace: CityWorkspace;
  /** Sessions of this workspace after filters (live, recent and archived rooms). */
  sessions: readonly Session[];
  agents: readonly Agent[];
  /** History index items of this workspace (archived + recent overflow), if any. */
  history: readonly HistorySummary[] | undefined;
  selection: Selection;
  onSelect: Select;
  onBack: () => void;
  sparkles: ReadonlySet<string>;
  initialTransform: ViewTransform | undefined;
  onTransformChange: (t: ViewTransform) => void;
  focusRequest: FocusRequest | undefined;
}

const NO_AGENTS: readonly Agent[] = [];
const ENTER_MS = 320;

interface RoomProps {
  room: InteriorRoom;
  session: Session;
  agents: readonly Agent[];
  selectedId: string;
  sparkleKey: string;
  onSelect: Select;
}

/** One office room (live session with its agents) or a resting room (recent session). */
function RoomViewImpl({ room, session, agents, selectedId, sparkleKey, onSelect }: RoomProps) {
  const phase = sessionPhase(session);
  const name = sessionLabel(session);
  const selected = selectedId === session.id;
  const resting = phase === 'resting';
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const sparkles = sparkleKey ? new Set(sparkleKey.split('|')) : undefined;
  const label = resting
    ? `Recent session ${name}, not running${session.gitBranch ? `, branch ${session.gitBranch}` : ''}. Open Session resumes it`
    : `Live session ${name}, ${PHASE_LABEL[phase]}${session.waitingFor ? `, waiting for ${session.waitingFor}` : ''}${
        session.attention ? `, needs your attention: ${session.attention}` : ''
      }${agents.length > 1 ? `, ${agents.length} agents` : ''}`;
  const cx = room.x + room.width / 2;
  const floorY = room.y + room.height - 10;
  const lampX = Math.round(room.x + room.width * 0.4);
  return (
    <g
      className={`iroom iroom--${phase}${selected ? ' is-selected' : ''}${session.attention ? ' iroom--attention' : ''}`}
      data-session-id={session.id}
      {...activatable(() => onSelect({ kind: 'session', id: session.id }), label)}
    >
      <title>{label}</title>
      <rect className="iroom-bg" x={room.x} y={room.y} width={room.width} height={room.height} />
      <rect className="iroom-light" x={room.x} y={room.y} width={room.width} height={room.height} />
      <rect className="iroom-shade" x={room.x} y={room.y} width={room.width} height={room.height} />
      <g className="iroom-lamp" aria-hidden="true">
        <polygon className="lamp-cone" points={`${lampX - 7},${room.y + 15} ${lampX + 7},${room.y + 15} ${lampX + 46},${floorY} ${lampX - 46},${floorY}`} />
        <line x1={lampX} y1={room.y} x2={lampX} y2={room.y + 9} />
        <path className="lamp-shade" d={`M${lampX - 8} ${room.y + 15} L${lampX - 4} ${room.y + 8} H${lampX + 4} L${lampX + 8} ${room.y + 15} Z`} />
      </g>
      <rect className="iroom-floor" x={room.x} y={floorY} width={room.width} height={10} />
      <line className="iroom-skirting" x1={room.x} y1={floorY} x2={room.x + room.width} y2={floorY} />
      <g className="iroom-window" aria-hidden="true">
        <rect x={room.x + room.width - 54} y={room.y + 26} width={40} height={30} rx={2} />
        <line x1={room.x + room.width - 34} y1={room.y + 26} x2={room.x + room.width - 34} y2={room.y + 56} />
        <line x1={room.x + room.width - 54} y1={room.y + 41} x2={room.x + room.width - 14} y2={room.y + 41} />
        <rect className="iroom-sill" x={room.x + room.width - 57} y={room.y + 56} width={46} height={3} rx={1} />
      </g>
      <g className="iroom-plant" aria-hidden="true">
        <path className="plant-leaves" d={`M${room.x + room.width - 16} ${floorY - 9} q-9 -5 -7 -15 q5 4 7 15 q1 -12 8 -16 q3 9 -8 16 z`} />
        <rect className="plant-pot" x={room.x + room.width - 21} y={floorY - 9} width={10} height={9} rx={2} />
      </g>
      <rect className="focus-ring" x={room.x - 3} y={room.y - 3} width={room.width + 6} height={room.height + 6} rx={4} />
      <text className="iroom-label" x={room.x + 8} y={room.y + 16}>
        {truncate(name, 24)}
      </text>
      <g className={`tier-pill tier-pill--${resting ? 'recent' : 'live'}`} aria-hidden="true">
        <rect x={room.x + 8} y={room.y + 22} width={resting ? 44 : 30} height={12} rx={6} />
        <text x={room.x + 8 + (resting ? 22 : 15)} y={room.y + 31} textAnchor="middle">
          {resting ? 'RECENT' : 'LIVE'}
        </text>
      </g>
      <g className="room-glyph" transform={`translate(${room.x + room.width - 13} ${room.y + 12})`} aria-hidden="true">
        <circle r={7.5} />
        <text textAnchor="middle" dominantBaseline="central">
          {PHASE_GLYPH[phase]}
        </text>
      </g>
      {phase === 'failed' && (
        <g className="warn-sign" transform={`translate(${room.x + room.width - 76} ${room.y + 42})`} aria-hidden="true">
          <polygon points="0,-9 9,7 -9,7" />
          <text y={5} textAnchor="middle">
            !
          </text>
        </g>
      )}
      {resting && (
        <g className="resting-char" aria-hidden="true">
          <rect className="resting-desk" x={cx - 24} y={floorY - 16} width={48} height={3} rx={1} />
          <rect className="resting-desk" x={cx - 22} y={floorY - 13} width={2} height={13} />
          <rect className="resting-desk" x={cx + 20} y={floorY - 13} width={2} height={13} />
          <rect className="resting-monitor" x={cx + 6} y={floorY - 30} width={16} height={12} rx={1.5} />
          <rect className="resting-body" x={cx - 9} y={floorY - 14} width={15} height={14} rx={4} />
          <circle className="resting-head" cx={cx + 2} cy={floorY - 20} r={5.5} />
          <text className="resting-z" x={cx + 10} y={floorY - 28}>
            z
          </text>
          <text className="resting-z resting-z--big" x={cx + 17} y={floorY - 36}>
            Z
          </text>
        </g>
      )}
      {!resting && room.desks.length === 0 && (
        <g className="empty-desk" aria-hidden="true">
          <rect x={cx - 20} y={floorY - 16} width={40} height={3} rx={1} />
          <rect x={cx + 2} y={floorY - 30} width={16} height={12} rx={1.5} />
        </g>
      )}
      {room.desks.map((d) => {
        const agent = byId.get(d.agentId);
        if (!agent) return null;
        return (
          <AgentCharacter
            key={d.agentId}
            agent={agent}
            x={d.x}
            y={d.y}
            entranceDx={room.entrance.x - d.x}
            entranceDy={room.entrance.y - d.y}
            selected={selectedId === d.agentId}
            sparkle={!!sparkles?.has(d.agentId)}
            onSelect={onSelect}
          />
        );
      })}
      {room.overflow > 0 && (
        <text className="room-overflow" x={room.x + room.width - 8} y={room.y + room.height - 14} textAnchor="end">
          +{room.overflow}
        </text>
      )}
    </g>
  );
}

const RoomView = memo(RoomViewImpl);

function ArchiveBoxImpl({
  box,
  workspaceId,
  selected,
  onSelect,
  onHover,
}: {
  box: InteriorBox;
  workspaceId: string;
  selected: boolean;
  onSelect: Select;
  onHover: (id: string | undefined) => void;
}) {
  const label = `Archived session ${box.title}. Open Session resumes it`;
  const sel: Selection = box.roomId ? { kind: 'session', id: box.roomId } : { kind: 'history', id: box.id, workspaceId };
  return (
    <g
      className={`abox${selected ? ' is-selected' : ''}`}
      data-archive-id={box.id}
      {...activatable(() => onSelect(sel), label)}
      onMouseEnter={() => onHover(box.id)}
      onMouseLeave={() => onHover(undefined)}
      onFocus={() => onHover(box.id)}
      onBlur={() => onHover(undefined)}
    >
      <title>{box.title}</title>
      <rect className="abox-body" x={box.x} y={box.y + 4} width={box.width} height={box.height - 4} rx={1.5} />
      <rect className="abox-lid" x={box.x - 1.5} y={box.y} width={box.width + 3} height={5} rx={1.5} />
      <rect className="abox-tag" x={box.x + box.width / 2 - 6} y={box.y + 9} width={12} height={6} rx={1} />
      <rect className="focus-ring" x={box.x - 4} y={box.y - 4} width={box.width + 8} height={box.height + 8} rx={3} />
    </g>
  );
}

const ArchiveBox = memo(ArchiveBoxImpl);

/**
 * Level 2: cut-away side view of one building. Rooms (live sessions first, then recent ones) on
 * the floors, an elevator subagents walk out of, and the BASEMENT with one archive box per archived
 * session. Escape / Backspace / the Back button return to the city.
 */
function BuildingViewImpl(props: Props) {
  const { workspace, sessions, agents, history, selection, onSelect, onBack, sparkles, initialTransform, onTransformChange, focusRequest } =
    props;
  // rooms in facade order (live by urgency, then recent newest first) + the basement archive
  const { layout, facade } = useMemo(() => interiorFor(workspace, sessions, agents, history), [workspace, sessions, agents, history]);
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const agentsBySession = useMemo(() => {
    const m = new Map<string, Agent[]>();
    for (const a of agents) {
      const list = m.get(a.parentSessionId) ?? [];
      list.push(a);
      m.set(a.parentSessionId, list);
    }
    return m;
  }, [agents]);

  const pz = usePanZoom({
    content: { width: layout.width, height: layout.height },
    initial: initialTransform,
    onChange: onTransformChange,
    fitMaxK: 2,
  });
  const { fitAll, zoomCenter, zoomToRect, handlers } = pz;

  // enter transition (zoom + fade), instant with reduced motion; focus the view for keyboard users
  useIsoLayoutEffect(() => {
    const el = pz.ref.current;
    if (!el) return undefined;
    el.focus({ preventScroll: true });
    if (prefersReducedMotion() || typeof el.animate !== 'function') return undefined;
    const a = el.animate(
      [
        { opacity: 0, transform: 'scale(0.94)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: ENTER_MS, easing: 'ease-out' },
    );
    return () => a.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focusRequest || focusRequest.kind !== 'session') return;
    const r = layout.rooms.find((x) => x.sessionId === focusRequest.id);
    const box = layout.basement.boxes.find((x) => x.roomId === focusRequest.id);
    const target = r ?? box;
    if (target) zoomToRect(target, 1.6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  // the elevator cabin travels between the lobby and the top floor (compositor-only; none with reduced motion)
  const cabinRef = useRef<SVGGElement>(null);
  const reducedMotion = useReducedMotion();
  const travel = layout.rooms.length ? Math.round(layout.lobby.y - Math.min(...layout.rooms.map((r) => r.y))) : 0;
  useEffect(() => {
    const el = cabinRef.current;
    if (!el || !travel || reducedMotion || typeof el.animate !== 'function') return undefined;
    const up = `translateY(${-travel}px)`;
    const a = el.animate(
      [
        { transform: 'translateY(0px)', offset: 0, easing: 'ease-in-out' },
        { transform: 'translateY(0px)', offset: 0.3, easing: 'ease-in-out' },
        { transform: up, offset: 0.5, easing: 'ease-in-out' },
        { transform: up, offset: 0.8, easing: 'ease-in-out' },
        { transform: 'translateY(0px)', offset: 1 },
      ],
      { duration: 9000 + travel * 30, iterations: Infinity },
    );
    return () => a.cancel();
  }, [travel, reducedMotion]);

  const [hoverBox, setHoverBox] = useState<string | undefined>();
  const hovered = hoverBox ? layout.basement.boxes.find((b) => b.id === hoverBox) : undefined;

  const selectedId =
    selection?.kind === 'session' || selection?.kind === 'agent' ? selection.id : selection?.kind === 'history' ? selection.id : '';
  const sparkleFor = (sessionId: string): string => {
    if (!sparkles.size) return '';
    return (agentsBySession.get(sessionId) ?? [])
      .filter((a) => sparkles.has(a.agentId))
      .map((a) => a.agentId)
      .join('|');
  };
  const selectedFor = (sessionId: string): string => {
    if (!selectedId) return '';
    if (selectedId === sessionId) return selectedId;
    return (agentsBySession.get(sessionId) ?? []).some((a) => a.agentId === selectedId) ? selectedId : '';
  };

  const f = facade;
  const { building: B, roof, lobby, door, elevator: E, basement: K } = layout;
  const pal = paletteFor(workspace.id);
  const roofPts = `${roof.x},${roof.y + roof.height} ${roof.x + roof.width},${roof.y + roof.height} ${roof.x + roof.width - 40},${roof.y + 8} ${roof.x + 40},${roof.y + 8}`;
  const counts = `${f.live} live · ${f.recent} recent · ${f.archived} archived`;
  const treeL = { id: 't-l', kind: 'tree-round' as const, gx: 0, gy: 0, r: 0, variant: 1, small: false, layer: 'front' as const, cell: -1 };
  const treeR = { ...treeL, id: 't-r', kind: 'tree-cone' as const, variant: 0 };
  const lamp = { ...treeL, id: 'lamp', kind: 'lamp' as const, variant: 0 };

  return (
    <div
      className="building-view"
      ref={pz.ref}
      tabIndex={0}
      role="region"
      aria-label={`Building ${workspace.name}: ${counts}. Tab through rooms and archive boxes. Escape or Backspace returns to the city.`}
      onKeyDown={handlers.onKeyDown}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onClickCapture={handlers.onClickCapture}
      onClick={() => onSelect(undefined)}
    >
      <nav className="breadcrumb glass" aria-label="Breadcrumb" onClick={(e) => e.stopPropagation()}>
        <button className="link-button" onClick={onBack} title="Back to the city (Escape)">
          City
        </button>
        <span className="breadcrumb-sep" aria-hidden="true">
          ›
        </span>
        <span className="breadcrumb-current" aria-current="page">
          {workspace.name}
        </span>
        <span className="muted small breadcrumb-counts">{counts}</span>
        <button className="secondary-button breadcrumb-back" onClick={onBack}>
          ← Back to city
        </button>
      </nav>
      <svg className={`building-svg pal-${pal}`} width="100%" height="100%" role="group" aria-label={`Inside ${workspace.name}`}>
        <g ref={pz.gRef} className="building-viewport">
          <rect className="bv-sky" x={0} y={0} width={layout.width} height={layout.groundY} />
          <g className="bv-scenery" aria-hidden="true">
            <circle className="bv-orb" cx={layout.width - 70} cy={46} r={20} />
            <path className="bv-cloud" d="M40 60 a14 14 0 0 1 26 -6 a18 18 0 0 1 34 4 a11 11 0 0 1 6 21 h-64 a11 11 0 0 1 -2 -19 z" />
            <path className="bv-cloud bv-cloud--b" d={`M${layout.width - 230} 96 a11 11 0 0 1 20 -5 a14 14 0 0 1 27 3 a9 9 0 0 1 5 17 h-51 a9 9 0 0 1 -1 -15 z`} />
          </g>
          <rect className="bv-earth" x={0} y={layout.groundY} width={layout.width} height={layout.height - layout.groundY} />
          <rect className="bv-grass" x={0} y={layout.groundY - 2} width={layout.width} height={8} rx={2} />
          <path className="bv-pebbles" d={`M${B.x - 60} ${layout.groundY + 40} h14 M${B.x - 30} ${layout.groundY + 90} h20 M${B.x + B.width + 26} ${layout.groundY + 60} h16 M${B.x + B.width + 50} ${layout.groundY + 120} h12`} />
          <g aria-hidden="true">
            <Deco d={treeL} at={{ x: BI.SIDE / 2 - 8, y: layout.groundY }} />
            <Deco d={lamp} at={{ x: BI.SIDE - 18, y: layout.groundY }} />
            <Deco d={treeR} at={{ x: layout.width - BI.SIDE / 2 + 6, y: layout.groundY }} />
          </g>
          {/* basement */}
          <g className="basement">
            <rect className="basement-bg" x={K.x} y={K.y} width={K.width} height={K.height} />
            <rect className="basement-shade" x={K.x} y={K.y} width={K.width} height={K.height} />
            <g className="basement-bulb" aria-hidden="true">
              <line x1={K.x + K.width - 60} y1={K.y} x2={K.x + K.width - 60} y2={K.y + 14} />
              <circle className="bulb-glow" cx={K.x + K.width - 60} cy={K.y + 18} r={34} />
              <circle className="bulb" cx={K.x + K.width - 60} cy={K.y + 18} r={4} />
            </g>
            <text className="basement-title" x={K.x + BI.WALL + BI.ELEV_W + BI.GAP + 6} y={K.y + 20}>
              Basement · {K.total} archived session{K.total === 1 ? '' : 's'}
            </text>
            {K.shelves.map((s, i) => (
              <g key={i} className="shelf" aria-hidden="true">
                <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={1} />
                <rect className="shelf-leg" x={s.x + 2} y={s.y + s.height} width={3} height={4} />
                <rect className="shelf-leg" x={s.x + s.width - 5} y={s.y + s.height} width={3} height={4} />
              </g>
            ))}
            {K.boxes.map((b) => (
              <ArchiveBox
                key={b.id}
                box={b}
                workspaceId={workspace.id}
                selected={selectedId !== '' && (selectedId === b.id || selectedId === b.roomId)}
                onSelect={onSelect}
                onHover={setHoverBox}
              />
            ))}
            {K.boxes.length === 0 && (
              <text className="basement-empty" x={K.x + K.width / 2} y={K.y + BI.BASE_HEAD + 18} textAnchor="middle">
                The basement is empty - no archived sessions.
              </text>
            )}
            {K.overflow > 0 && (
              <g
                className="basement-more"
                {...activatable(
                  () => onSelect({ kind: 'workspace', id: workspace.id }),
                  `${K.overflow} more archived sessions. Show the full list in the details panel`,
                )}
              >
                <rect x={K.x + K.width - 92} y={K.y + 6} width={78} height={18} rx={9} />
                <text x={K.x + K.width - 53} y={K.y + 19} textAnchor="middle">
                  +{K.overflow} more
                </text>
                <rect className="focus-ring" x={K.x + K.width - 95} y={K.y + 3} width={84} height={24} rx={11} />
              </g>
            )}
          </g>
          {/* building shell */}
          <rect className="bv-chimney" x={roof.x + roof.width - 110} y={roof.y - 6} width={22} height={34} rx={2} />
          <polygon className="bv-roof" points={roofPts} />
          <path
            className="bv-shingles"
            d={[0.3, 0.55, 0.8]
              .map((t) => {
                const y = roof.y + 8 + (roof.height - 8) * t;
                const inset = 40 * (1 - t);
                return `M${Math.round(roof.x + inset)} ${Math.round(y)}H${Math.round(roof.x + roof.width - inset)}`;
              })
              .join('')}
          />
          <rect className="bv-eaves" x={B.x - 4} y={B.y} width={B.width + 8} height={5} />
          <text className="bv-roof-name" x={roof.x + roof.width / 2} y={roof.y + roof.height / 2 + 9} textAnchor="middle">
            {truncate(workspace.name, 32)}
          </text>
          <rect className="bv-frame" x={B.x} y={B.y} width={B.width} height={B.height} />
          <rect className="bv-inside" x={B.x + BI.WALL} y={B.y + BI.SLAB} width={B.width - 2 * BI.WALL} height={B.height - BI.SLAB} />
          {layout.slabs.map((y, i) => (
            <rect key={i} className="bv-slab" x={B.x} y={y} width={B.width} height={BI.SLAB} />
          ))}
          {/* elevator */}
          <g className="elevator" aria-hidden="true">
            <rect className="elevator-shaft" x={E.x} y={E.y} width={E.width} height={E.height} />
            <line className="elevator-cable" x1={E.x + E.width / 2} y1={E.y} x2={E.x + E.width / 2} y2={lobby.y + 14} />
            <g ref={cabinRef} className="elevator-car">
              <rect className="elevator-cabin" x={E.x + 5} y={lobby.y + 14} width={E.width - 10} height={lobby.height - 22} rx={3} />
              <rect className="elevator-window" x={E.x + 11} y={lobby.y + 22} width={E.width - 22} height={18} rx={2} />
              <line className="elevator-split" x1={E.x + E.width / 2} y1={lobby.y + 44} x2={E.x + E.width / 2} y2={lobby.y + lobby.height - 8} />
            </g>
            {layout.rooms
              .filter((r) => r.col === 0)
              .map((r) => (
                <rect key={r.floor} className="elevator-door" x={E.x + E.width - 4} y={r.y + r.height - 52} width={4} height={42} />
              ))}
          </g>
          {/* lobby */}
          <g className="lobby">
            <rect className="lobby-bg" x={lobby.x} y={lobby.y} width={lobby.width} height={lobby.height} />
            <rect className="iroom-floor" x={lobby.x} y={layout.groundY - 10} width={lobby.width} height={10} />
            <text className="lobby-sign" x={lobby.x + 10} y={lobby.y + 18}>
              Lobby · {truncate(workspace.name, 28)}
            </text>
            <rect className="lobby-rug" x={door.x - 14} y={layout.groundY - 11} width={door.width + 28} height={3} rx={1.5} />
            <rect className="lobby-door" x={door.x} y={door.y} width={door.width} height={door.height - 10} rx={2} />
            <rect className="lobby-door-pane" x={door.x + 6} y={door.y + 6} width={door.width - 12} height={(door.height - 10) * 0.38} rx={2} />
            <circle className="lobby-knob" cx={door.x + door.width - 8} cy={door.y + door.height / 2} r={2} />
            <g className="reception" aria-hidden="true">
              <rect className="sofa-back" x={lobby.x + 30} y={layout.groundY - 44} width={70} height={22} rx={6} />
              <rect x={lobby.x + 26} y={layout.groundY - 30} width={78} height={20} rx={5} />
              <path className="plant-leaves" d={`M${lobby.x + 128} ${layout.groundY - 22} q-14 -8 -10 -22 q8 6 10 22 q2 -18 12 -24 q4 14 -12 24 z`} />
              <circle className="plant-pot" cx={lobby.x + 128} cy={layout.groundY - 16} r={6} />
              <circle className="plant" cx={lobby.x + 128} cy={layout.groundY - 30} r={10} />
            </g>
            {layout.moreDoor && (
              <g
                className="more-door"
                {...activatable(
                  () => onSelect({ kind: 'workspace', id: workspace.id }),
                  `${layout.moreDoor.count} more recent sessions. Show the list in the details panel`,
                )}
              >
                <rect x={layout.moreDoor.x} y={layout.moreDoor.y} width={layout.moreDoor.width} height={layout.moreDoor.height - 10} rx={2} />
                <rect className="more-sign" x={layout.moreDoor.x - 8} y={layout.moreDoor.y - 18} width={layout.moreDoor.width + 16} height={14} rx={3} />
                <text x={layout.moreDoor.x + layout.moreDoor.width / 2} y={layout.moreDoor.y - 8} textAnchor="middle">
                  +{layout.moreDoor.count} recent
                </text>
                <rect
                  className="focus-ring"
                  x={layout.moreDoor.x - 10}
                  y={layout.moreDoor.y - 21}
                  width={layout.moreDoor.width + 20}
                  height={layout.moreDoor.height + 14}
                  rx={4}
                />
              </g>
            )}
          </g>
          {layout.emptyRoom && (
            <g className="iroom iroom--empty">
              <rect className="iroom-bg" x={layout.emptyRoom.x} y={layout.emptyRoom.y} width={layout.emptyRoom.width} height={layout.emptyRoom.height} />
              <text className="iroom-empty" x={layout.emptyRoom.x + layout.emptyRoom.width / 2} y={layout.emptyRoom.y + layout.emptyRoom.height / 2} textAnchor="middle">
                {workspace.missing ? 'Folder not found - nobody works here right now.' : 'No live or recent sessions - the offices are empty.'}
              </text>
            </g>
          )}
          {layout.rooms.map((room) => {
            const s = sessionsById.get(room.sessionId);
            if (!s) return null;
            return (
              <RoomView
                key={room.sessionId}
                room={room}
                session={s}
                agents={agentsBySession.get(s.id) ?? NO_AGENTS}
                selectedId={selectedFor(s.id)}
                sparkleKey={sparkleFor(s.id)}
                onSelect={onSelect}
              />
            );
          })}
          {hovered && (
            <g className="abox-tooltip" aria-hidden="true">
              <rect x={hovered.x - 4} y={hovered.y - 24} width={Math.min(260, hovered.title.length * 6.4 + 14)} height={17} rx={4} />
              <text x={hovered.x + 3} y={hovered.y - 12}>
                {truncate(hovered.title, 40)}
              </text>
            </g>
          )}
        </g>
      </svg>
      <div className="zoom-controls" role="toolbar" aria-label="Zoom" onClick={(e) => e.stopPropagation()}>
        <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomCenter(ZOOM_STEP)}>
          +
        </button>
        <button className="icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomCenter(1 / ZOOM_STEP)}>
          −
        </button>
        <button className="icon-button" aria-label="Fit whole building" title="Fit whole building (0)" onClick={() => fitAll({ animate: true })}>
          ⤢
        </button>
      </div>
    </div>
  );
}

export const BuildingView = memo(BuildingViewImpl);
