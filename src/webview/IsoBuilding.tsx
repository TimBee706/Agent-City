import { KeyboardEvent, memo, useRef } from 'react';
import type { Agent } from '../models/Agent';
import type { Session } from '../models/Session';
import { sessionPhase } from '../models/Session';
import type { CityWorkspace } from '../models/Workspace';
import { WALK_IN_WINDOW_MS } from './AgentCharacter';
import { CITY, type BuildingPlacement } from './cityLayout';
import { FACADE, buildingSummary, computeFacade, paletteFor } from './facade';
import { truncate } from './format';
import { Pt, boxFaces, faceQuad, facePoint, makeProjector, pts } from './iso';
import { prefersReducedMotion, useIsoLayoutEffect } from './motion';
import type { Select } from './selection';
import type { ArrowDir } from './navigation';
import { MiniPerson } from './sprites';

export type { ArrowDir };

const ARROWS: Record<string, ArrowDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

interface Props {
  b: BuildingPlacement;
  ox: number;
  oy: number;
  workspace: CityWorkspace;
  /** Sessions of this workspace (after filters). */
  sessions: readonly Session[];
  /** Subagents that just spawned or are leaving (walk to / from the door). */
  walkers: readonly Agent[];
  selected: boolean;
  /**
   * Content signature of workspace + sessions + walkers (see buildingSignature). The memo compares
   * this instead of the (per state message recreated) objects, so unchanged buildings never re-render.
   */
  sig: string;
  onSelect: Select;
  onOpen: (workspaceId: string) => void;
  onArrow: (workspaceId: string, dir: ArrowDir) => void;
}

/** Signature of everything a city building draws (cheap string compare in the memo). */
export function buildingSignature(ws: CityWorkspace, sessions: readonly Session[], walkers: readonly Agent[]): string {
  let s = `${ws.name}|${ws.open ? 1 : 0}|${ws.missing ? 1 : 0}|${ws.recentOverflow ?? 0}|${ws.archivedOverflow ?? 0}`;
  for (const x of sessions) s += `|${x.id}:${sessionPhase(x)}:${x.name ?? ''}`;
  for (const a of walkers) s += `|w:${a.agentId}:${a.leaving ? 1 : 0}`;
  return s;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const WALK_MS = 1500;

/** Subagent walking from the street to the door (or out again). Web Animations API, CSP-safe. */
function DoorWalker({ from, to, leaving, spawnedAt }: { from: Pt; to: Pt; leaving: boolean; spawnedAt?: number }) {
  const ref = useRef<SVGGElement>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return undefined;
    if (!leaving && (!spawnedAt || Date.now() - spawnedAt > WALK_IN_WINDOW_MS)) return undefined;
    const dx = r1(from.x - to.x);
    const dy = r1(from.y - to.y);
    const street = `translate(${dx}px, ${dy}px)`;
    const door = 'translate(0px, 0px)';
    const frames = leaving
      ? [
          { transform: door, opacity: 0 },
          { transform: door, opacity: 1, offset: 0.1 },
          { transform: street, opacity: 1, offset: 0.9 },
          { transform: street, opacity: 0 },
        ]
      : [
          { transform: street, opacity: 0 },
          { transform: street, opacity: 1, offset: 0.1 },
          { transform: door, opacity: 1, offset: 0.9 },
          { transform: door, opacity: 0 },
        ];
    const anim = el.animate(frames, { duration: WALK_MS, easing: 'ease-in-out', fill: 'forwards' });
    return () => anim.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);
  return (
    <g className="door-walker" transform={`translate(${r1(to.x)} ${r1(to.y)})`} aria-hidden="true">
      <g ref={ref} className="door-walker-inner">
        <MiniPerson />
      </g>
    </g>
  );
}

/**
 * One workspace as an isometric toy house on its plot: basement strip with archive boxes, one lit
 * window per live / recent session, roof, sign plate and status badges. Click = details,
 * double-click / Enter = enter the building, arrows = move to the neighbouring building.
 */
function IsoBuildingImpl({ b, ox, oy, workspace, sessions, walkers, selected, onSelect, onOpen, onArrow }: Props) {
  const p = makeProjector(ox, oy);
  const f = computeFacade(sessions, workspace);
  const { gx, gy, w, d } = b;
  const base = FACADE.BASE_H;
  const wallTop = f.wallTopPx;
  const H = f.heightPx;
  const gable = f.roof === 'gable';
  const missing = workspace.missing === true;
  const summary = buildingSummary(workspace.name, f, { open: workspace.open, missing });
  const label = `${summary}. Enter opens the building, Space shows details, arrow keys move between buildings.`;

  const foundation = boxFaces(p, gx, gy, w, d, base);
  const walls = boxFaces(p, gx, gy, w, d, wallTop, base);
  const parapet = boxFaces(p, gx, gy, w, d, H, wallTop);
  const inset = 0.16;
  const roofInner = boxFaces(p, gx + inset, gy + inset, w - 2 * inset, d - 2 * inset, H - 2, H - 2).top;
  // pitched roof: ridge along gx, slopes towards +gy (front) and -gy (back), gable end on the +gx face
  const ov = 0.12; // eaves overhang (tiles)
  const ridgeY = gy + d / 2;
  const roofBack = [p(gx - ov, gy - ov, wallTop - 3), p(gx + w + ov, gy - ov, wallTop - 3), p(gx + w + ov, ridgeY, H), p(gx - ov, ridgeY, H)];
  const roofFront = [p(gx - ov, gy + d + ov, wallTop - 3), p(gx + w + ov, gy + d + ov, wallTop - 3), p(gx + w + ov, ridgeY, H), p(gx - ov, ridgeY, H)];
  const gableEnd = [p(gx + w, gy + d, wallTop), p(gx + w, gy, wallTop), p(gx + w, ridgeY, H - 2)];
  const chimney = boxFaces(p, gx + w * 0.68, ridgeY - 0.42, 0.24, 0.22, H + 4, wallTop + 6);
  const silhouette = gable
    ? [p(gx, gy + d), p(gx + w, gy + d), p(gx + w, gy), p(gx + w, gy, wallTop), p(gx + w + ov, ridgeY, H), p(gx - ov, ridgeY, H), p(gx - ov, gy + d + ov, wallTop - 3)]
    : [p(gx, gy + d), p(gx + w, gy + d), p(gx + w, gy), p(gx + w, gy, H), p(gx, gy, H), p(gx, gy + d, H)];
  const shadow = [p(gx + 0.1, gy + d + 0.05), p(gx + w + 0.55, gy + d + 0.05), p(gx + w + 0.55, gy - 0.1), p(gx + w + 0.1, gy - 0.25)];

  // floor lines on both faces
  const lines: string[] = [];
  for (let k = 0; k <= f.floors; k++) {
    const z = base + k * FACADE.FLOOR_H;
    for (const face of ['left', 'right'] as const) {
      const a = facePoint(p, face, gx, gy, w, d, 0, z);
      const c = facePoint(p, face, gx, gy, w, d, 1, z);
      lines.push(`M${r1(a.x)} ${r1(a.y)}L${r1(c.x)} ${r1(c.y)}`);
    }
  }

  const SLOT_U: [number, number][] = [
    [0.1, 0.34],
    [0.66, 0.9],
  ];
  const windowQuad = (face: 'left' | 'right', floor: number, slot: number) => {
    const [u0, u1] = SLOT_U[slot];
    const z0 = base + floor * FACADE.FLOOR_H + 4;
    return faceQuad(p, face, gx, gy, w, d, u0, u1, z0, z0 + FACADE.FLOOR_H - 8);
  };
  const shutters = f.quiet
    ? ([
        ['left', 0],
        ['left', 1],
        ['right', 0],
        ['right', 1],
      ] as const)
    : [];

  // archive boxes in the basement strip of the right face
  const dots = Array.from({ length: f.dots }, (_, i) => {
    const u = 0.06 + (i + 0.5) * (0.88 / FACADE.MAX_DOTS);
    return faceQuad(p, 'right', gx, gy, w, d, u - 0.028, u + 0.028, 3, base - 3);
  });
  const moreAt = facePoint(p, 'right', gx, gy, w, d, 1, base / 2);

  const door = faceQuad(p, 'left', gx, gy, w, d, 0.42, 0.58, base, base + 11);
  const steps = [p(gx + w * 0.4, gy + d), p(gx + w * 0.6, gy + d), p(gx + w * 0.6, gy + d + 0.18), p(gx + w * 0.4, gy + d + 0.18)];
  const stepTop = [p(gx + w * 0.4, gy + d, base), p(gx + w * 0.6, gy + d, base), p(gx + w * 0.6, gy + d + 0.18, 0), p(gx + w * 0.4, gy + d + 0.18, 0)];
  const alertAt = facePoint(p, 'left', gx, gy, w, d, 0.5, base + 15.5);
  const roofCentre = p(gx + w / 2, gy + d / 2, H);
  const badgeAt = p(gx + w / 2, gy + d / 2, H + 18);
  const cellGx = gx - CITY.FOOT_OFF;
  const cellGy = gy - CITY.FOOT_OFF;

  const onKeyDown = (e: KeyboardEvent) => {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      e.stopPropagation();
      onArrow(workspace.id, dir);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onOpen(workspace.id);
    } else if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onSelect({ kind: 'workspace', id: workspace.id });
    }
  };

  const cls =
    `iso-building pal-${paletteFor(workspace.id)}` +
    `${f.quiet ? ' bld--quiet' : ''}${missing ? ' bld--missing' : ''}${f.waiting ? ' bld--waiting' : ''}` +
    `${f.working ? ' bld--working' : ''}${workspace.open ? ' bld--open' : ''}${selected ? ' is-selected' : ''}`;

  return (
    <g className={cls} data-workspace-id={workspace.id}>
      <polygon className="bld-shadow" points={pts(shadow)} />
      {missing && (
        <g className="construction" aria-hidden="true">
          <path
            className="fence"
            d={`M${pts([p(cellGx + 0.25, cellGy + 3.75), p(cellGx + 3.75, cellGy + 3.75), p(cellGx + 3.75, cellGy + 0.25)]).replace(/ /g, 'L')}`}
          />
          {[p(cellGx + 0.6, cellGy + 3.5), p(cellGx + 3.5, cellGy + 0.6)].map((c, i) => (
            <g key={i} transform={`translate(${r1(c.x)} ${r1(c.y)})`} className="cone">
              <polygon points="0,-12 5,0 -5,0" />
              <path className="cone-stripe" d="M-2.5 -6 L2.5 -6" />
            </g>
          ))}
        </g>
      )}
      <g
        className="bld-shell"
        tabIndex={0}
        role="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onSelect({ kind: 'workspace', id: workspace.id });
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpen(workspace.id);
        }}
        onKeyDown={onKeyDown}
      >
        <title>{summary}</title>
        <g className="bld-lift">
          <polygon className="bld-base bld-face-l" points={pts(foundation.left)} />
          <polygon className="bld-base bld-face-r" points={pts(foundation.right)} />
          <polygon className="bld-wall bld-face-l" points={pts(walls.left)} />
          <polygon className="bld-wall bld-face-r" points={pts(walls.right)} />
          {missing && (
            <path
              className="scaffold"
              d={[walls.left, walls.right].map((q) => `M${r1(q[0].x)} ${r1(q[0].y)}L${r1(q[2].x)} ${r1(q[2].y)}M${r1(q[1].x)} ${r1(q[1].y)}L${r1(q[3].x)} ${r1(q[3].y)}`).join('')}
            />
          )}
          <path className="bld-floorline" d={lines.join('')} />
          {f.windows.map((win) => (
            <polygon key={win.sessionId} className={`win win--${win.tone}`} points={pts(windowQuad(win.face, win.floor, win.slot))}>
              <title>{win.label}</title>
            </polygon>
          ))}
          {shutters.map(([face, slot]) => (
            <polygon key={`${face}${slot}`} className="win win--shut" points={pts(windowQuad(face, 0, slot))} />
          ))}
          {f.dots > 0 && (
            <g className="arch-dots" aria-hidden="true">
              {dots.map((q, i) => (
                <polygon key={i} className="arch-box" points={pts(q)} />
              ))}
            </g>
          )}
          {f.dotsOverflow > 0 && (
            <text className="arch-more" x={r1(moreAt.x + 4)} y={r1(moreAt.y + 3)}>
              +{f.dotsOverflow}
            </text>
          )}
          <polygon className="bld-step" points={pts(stepTop)} />
          <polygon className="bld-step bld-step--front" points={pts(steps)} />
          <polygon className="bld-door" points={pts(door)} />
          {gable ? (
            <>
              <polygon className="bld-roof-back" points={pts(roofBack)} />
              <polygon className="bld-gable bld-face-r" points={pts(gableEnd)} />
              {f.live > 0 && (
                <g className="chimney" aria-hidden="true">
                  <polygon className="bld-chimney bld-face-l" points={pts(chimney.left)} />
                  <polygon className="bld-chimney bld-face-r" points={pts(chimney.right)} />
                  <polygon className="bld-chimney-top" points={pts(chimney.top)} />
                </g>
              )}
              <polygon className="bld-roof-front" points={pts(roofFront)} />
              <path
                className="bld-roof-tiles"
                d={[0.33, 0.66].map((t) => {
                  const a = p(gx - ov, gy + d + ov - (d / 2 + ov) * t, wallTop - 3 + (H - wallTop + 3) * t);
                  const c = p(gx + w + ov, gy + d + ov - (d / 2 + ov) * t, wallTop - 3 + (H - wallTop + 3) * t);
                  return `M${r1(a.x)} ${r1(a.y)}L${r1(c.x)} ${r1(c.y)}`;
                }).join('')}
              />
            </>
          ) : (
            <>
              <polygon className="bld-parapet bld-face-l" points={pts(parapet.left)} />
              <polygon className="bld-parapet bld-face-r" points={pts(parapet.right)} />
              <polygon className="bld-roof" points={pts(parapet.top)} />
              <polygon className="bld-roof-inner" points={pts(roofInner)} />
            </>
          )}
          {f.live > 0 && !gable && (
            <g className="roof-unit" transform={`translate(${r1(roofCentre.x + 10)} ${r1(roofCentre.y)})`} aria-hidden="true">
              <polygon className="ru-l" points="-6,-3 0,0 0,-7 -6,-10" />
              <polygon className="ru-r" points="0,0 6,-3 6,-10 0,-7" />
              <polygon className="ru-t" points="-6,-10 0,-13 6,-10 0,-7" />
            </g>
          )}
          {workspace.open && (
            <g className="roof-flag" transform={`translate(${r1(roofCentre.x - 12)} ${r1(roofCentre.y - 2)})`} aria-hidden="true">
              <line x1={0} y1={0} x2={0} y2={-22} />
              <polygon points="0,-22 12,-18 0,-14" />
            </g>
          )}
          {f.waiting > 0 && (
            <g className="door-alert" transform={`translate(${r1(alertAt.x)} ${r1(alertAt.y)})`} aria-hidden="true">
              <circle r={5} />
              <text textAnchor="middle" dominantBaseline="central">
                !
              </text>
            </g>
          )}
          <polygon className="focus-ring" points={pts(silhouette)} />
          {(f.live > 0 || f.hiddenWindows > 0) && (
            <g className="bld-badges" transform={`translate(${r1(badgeAt.x)} ${r1(badgeAt.y)})`} aria-hidden="true">
              {f.live > 0 && (
                <g className={`bld-badge bld-badge--live${f.waiting ? ' has-waiting' : ''}`} transform={f.waiting ? 'translate(-11 0)' : undefined}>
                  <circle r={8} />
                  <text textAnchor="middle" dominantBaseline="central">
                    {f.live}
                  </text>
                </g>
              )}
              {f.waiting > 0 && (
                <g className="bld-badge bld-badge--waiting" transform={f.live ? 'translate(11 0)' : undefined}>
                  <circle r={8} />
                  <text textAnchor="middle" dominantBaseline="central">
                    !{f.waiting > 1 ? f.waiting : ''}
                  </text>
                </g>
              )}
              {f.hiddenWindows > 0 && (
                <text className="bld-more" x={f.live > 0 ? (f.waiting ? 24 : 13) : 0} y={3}>
                  +{f.hiddenWindows}
                </text>
              )}
            </g>
          )}
        </g>
      </g>
      {walkers.map((a) => (
        <DoorWalker key={a.agentId} from={b.street} to={b.door} leaving={!!a.leaving} spawnedAt={a.spawnedAt} />
      ))}
    </g>
  );
}

export const IsoBuilding = memo(
  IsoBuildingImpl,
  (a, b) =>
    a.sig === b.sig &&
    a.selected === b.selected &&
    a.b.cell === b.b.cell &&
    a.b.workspaceId === b.b.workspaceId &&
    a.ox === b.ox &&
    a.oy === b.oy &&
    a.onSelect === b.onSelect &&
    a.onOpen === b.onOpen &&
    a.onArrow === b.onArrow,
);

/** Name plate in front of a building (drawn in a label layer above all houses so it is never hidden). */
function BuildingPlateImpl({ b, ox, oy, name }: { b: BuildingPlacement; ox: number; oy: number; name: string }) {
  const p = makeProjector(ox, oy);
  const at = p(b.gx - CITY.FOOT_OFF + CITY.PLOT / 2, b.gy - CITY.FOOT_OFF + CITY.PLOT);
  const text = truncate(name, 18);
  const w = Math.max(36, text.length * 6.2 + 12);
  return (
    <g className="plate" transform={`translate(${r1(at.x)} ${r1(at.y)})`} aria-hidden="true">
      <rect className="plate-board" x={r1(-w / 2)} y={-6} width={r1(w)} height={13} rx={3} />
      <text className="plate-text" y={4} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

export const BuildingPlate = memo(
  BuildingPlateImpl,
  (a, b) => a.name === b.name && a.ox === b.ox && a.oy === b.oy && a.b.cell === b.b.cell && a.b.workspaceId === b.b.workspaceId,
);
