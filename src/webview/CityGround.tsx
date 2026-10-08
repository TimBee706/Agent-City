import { memo } from 'react';
import type { CityGrid, Decoration } from './cityLayout';
import { projectorFor } from './cityLayout';
import { Deco } from './sprites';

/** SVG <defs> for the rug (grass texture). Referenced from CSS (`fill: url(#cc-grass)`). */
export function CityDefs() {
  return (
    <defs>
      <pattern id="cc-grass" width="26" height="13" patternUnits="userSpaceOnUse">
        <rect className="grass-bg" x={0} y={0} width={26} height={13} />
        <path className="grass-tuft" d="M3 9 l1.2 -3 l1.2 3 M15 4 l1 -2.6 l1 2.6 M20 11 l1 -2.4 l1 2.4 M9 2 l0.8 -1.8 l0.8 1.8" />
      </pattern>
      <pattern id="cc-park" width="20" height="10" patternUnits="userSpaceOnUse">
        <rect className="park-bg" x={0} y={0} width={20} height={10} />
        <circle className="park-dot" cx={5} cy={3} r={0.9} />
        <circle className="park-dot" cx={15} cy={8} r={0.9} />
      </pattern>
    </defs>
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
