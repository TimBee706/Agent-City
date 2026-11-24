import { forwardRef, memo, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { WALK_IN_WINDOW_MS } from './AgentCharacter';
import type { Pt } from './iso';
import { prefersReducedMotion, useIsoLayoutEffect } from './motion';
import { FountainSpray, MiniPerson } from './sprites';

const r1 = (n: number) => Math.round(n * 10) / 10;
const at = (q: Pt, dx = 0, dy = 0) => `translate(${r1(q.x + dx)} ${r1(q.y + dy)})`;
const WALK_MS = 1500;

export interface FxWalker {
  id: string;
  leaving: boolean;
  spawnedAt?: number;
}

/** Everything the effects layer draws for one building (plain values: cheap to compare). */
export interface FxItem {
  id: string;
  alert: Pt;
  vent: Pt;
  roof: Pt;
  badge: Pt;
  door: Pt;
  street: Pt;
  /** Pulsing ring around the "!" sign. */
  waiting: boolean;
  /** Smoke / steam while a session is working. */
  smoke: boolean;
  /** Fireworks: a task was just completed here. */
  sparkle: boolean;
  selected: boolean;
  walkers: readonly FxWalker[];
}

export function fxSignature(i: FxItem): string {
  let s = `${i.id}|${i.waiting ? 1 : 0}${i.smoke ? 1 : 0}${i.sparkle ? 1 : 0}${i.selected ? 1 : 0}|${r1(i.roof.x)},${r1(i.roof.y)}`;
  for (const w of i.walkers) s += `|${w.id}:${w.leaving ? 1 : 0}`;
  return s;
}

/** True if the item draws anything at all (others are skipped to keep the layer small). */
export function fxActive(i: Pick<FxItem, 'waiting' | 'smoke' | 'sparkle' | 'selected' | 'walkers'>): boolean {
  return i.waiting || i.smoke || i.sparkle || i.selected || i.walkers.length > 0;
}

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
    <g className="door-walker" transform={at(to)}>
      <g ref={ref} className="door-walker-inner">
        <g className="door-walker-bob">
          <MiniPerson />
        </g>
      </g>
    </g>
  );
}

const RAYS = 'M0 -4 L0 -11 M2.8 -2.8 L7.8 -7.8 M4 0 L11 0 M2.8 2.8 L7.8 7.8 M0 4 L0 11 M-2.8 2.8 L-7.8 7.8 M-4 0 L-11 0 M-2.8 -2.8 L-7.8 -7.8';
const BURSTS: [number, number][] = [
  [0, -30],
  [-17, -18],
  [16, -22],
];

function BuildingFxImpl({ item, effects }: { item: FxItem; effects: boolean; sig: string }) {
  return (
    <g className="fx-building" data-fx-for={item.id}>
      {item.smoke && effects && (
        <g className="fx-smoke" transform={at(item.vent)}>
          <circle className="puff puff--0" r={3.4} />
          <circle className="puff puff--1" r={3.4} />
          <circle className="puff puff--2" r={3.4} />
        </g>
      )}
      {item.waiting && (
        <g className="fx-ping" transform={at(item.alert)}>
          <circle className="fx-ping-ring" r={5} />
          <circle className="fx-ping-ring fx-ping-ring--late" r={5} />
        </g>
      )}
      {item.sparkle && (
        <g className="fx-firework" transform={at(item.roof)}>
          {BURSTS.map(([x, y], i) => (
            <g key={i} transform={`translate(${x} ${y})`}>
              <path className={`burst burst--${i}`} d={RAYS} />
            </g>
          ))}
        </g>
      )}
      {item.selected && (
        <g className="fx-marker" transform={at(item.badge, 0, -14)}>
          <path className="fx-marker-pin" d="M0 0 L-6.5 -9 Q0 -12 6.5 -9 Z" />
        </g>
      )}
      {item.walkers.map((w) => (
        <DoorWalker key={w.id} from={item.street} to={item.door} leaving={w.leaving} spawnedAt={w.spawnedAt} />
      ))}
    </g>
  );
}

const BuildingFx = memo(BuildingFxImpl, (a, b) => a.sig === b.sig && a.effects === b.effects);

interface Props {
  items: readonly FxItem[];
  /** Screen positions of the fountains (their jets are animated). */
  fountains: readonly Pt[];
  /** Ambient effects (smoke, fountain jets) on / off. Alerts, fireworks and walkers are always shown. */
  effects: boolean;
}

/**
 * Everything on the city map that moves continuously, in a layer of its own above the buildings:
 * the browser only has to redraw this small layer per frame - never the static city below.
 */
function CityFxImpl({ items, fountains, effects }: Props) {
  return (
    <g className="city-fx">
      {effects &&
        fountains.map((q, i) => (
          <g key={i} transform={at(q)}>
            <FountainSpray />
          </g>
        ))}
      {items.map((item) => (
        <BuildingFx key={item.id} item={item} effects={effects} sig={fxSignature(item)} />
      ))}
    </g>
  );
}

export const CityFx = memo(CityFxImpl);

/** Upper bound of buildings with running effects at once (keeps the animated layer small). */
export const MAX_FX = 48;

/**
 * Culling key written by the camera: "F" (zoomed far out) or "N", followed by the ids of the
 * candidates in view, separated by newlines.
 */
export function fxViewKey(far: boolean, visibleIds: readonly string[]): string {
  return [far ? 'F' : 'N', ...visibleIds].join('\n');
}

/** Items that actually get effects for a view (`undefined` = not measured yet: everything). */
export function visibleFx(all: readonly FxItem[], view: string | undefined, max = MAX_FX): FxItem[] {
  if (view === undefined) return all.slice(0, max);
  const [mode, ...ids] = view.split('\n');
  const visible = new Set(ids);
  const out: FxItem[] = [];
  for (const i of all) {
    if (!visible.has(i.id)) continue;
    // zoomed far out: only what asks for attention keeps moving
    const item = mode === 'F' && i.smoke ? { ...i, smoke: false } : i;
    if (fxActive(item)) out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export interface CityFxHandle {
  /** Called by the camera (outside React rendering) when the set of buildings in view changes. */
  setView(key: string): void;
}

interface LayerProps {
  /** Every building that has something to show, in view or not. */
  all: readonly FxItem[];
  fountains: readonly Pt[];
  effects: boolean;
}

/**
 * The effects layer with its own culling state: panning re-renders only this small component
 * (never the city map) when buildings enter or leave the view.
 */
export const CityFxLayer = memo(
  forwardRef<CityFxHandle, LayerProps>(function CityFxLayer({ all, fountains, effects }, ref) {
    const [view, setView] = useState<string | undefined>();
    useImperativeHandle(ref, () => ({ setView: (key) => setView((prev) => (prev === key ? prev : key)) }), []);
    const items = useMemo(() => visibleFx(all, view), [all, view]);
    return <CityFx items={items} fountains={fountains} effects={effects} />;
  }),
);
