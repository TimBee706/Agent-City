import { memo } from 'react';

const CLOUDS = [0, 1, 2, 3, 4];

/**
 * Backdrop behind the city: sky gradient, sun or moon, stars and drifting clouds. Plain HTML
 * elements animated with CSS transforms (compositor only - no repaint of the city). Colours follow
 * the day period (`.tint-*` on the app root). Decorative.
 */
function SkyImpl({ effects }: { effects: boolean }) {
  return (
    <div className="sky" aria-hidden="true">
      <div className="sky-stars" />
      <div className="sky-stars sky-stars--b" />
      <div className="sky-orb" />
      {effects && CLOUDS.map((i) => <div key={i} className={`cloud cloud--${i}`} />)}
    </div>
  );
}

export const Sky = memo(SkyImpl);

/** A few birds crossing the map now and then (above the city, never interactive). */
function BirdsImpl() {
  return (
    <div className="birds" aria-hidden="true">
      <svg className="flock" width="64" height="34" viewBox="0 0 64 34">
        <path className="bird bird--0" d="M4 12 q5 -6 9 0 q4 -6 9 0" />
        <path className="bird bird--1" d="M30 24 q4 -5 7.5 0 q3.5 -5 7.5 0" />
        <path className="bird bird--2" d="M44 8 q4 -5 7.5 0 q3.5 -5 7.5 0" />
      </svg>
    </div>
  );
}

export const Birds = memo(BirdsImpl);
