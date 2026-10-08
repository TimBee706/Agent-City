import { memo, useEffect, useRef } from 'react';
import type { Agent } from '../models/Agent';
import { CHARACTER_STATE_LABEL } from '../models/Agent';
import { fnv1a } from '../util/hash';
import { CHARACTER_GLYPH } from './format';
import { prefersReducedMotion, useIsoLayoutEffect } from './motion';
import { Select, activatable } from './selection';

interface Props {
  agent: Agent;
  x: number;
  y: number;
  /** Building entrance relative to the desk (walk-in / walk-out target). */
  entranceDx: number;
  entranceDy: number;
  selected: boolean;
  sparkle: boolean;
  onSelect: Select;
}

/** Walk-in only for agents that spawned very recently (not when reopening the panel later). */
export const WALK_IN_WINDOW_MS = 8_000;
const WALK_MS = 1600;
const FADE_MS = 280;

/** Deterministic shirt color slot (0-5) from the agent id. */
export function shirtSlot(agentId: string): number {
  return parseInt(fnv1a(agentId).slice(0, 6), 16) % 6;
}

/**
 * Small vector person at a desk (side view). Feet anchor at (x, y).
 * State animations are CSS classes `char--<state>`; walking uses the Web Animations API on an inner
 * group (CSP-safe, no inline styles). Reduced motion: no walking, only a short fade.
 */
function AgentCharacterImpl({ agent, x, y, entranceDx, entranceDy, selected, sparkle, onSelect }: Props) {
  const walker = useRef<SVGGElement>(null);
  const state = agent.characterState;
  const standing = state === 'blocked';
  const empty = state === 'stopped';
  const isSub = agent.role === 'subagent';
  const label =
    `${isSub ? `Subagent ${agent.agentType}` : `Main agent ${agent.name}`}: ${CHARACTER_STATE_LABEL[state]}` +
    `${agent.leaving ? ', leaving' : ''}${agent.task ? `, task: ${agent.task}` : ''}${agent.attention ? ', needs your attention' : ''}`;
  const scale = isSub ? 0.82 : 1;

  // Walk in from the building entrance (once, on mount).
  useIsoLayoutEffect(() => {
    const el = walker.current;
    if (!el || !isSub || agent.leaving || !agent.spawnedAt || typeof el.animate !== 'function') return;
    if (Date.now() - agent.spawnedAt > WALK_IN_WINDOW_MS) return;
    if (prefersReducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
      return;
    }
    const dx = entranceDx / scale;
    const dy = entranceDy / scale;
    el.classList.add('is-walking');
    const anim = el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 1, offset: 0.08 },
        { transform: `translate(${dx * 0.15}px, ${dy * 0.5}px)`, opacity: 1, offset: 0.6 },
        { transform: 'translate(0px, 0px)', opacity: 1 },
      ],
      { duration: WALK_MS, easing: 'ease-in-out' },
    );
    anim.onfinish = () => el.classList.remove('is-walking');
    return () => anim.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Walk out (or fade) when the subagent stopped.
  useEffect(() => {
    const el = walker.current;
    if (!el || !agent.leaving || typeof el.animate !== 'function') return;
    if (prefersReducedMotion()) {
      const a = el.animate([{ opacity: 1 }, { opacity: 0.25 }], { duration: FADE_MS, fill: 'forwards' });
      return () => a.cancel();
    }
    const dx = entranceDx / scale;
    const dy = entranceDy / scale;
    el.classList.add('is-walking');
    const anim = el.animate(
      [
        { transform: 'translate(0px, 0px)', opacity: 1 },
        { transform: `translate(${dx * 0.15}px, ${dy * 0.5}px)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
      ],
      { duration: WALK_MS, delay: 400, easing: 'ease-in-out', fill: 'forwards' },
    );
    return () => anim.cancel();
  }, [agent.leaving, entranceDx, entranceDy, scale]);

  return (
    <g
      className={`char char--${state} shirt-${shirtSlot(agent.agentId)}${selected ? ' is-selected' : ''}${isSub ? ' char--sub' : ''}${
        agent.leaving ? ' is-leaving' : ''
      }`}
      transform={`translate(${x} ${y}) scale(${scale})`}
      {...activatable(() => onSelect({ kind: 'agent', id: agent.agentId }), label)}
    >
      <title>{label}</title>
      <rect className="focus-ring" x={-28} y={-62} width={56} height={66} rx={8} />
      {/* desk + monitor */}
      <g className="desk">
        <rect x={-2} y={-22} width={27} height={3} rx={1} />
        <line x1={22} y1={-19} x2={22} y2={0} />
        <rect className="monitor-stand" x={12} y={-27} width={2.5} height={5} />
        <rect className="monitor" x={5} y={-39} width={17} height={12.5} rx={1.5} />
        <g className="screen-lines">
          <line x1={8} y1={-35} x2={18} y2={-35} />
          <line x1={8} y1={-32} x2={15} y2={-32} />
        </g>
      </g>
      <g ref={walker} className="walker">
        {!empty && !standing && (
          <g className="person person--sit">
            <rect className="chair" x={-21} y={-14} width={11} height={3} rx={1} />
            <line className="chair-leg" x1={-15.5} y1={-11} x2={-15.5} y2={0} />
            <path className="legs" d="M-13 -15 L-4 -15 L-4 0" />
            <g className="torso-group">
              <rect className="torso" x={-19} y={-31} width={9.5} height={17} rx={4} />
              <circle className="head" cx={-14} cy={-37} r={5.5} />
              <g className="arm">
                <path d="M-12 -27 L-3 -22 L3 -22" />
              </g>
            </g>
          </g>
        )}
        {!empty && standing && (
          <g className="person person--stand">
            <path className="legs" d="M-16 -16 L-17 0 M-12 -16 L-11 0" />
            <rect className="torso" x={-19} y={-33} width={10} height={18} rx={4} />
            <circle className="head" cx={-14} cy={-39} r={5.5} />
            <g className="raised-arm">
              <path d="M-10 -30 L-4 -40 L-3 -47" />
            </g>
            <path className="arm-down" d="M-18 -29 L-22 -19" />
          </g>
        )}
        {standing ? (
          <g className="bubble" transform="translate(-2 -58)">
            <g className="bubble-inner">
              <path d="M-9 -9 h18 a3 3 0 0 1 3 3 v9 a3 3 0 0 1 -3 3 h-11 l-5 5 v-5 h-2 a3 3 0 0 1 -3 -3 v-9 a3 3 0 0 1 3 -3 z" />
              <text y={-1} textAnchor="middle" dominantBaseline="central" aria-hidden="true">
                !
              </text>
            </g>
          </g>
        ) : (
          <g className="badge" transform="translate(-14 -52)">
            <circle r={7} />
            <text textAnchor="middle" dominantBaseline="central" aria-hidden="true">
              {CHARACTER_GLYPH[state]}
            </text>
          </g>
        )}
        {sparkle && (
          <g className="sparkle" transform="translate(-14 -44)" aria-hidden="true">
            <path d="M0 -12 L2 -2 L12 0 L2 2 L0 12 L-2 2 L-12 0 L-2 -2 Z" />
            <circle cx={9} cy={-9} r={1.6} />
            <circle cx={-9} cy={8} r={1.3} />
          </g>
        )}
      </g>
    </g>
  );
}

export const AgentCharacter = memo(AgentCharacterImpl);
