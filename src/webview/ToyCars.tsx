import { KeyboardEvent, memo, useEffect, useRef } from 'react';
import { CarLoop, carKeyframes, carRest } from './cityLayout';
import { useReducedMotion } from './motion';
import { CarShape } from './sprites';

interface Props {
  cars: readonly CarLoop[];
  /** False while the city is not shown (building level) - animations are paused. */
  running: boolean;
  /** The taxi was clicked: drive to the next building that needs attention. */
  onTaxi: () => void;
}

/**
 * Toy cars driving loops on the street grid. Animated with the Web Animations API outside React
 * (no re-render per frame, CSP-safe). Paused while hidden (webview / level), cancelled on unmount,
 * parked (static) with reduced motion. Cars are decorative (aria-hidden) except the taxi.
 */
function ToyCarsImpl({ cars, running, onTaxi }: Props) {
  const refs = useRef<(SVGGElement | null)[]>([]);
  const anims = useRef<Animation[]>([]);
  const reduced = useReducedMotion();
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (reduced) return undefined;
    const list: Animation[] = [];
    cars.forEach((car, i) => {
      const el = refs.current[i];
      if (!el || typeof el.animate !== 'function') return;
      const orientEl = el.querySelector<SVGGElement>('.car-orient');
      const { move, orient } = carKeyframes(car);
      if (!move.length) return;
      // spread the cars along their loops; move + orient share the same timing
      const timing = { duration: car.durationMs, iterations: Infinity, delay: -((i * 2741) % car.durationMs) };
      const parts = [el.animate(move, timing)];
      if (orientEl) parts.push(orientEl.animate(orient, timing));
      for (const a of parts) {
        if (!runningRef.current || document.hidden) a.pause();
        list.push(a);
      }
    });
    anims.current = list;
    const onVisibility = () => {
      for (const a of anims.current) {
        if (document.hidden || !runningRef.current) a.pause();
        else a.play();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      for (const a of list) a.cancel();
      anims.current = [];
    };
  }, [cars, reduced]);

  useEffect(() => {
    for (const a of anims.current) {
      if (running && !document.hidden) a.play();
      else a.pause();
    }
  }, [running]);

  const honk = (i: number) => {
    const el = refs.current[i];
    if (!el) return;
    const bounce = el.querySelector<SVGGElement>('.car-bounce');
    const beep = el.querySelector<SVGGElement>('.car-beep');
    if (typeof el.animate !== 'function') return;
    if (!reduced) {
      bounce?.animate(
        [{ transform: 'translateY(0px)' }, { transform: 'translateY(-7px)', offset: 0.35 }, { transform: 'translateY(0px)' }],
        { duration: 380, easing: 'ease-out' },
      );
    }
    beep?.animate(
      reduced
        ? [{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: 'translateY(0px)' },
            { opacity: 1, transform: 'translateY(-6px)', offset: 0.2 },
            { opacity: 1, transform: 'translateY(-10px)', offset: 0.8 },
            { opacity: 0, transform: 'translateY(-12px)' },
          ],
      { duration: 1100, easing: 'ease-out' },
    );
  };

  return (
    <g className={`toy-cars${reduced ? ' is-parked' : ''}`}>
      {cars.map((car, i) => {
        const interactive = car.taxi
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': 'Taxi: drive to the next building that needs your attention',
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  honk(i);
                  onTaxi();
                }
              },
            }
          : { 'aria-hidden': true };
        return (
          <g
            key={car.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={`toy-car${car.taxi ? ' toy-car--taxi' : ''}`}
            transform={carRest(car).move}
            onClick={(e) => {
              e.stopPropagation();
              honk(i);
              if (car.taxi) onTaxi();
            }}
            {...interactive}
          >
            {car.taxi && <title>Taxi - click to visit the next building that needs your attention</title>}
            <g className="car-bounce">
              <g className="car-orient" transform={carRest(car).orient}>
                <CarShape variant={car.variant} taxi={car.taxi} />
              </g>
            </g>
            <g className="car-beep" aria-hidden="true">
              <rect x={-17} y={-40} width={34} height={14} rx={7} />
              <text x={0} y={-30} textAnchor="middle">
                Beep!
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

export const ToyCars = memo(ToyCarsImpl);
