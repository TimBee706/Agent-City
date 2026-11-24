import { Fragment, memo } from 'react';
import type { CityGrid, Decoration } from './cityLayout';
import { projectorFor } from './cityLayout';
import { FACADE } from './facade';
import { Deco } from './sprites';

const PALETTES = Array.from({ length: FACADE.PALETTES }, (_, i) => i);
/** Lit window gradients (CSS: `fill: url(#cc-win-<tone>)`). */
const WINDOW_TONES = ['working', 'working-b', 'waiting', 'waiting-b', 'idle', 'resting', 'done', 'failed', 'stopped'] as const;
const LEAVES = ['0', '1', '2', 'cone', 'bush'] as const;

/** Vertical two-stop gradient; the stop colours come from CSS (`.gs-<name>-a` / `-b`). */
function Vertical({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <linearGradient id={id} className={className} x1={0} y1={0} x2={0} y2={1}>
      <stop className={`gs-${name}-a`} offset={0} />
      <stop className={`gs-${name}-b`} offset={1} />
    </linearGradient>
  );
}

/**
 * Shared SVG <defs> of the city: soft gradients for walls / roofs (per palette), windows, foliage,
 * water, ground and shadows. Referenced from CSS (`fill: url(#cc-...)`); all colours live in CSS so
 * themes and the day / night tint apply. Rendered once per webview in an invisible (but not
 * `display: none`) SVG, so the map layers and the building view can all reference them - also while
 * the map itself is hidden.
 */
export function CityDefs() {
  return (
    <svg className="city-defs" width={0} height={0} aria-hidden="true" focusable="false">
      <defs>
        <BuildingViewDefs />
      {PALETTES.map((n) => (
        <Fragment key={n}>
          <Vertical id={`cc-wl-${n}`} name="wl" className={`pal-${n}`} />
          <Vertical id={`cc-wr-${n}`} name="wr" className={`pal-${n}`} />
          <Vertical id={`cc-wlq-${n}`} name="wlq" className={`pal-${n}`} />
          <Vertical id={`cc-wrq-${n}`} name="wrq" className={`pal-${n}`} />
          <Vertical id={`cc-rf-${n}`} name="rf" className={`pal-${n}`} />
          <Vertical id={`cc-rb-${n}`} name="rb" className={`pal-${n}`} />
        </Fragment>
      ))}
      {WINDOW_TONES.map((t) => (
        <Vertical key={t} id={`cc-win-${t}`} name="win" className={`wt-${t}`} />
      ))}
      {LEAVES.map((l) => (
        <radialGradient key={l} id={`cc-leaf-${l}`} className={`lf-${l}`} cx={0.36} cy={0.3} r={0.75}>
          <stop className="gs-leaf-a" offset={0} />
          <stop className="gs-leaf-b" offset={0.55} />
          <stop className="gs-leaf-c" offset={1} />
        </radialGradient>
      ))}
      <linearGradient id="cc-rug" x1={0} y1={0} x2={1} y2={1}>
        <stop className="gs-rug-a" offset={0} />
        <stop className="gs-rug-b" offset={1} />
      </linearGradient>
      <Vertical id="cc-rug-l" name="rugl" />
      <Vertical id="cc-rug-r" name="rugr" />
      <Vertical id="cc-base-l" name="basel" />
      <Vertical id="cc-base-r" name="baser" />
      <Vertical id="cc-door" name="door" />
      <radialGradient id="cc-water" cx={0.4} cy={0.35} r={0.8}>
        <stop className="gs-water-a" offset={0} />
        <stop className="gs-water-b" offset={1} />
      </radialGradient>
      <radialGradient id="cc-soft-shadow" cx={0.5} cy={0.5} r={0.5}>
        <stop className="gs-shadow-a" offset={0} />
        <stop className="gs-shadow-b" offset={0.6} />
        <stop className="gs-shadow-c" offset={1} />
      </radialGradient>
      <linearGradient id="cc-cast" x1={0} y1={0} x2={1} y2={0}>
        <stop className="gs-cast-a" offset={0} />
        <stop className="gs-cast-b" offset={1} />
      </linearGradient>
      <radialGradient id="cc-glow" cx={0.5} cy={0.5} r={0.5}>
        <stop className="gs-glow-a" offset={0} />
        <stop className="gs-glow-b" offset={1} />
      </radialGradient>
      </defs>
    </svg>
  );
}

/** Gradients and the brick pattern of the building view (level 2). */
function BuildingViewDefs() {
  return (
    <>
      <linearGradient id="cc-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className="sky-top" />
        <stop offset="1" className="sky-bottom" />
      </linearGradient>
      <pattern id="cc-brick" width="24" height="12" patternUnits="userSpaceOnUse">
        <rect className="brick-bg" x={0} y={0} width={24} height={12} />
        <path className="brick-line" d="M0 0.5 H24 M0 6.5 H24 M12 0.5 V6.5 M0 6.5 V12 M24 6.5 V12" />
      </pattern>
      <Vertical id="cc-bv-earth" name="earth" />
      <Vertical id="cc-bv-floor" name="floor" />
      <Vertical id="cc-bv-room" name="room" />
      <Vertical id="cc-bv-glass" name="glass" />
      <Vertical id="cc-bv-cone" name="cone" />
      <Vertical id="cc-bv-cone-warm" name="conew" />
      <Vertical id="cc-bv-dark" name="dark" />
      <Vertical id="cc-bv-cabin" name="cabin" />
      <Vertical id="cc-bv-wood" name="wood" />
    </>
  );
}

/**
 * Static ground of the city: rug, lawns, streets with dashed centre lines and zebra crossings, and
 * flat decorations (ponds, flower beds). Rendered once per grid (memo) - not on pan / zoom.
 */
function CityGroundImpl({ grid }: { grid: CityGrid }) {
  const g = grid.ground;
  const p = projectorFor(grid);
  return (
    <g className="ground" aria-hidden="true">
      <ellipse className="rug-shadow" cx={Math.round(grid.width / 2)} cy={Math.round(grid.height * 0.56)} rx={Math.round(grid.width * 0.5)} ry={Math.round(grid.height * 0.46)} />
      <path className="rug-side rug-side--l" d={g.rugLeft} />
      <path className="rug-side rug-side--r" d={g.rugRight} />
      <path className="rug-top" d={g.rugTop} />
      <path className="rug-stitch" d={g.rugStitch} />
      <path className="road" d={g.roads} />
      <path className="lawn lawn--building" d={g.buildingLawns} />
      <path className="lawn lawn--park" d={g.parkLawns} />
      <path className="road-centre" d={g.centreLines} />
      <path className="zebra" d={g.zebras} />
      {grid.decorations
        .filter((d) => d.layer === 'ground')
        .map((d) => (
          <Deco key={d.id} d={d} at={p(d.gx, d.gy)} />
        ))}
    </g>
  );
}

export const CityGround = memo(CityGroundImpl);

/** Lamps, traffic lights and parked cars on the streets (drawn after the moving cars). */
function RoadPropsImpl({ grid }: { grid: CityGrid }) {
  const p = projectorFor(grid);
  return (
    <g className="road-props" aria-hidden="true">
      {grid.decorations
        .filter((d) => d.layer === 'road')
        .sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.gx - b.gx)
        .map((d) => (
          <Deco key={d.id} d={d} at={p(d.gx, d.gy)} />
        ))}
    </g>
  );
}

export const RoadProps = memo(RoadPropsImpl);

/** Back or front decorations of one plot (static per grid). */
function PlotDecosImpl({ items, ox, oy }: { items: readonly Decoration[]; ox: number; oy: number }) {
  if (!items.length) return null;
  const p = projectorFor({ ox, oy });
  return (
    <g className="plot-decos" aria-hidden="true">
      {items.map((d) => (
        <Deco key={d.id} d={d} at={p(d.gx, d.gy)} />
      ))}
    </g>
  );
}

export const PlotDecos = memo(PlotDecosImpl);
