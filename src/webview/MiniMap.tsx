import { PointerEvent, forwardRef, memo, useRef } from 'react';
import type { CityGrid } from './cityLayout';
import type { Pt } from './iso';
import type { Size, ViewTransform } from './zoom';

/** Colour of a building dot on the minimap. */
export type MiniTone = 'waiting' | 'failed' | 'working' | 'live' | 'quiet';

export interface MiniBuilding {
  id: string;
  center: Pt;
  tone: MiniTone;
  selected: boolean;
}

/** The minimap is drawn inside this box (px). */
export const MINIMAP = { WIDTH: 168, HEIGHT: 104 } as const;

/** Visible world rect for a camera (used for the minimap's viewport frame). */
export function viewRect(t: ViewTransform, viewport: Size): { x: number; y: number; width: number; height: number } {
  return { x: -t.x / t.k, y: -t.y / t.k, width: viewport.width / t.k, height: viewport.height / t.k };
}

interface Props {
  grid: CityGrid;
  buildings: readonly MiniBuilding[];
  /** Centre the camera on a world point (drag = follow the pointer). */
  onNavigate: (wx: number, wy: number, animate: boolean) => void;
}

/**
 * Overview of the whole city in a corner of the map: one dot per building (coloured by what needs
 * attention) and a frame for the current view. Click or drag to move the camera. Pointer-only
 * helper (aria-hidden): the keyboard has spatial navigation and the taxi.
 */
const MiniMapImpl = forwardRef<SVGRectElement, Props>(function MiniMapImpl({ grid, buildings, onNavigate }, frameRef) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const dot = Math.max(14, Math.min(grid.width, grid.height) / 46);

  const navigate = (e: PointerEvent, animate: boolean) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // viewBox is fitted with "xMidYMid meet"
    const k = Math.min(r.width / grid.width, r.height / grid.height);
    const wx = (e.clientX - r.left - (r.width - grid.width * k) / 2) / k;
    const wy = (e.clientY - r.top - (r.height - grid.height * k) / 2) / k;
    onNavigate(wx, wy, animate);
  };

  return (
    <div
      className="minimap"
      aria-hidden="true"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        dragging.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        navigate(e, true);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        navigate(e, false);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.stopPropagation();
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <svg ref={svgRef} width={MINIMAP.WIDTH} height={MINIMAP.HEIGHT} viewBox={`0 0 ${Math.round(grid.width)} ${Math.round(grid.height)}`}>
        <path className="mm-rug" d={grid.ground.rugTop} />
        <path className="mm-roads" d={grid.ground.roads} />
        {buildings.map((b) => (
          <circle
            key={b.id}
            className={`mm-dot mm-dot--${b.tone}${b.selected ? ' is-selected' : ''}`}
            cx={Math.round(b.center.x)}
            cy={Math.round(b.center.y - dot * 0.4)}
            r={Math.round(b.tone === 'quiet' ? dot * 0.75 : dot)}
          />
        ))}
        <rect ref={frameRef} className="mm-frame" x={0} y={0} width={Math.round(grid.width)} height={Math.round(grid.height)} rx={dot * 0.5} />
      </svg>
    </div>
  );
});

export const MiniMap = memo(MiniMapImpl);
