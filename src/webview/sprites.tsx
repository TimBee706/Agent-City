/**
 * Small inline-SVG sprites for the play-rug city (trees, lamps, benches, cars, ...). Pure markup:
 * positions come in as props, colours from CSS classes (no inline styles, no external images).
 */
import { memo } from 'react';
import type { Decoration } from './cityLayout';
import { Pt, pts } from './iso';

/** Local iso projection for sprites: u along gx, v along gy (tiles), z up (px). */
function q(u: number, v: number, z: number): Pt {
  return { x: (u - v) * 32, y: (u + v) * 16 - z };
}

function box(u0: number, u1: number, v0: number, v1: number, z0: number, z1: number): { top: string; left: string; right: string } {
  return {
    top: pts([q(u0, v0, z1), q(u1, v0, z1), q(u1, v1, z1), q(u0, v1, z1)]),
    left: pts([q(u0, v1, z0), q(u1, v1, z0), q(u1, v1, z1), q(u0, v1, z1)]),
    right: pts([q(u1, v1, z0), q(u1, v0, z0), q(u1, v0, z1), q(u1, v1, z1)]),
  };
}

/** Car shapes (precomputed once): a toy car pointing along +gx; mirror with scale(-1 1) for gy. */
const CAR = (() => {
  const body = box(-0.24, 0.24, -0.12, 0.12, 2, 8);
  const cabin = box(-0.11, 0.1, -0.1, 0.1, 8, 13);
  const wheels = [
    [-0.15, 0.12],
    [0.15, 0.12],
    [0.15, -0.12],
  ].map(([u, v]) => q(u, v, 2));
  const glass = pts([q(0.1, 0.1, 9), q(0.1, -0.1, 9), q(0.1, -0.1, 12.5), q(0.1, 0.1, 12.5)]);
  const light = q(0.24, 0.06, 5);
  const sideGlass = pts([q(-0.09, 0.1, 9), q(0.08, 0.1, 9), q(0.08, 0.1, 12.5), q(-0.09, 0.1, 12.5)]);
  const beam = pts([q(0.24, 0.1, 3), q(0.24, -0.1, 3), q(1.0, -0.26, 0), q(1.0, 0.26, 0)]);
  const tail = q(-0.24, 0.12, 5.5);
  return { body, cabin, wheels, glass, sideGlass, beam, light, tail };
})();

/** A toy car centred at (0, 0) on the ground. */
export function CarShape({ variant, taxi = false }: { variant: number; taxi?: boolean }) {
  return (
    <g className={`car-shape car--${taxi ? 'taxi' : variant % 6}`}>
      <polygon className="car-beam" points={CAR.beam} />
      <ellipse className="car-shadow" cx={1} cy={2} rx={18} ry={7.5} />
      {CAR.wheels.map((w, i) => (
        <ellipse key={i} className="car-wheel" cx={w.x} cy={w.y} rx={3} ry={2.2} />
      ))}
      <polygon className="car-side" points={CAR.body.left} />
      <polygon className="car-front" points={CAR.body.right} />
      <polygon className="car-top" points={CAR.body.top} />
      <polygon className="car-side car-cabin" points={CAR.cabin.left} />
      <polygon className="car-glass car-glass--side" points={CAR.sideGlass} />
      <polygon className="car-glass" points={CAR.glass} />
      <polygon className="car-cabin-top" points={CAR.cabin.top} />
      <circle className="car-light" cx={CAR.light.x} cy={CAR.light.y} r={1.5} />
      <circle className="car-tail" cx={CAR.tail.x} cy={CAR.tail.y} r={1.1} />
      {taxi && (
        <g className="taxi-sign">
          <rect x={-5} y={-22} width={10} height={5} rx={1} />
        </g>
      )}
    </g>
  );
}

const POND_REEDS = 'M30 -4 L28 -14 M33 -3 L33 -15 M36 -4 L39 -13';

function DecoImpl({ d, at }: { d: Decoration; at: Pt }) {
  const cls = `deco deco-${d.kind} dv-${d.variant}${d.small ? ' deco--small' : ''}`;
  const t = `translate(${Math.round(at.x * 10) / 10} ${Math.round(at.y * 10) / 10})`;
  switch (d.kind) {
    case 'tree-round':
      return (
        <g className={cls} transform={t}>
          <ellipse className="deco-shadow" cx={6} cy={1} rx={15} ry={6} />
          <path className="trunk" d="M-2.2 0 L-1.6 -14 L1.6 -14 L2.2 0 Z" />
          <circle className="leaf leaf-b" cx={-7} cy={-17} r={7.5} />
          <circle className="leaf leaf-b" cx={7} cy={-16.5} r={6.5} />
          <circle className="leaf leaf-a" cx={0} cy={-24} r={12} />
          <ellipse className="leaf-hi" cx={-4} cy={-29} rx={5} ry={3} />
        </g>
      );
    case 'tree-cone':
      return (
        <g className={cls} transform={t}>
          <ellipse className="deco-shadow" cx={5} cy={1} rx={13} ry={5} />
          <rect className="trunk" x={-1.8} y={-9} width={3.6} height={9} rx={1} />
          <path className="leaf leaf-b" d="M0 -29 Q8 -14 12.5 -8 Q0 -3.5 -12.5 -8 Q-8 -14 0 -29 Z" />
          <path className="leaf leaf-a" d="M0 -41 Q6 -27 10 -20 Q0 -16 -10 -20 Q-6 -27 0 -41 Z" />
          <path className="leaf-hi" d="M-1 -38 Q-4 -30 -7.5 -22 Q-5 -24 -1 -38 Z" />
        </g>
      );
    case 'bush':
      return (
        <g className={cls} transform={t}>
          <ellipse className="deco-shadow" cx={3} cy={1} rx={9} ry={3.5} />
          <circle className="leaf leaf-b" cx={-4} cy={-4} r={5} />
          <circle className="leaf leaf-a" cx={3} cy={-5} r={5.5} />
          <circle className="leaf leaf-b" cx={0} cy={-8} r={4.5} />
        </g>
      );
    case 'flowers':
      return (
        <g className={cls} transform={t}>
          <ellipse className="flowerbed" cx={0} cy={0} rx={13} ry={6.5} />
          {[
            [-7, -1],
            [-2, -3],
            [4, -2],
            [8, 0],
            [0, 2],
            [-4, 2.5],
            [5, 2.5],
          ].map(([x, y], i) => (
            <circle key={i} className={`flower fl-${(i + d.variant) % 4}`} cx={x} cy={y} r={1.9} />
          ))}
        </g>
      );
    case 'bench':
      return (
        <g className={cls} transform={t}>
          <path className="bench-leg" d="M-7 -1 L-7 -6 M7 6 L7 1 M-3 -6 L-3 -11 M11 1 L11 -4" />
          <path className="bench-seat" d="M-9 -7 L9 2" />
          <path className="bench-back" d="M-5 -12 L13 -3" />
        </g>
      );
    case 'lamp':
      return (
        <g className={cls} transform={t}>
          <ellipse className="lamp-pool" cx={6} cy={2} rx={26} ry={12} />
          <circle className="lamp-glow" cx={4} cy={-31.5} r={11} />
          <line className="lamp-pole" x1={0} y1={0} x2={0} y2={-30} />
          <path className="lamp-arm" d="M0 -30 Q0 -34 4 -33" />
          <circle className="lamp-light" cx={4} cy={-31.5} r={3} />
        </g>
      );
    case 'traffic-light':
      return (
        <g className={cls} transform={t}>
          <line className="lamp-pole" x1={0} y1={0} x2={0} y2={-24} />
          <rect className="tl-box" x={-3.5} y={-36} width={7} height={14} rx={2} />
          <circle className="tl tl-red" cx={0} cy={-32.5} r={1.7} />
          <circle className="tl tl-yellow" cx={0} cy={-29} r={1.7} />
          <circle className="tl tl-green" cx={0} cy={-25.5} r={1.7} />
        </g>
      );
    case 'parked-car':
      return (
        <g className={cls} transform={t}>
          <CarShape variant={d.variant} />
        </g>
      );
    case 'pond':
      return (
        <g className={cls} transform={t}>
          <ellipse className="pond-rim" cx={0} cy={0} rx={46} ry={23} />
          <ellipse className="pond-water" cx={0} cy={0.8} rx={41} ry={19.5} />
          <ellipse className="pond-hi" cx={-12} cy={-6} rx={14} ry={3.5} />
          <path className="pond-ripple" d="M-4 6 q5 -2.4 10 0 M-26 -1 q4 -2 8 0 M16 -6 q4 -2 8 0" />
          <ellipse className="lily" cx={14} cy={5} rx={5} ry={2.5} />
          <ellipse className="lily" cx={-20} cy={7} rx={4} ry={2} />
          <path className="reeds" d={POND_REEDS} />
        </g>
      );
    case 'fountain':
      return (
        <g className={cls} transform={t}>
          <ellipse className="deco-shadow" cx={4} cy={3} rx={30} ry={13} />
          <ellipse className="fountain-stone" cx={0} cy={0} rx={27} ry={13.5} />
          <ellipse className="fountain-water" cx={0} cy={-1.5} rx={22} ry={10.5} />
          <rect className="fountain-stone" x={-3.5} y={-17} width={7} height={15} rx={1.5} />
          <ellipse className="fountain-stone" cx={0} cy={-17} rx={9} ry={4} />
          <ellipse className="fountain-water" cx={0} cy={-17.5} rx={6.5} ry={2.6} />
        </g>
      );
    case 'swing':
      return (
        <g className={cls} transform={t}>
          <path className="swing-frame" d="M-12 -2 L-6 -24 L0 -2 M6 4 L12 -18 L18 4 M-6 -24 L12 -18" />
          <path className="swing-rope" d="M1 -21 L1 -9 M5 -20 L5 -8" />
          <path className="swing-seat" d="M0 -9 L6 -7" />
        </g>
      );
    default:
      return null;
  }
}

/** One decoration sprite at a screen point (memoised: static per layout). */
export const Deco = memo(DecoImpl);

/** Fountain jets (animated; rendered in the effects layer above the static fountain). */
export function FountainSpray() {
  return (
    <g className="fountain-spray">
      <path d="M0 -19 Q-7 -32 -12 -18 M0 -19 Q7 -32 12 -18 M0 -19 L0 -31" />
    </g>
  );
}

/** Tiny person used on the city map (subagents walking to the door). */
export function MiniPerson() {
  return (
    <g className="mini-person">
      <ellipse className="deco-shadow" cx={1} cy={0.5} rx={4} ry={1.6} />
      <rect className="mini-body" x={-2.3} y={-8} width={4.6} height={6.5} rx={2} />
      <path className="mini-legs" d="M-1 -1.8 L-1.3 0 M1 -1.8 L1.3 0" />
      <circle className="mini-head" cx={0} cy={-10.5} r={2.4} />
    </g>
  );
}
