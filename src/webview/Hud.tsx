import { memo } from 'react';
import type { CityState, HookStatus } from '../models/CityState';
import { computeCounts } from '../models/CityState';
import { PHASE_GLYPH, SOURCE_LABEL, clockTime } from './format';
import { computeHighlights } from './highlights';
import { postToExtension } from './vscodeApi';

interface Props {
  state: CityState;
  onFocusSession: (sessionId: string) => void;
  onFocusWorkspace: (workspaceId: string) => void;
}

export function hookBadge(h: HookStatus | undefined): { text: string; cls: string; title: string } {
  if (!h || h.bridge === 'disabled') return { text: 'HOOKS OFF', cls: 'off', title: 'Live event bridge disabled (claudeCity.hookBridge.enabled)' };
  if (h.bridge === 'unavailable') return { text: 'HOOKS ✕', cls: 'error', title: `Live event bridge unavailable: ${h.error ?? 'unknown'}` };
  if (h.bridge === 'starting') return { text: 'HOOKS …', cls: 'off', title: 'Live event bridge starting' };
  if (h.install === 'current') return { text: 'HOOKS', cls: 'on', title: `Live events on 127.0.0.1:${h.port ?? '?'}` };
  if (h.install === 'outdated') return { text: 'HOOKS ⚠', cls: 'warn', title: 'Hooks installed with an old port/token - reinstall' };
  return { text: 'HOOKS –', cls: 'off', title: 'Bridge running, hooks not installed (polling only)' };
}

/** Top heads-up display: counts, highlights, LIVE indicator, data sources. */
function HudImpl({ state, onFocusSession, onFocusWorkspace }: Props) {
  const c = computeCounts(state);
  const h = computeHighlights(state);
  const hb = hookBadge(state.hooks);
  const items: { key: string; label: string; value: number; glyph: string }[] = [
    { key: 'workspaces', label: 'Companies', value: c.workspaces, glyph: '⌂' },
    { key: 'sessions', label: 'Sessions', value: c.sessions, glyph: '▦' },
    { key: 'working', label: 'Working', value: h.working, glyph: PHASE_GLYPH.working },
    { key: 'idle', label: 'Idle', value: h.idle, glyph: PHASE_GLYPH.idle },
    { key: 'done', label: 'Done', value: c.done, glyph: PHASE_GLYPH.done },
    { key: 'failed', label: 'Failed', value: c.failed, glyph: PHASE_GLYPH.failed },
  ];
  const first = h.attention[0];
  return (
    <header className="hud glass" aria-label="City status">
      <div className="hud-brand">
        <span className="hud-logo" aria-hidden="true">
          ◈
        </span>
        <span className="hud-title">Claude City</span>
      </div>
      <ul className="hud-counts">
        {items.map((i) => (
          <li key={i.key} className={`hud-count hud-count--${i.key}`} title={i.label}>
            <span className="hud-glyph" aria-hidden="true">
              {i.glyph}
            </span>
            <span className="hud-value">{i.value}</span>
            <span className="hud-label">{i.label}</span>
          </li>
        ))}
        {c.recent > 0 && (
          <li className="hud-count hud-recent" title="Recent sessions: not running, still in Claude Code's session list (not counted above)">
            <span className="hud-glyph" aria-hidden="true">
              {PHASE_GLYPH.resting}
            </span>
            <span className="hud-value">{c.recent}</span>
            <span className="hud-label">recent</span>
          </li>
        )}
        {c.archived > 0 && (
          <li className="hud-count hud-archived" title="Archived past sessions (not counted above)">
            <span className="hud-glyph" aria-hidden="true">
              {PHASE_GLYPH.archived}
            </span>
            <span className="hud-value">{c.archived}</span>
            <span className="hud-label">archived</span>
          </li>
        )}
        {h.completedToday > 0 && (
          <li className="hud-count hud-count--completed" title="Tasks completed today (live events)">
            <span className="hud-glyph" aria-hidden="true">
              ✦
            </span>
            <span className="hud-value">{h.completedToday}</span>
            <span className="hud-label">completed today</span>
          </li>
        )}
      </ul>
      <div className="hud-highlights">
        {first && (
          <button
            className="attention-button"
            onClick={() => onFocusSession(first.id)}
            aria-label={`${h.attention.length} session${h.attention.length === 1 ? ' needs' : 's need'} your attention. Show ${first.name ?? 'session'}`}
          >
            <span aria-hidden="true">❗</span> {h.attention.length} need{h.attention.length === 1 ? 's' : ''} your attention
          </button>
        )}
        {h.mostActive && (
          <button
            className="link-button hud-most-active"
            onClick={() => onFocusWorkspace(h.mostActive!.id)}
            title="Most active company"
            aria-label={`Most active company: ${h.mostActive.name}, ${h.mostActive.active} active sessions. Show it`}
          >
            <span aria-hidden="true">★</span> {h.mostActive.name}
          </button>
        )}
      </div>
      <div className="hud-right">
        <span className={`source-badge source--${state.source}`} title={state.error ?? SOURCE_LABEL[state.source]} role="status">
          {state.source === 'live' && <span className="live-dot" aria-hidden="true" />}
          {SOURCE_LABEL[state.source]}
        </span>
        <span className={`source-badge hook-badge hook--${hb.cls}`} title={hb.title} aria-label={hb.title}>
          {hb.text}
        </span>
        <span className="hud-updated" title="Last update">
          {clockTime(state.updatedAt)}
        </span>
        <button
          className="icon-button"
          onClick={() => postToExtension({ type: 'importWorkspaces' })}
          aria-label="Import workspaces from folder"
          title="Import Workspaces from Folder…"
        >
          ⊕
        </button>
        <button className="icon-button" onClick={() => postToExtension({ type: 'refresh' })} aria-label="Refresh" title="Refresh">
          ⟳
        </button>
        <button
          className="icon-button"
          onClick={() => postToExtension({ type: 'toggleDemo' })}
          aria-label={state.source === 'demo' ? 'Hide demo data' : 'Show demo data'}
          title={state.source === 'demo' ? 'Hide demo data' : 'Show demo data'}
          aria-pressed={state.source === 'demo'}
        >
          ⚗
        </button>
      </div>
    </header>
  );
}

export const Hud = memo(HudImpl);
