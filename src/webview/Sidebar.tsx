import type { CityState } from '../models/CityState';
import { computeCounts } from '../models/CityState';
import { PHASE_GLYPH, SOURCE_LABEL } from './format';
import { computeHighlights } from './highlights';
import { hookBadge } from './Hud';
import { postToExtension } from './vscodeApi';

interface Props {
  state: CityState;
}

/** City legend (window colours + basement boxes), shown in the sidebar. */
export const LEGEND: readonly { cls: string; text: string }[] = [
  { cls: 'sw-working', text: 'Window: working' },
  { cls: 'sw-waiting', text: 'Window: waiting for you ("!" over the door)' },
  { cls: 'sw-idle', text: 'Window: idle' },
  { cls: 'sw-resting', text: 'Window: recent (not running)' },
  { cls: 'sw-done', text: 'Window: done' },
  { cls: 'sw-failed', text: 'Window: failed' },
  { cls: 'sw-archive', text: 'Box in the basement strip: archived session' },
];

/** Compact activity-bar overview: counts, hook status, legend + Open City. */
export function Sidebar({ state }: Props) {
  const c = computeCounts(state);
  const h = computeHighlights(state);
  const hb = hookBadge(state.hooks);
  const hooks = state.hooks;
  const offerInstall = hooks?.bridge === 'running' && (hooks.install === 'none' || hooks.install === 'outdated');
  const tiles: { key: string; label: string; value: number; glyph: string }[] = [
    { key: 'workspaces', label: 'Workspaces', value: c.workspaces, glyph: '⌂' },
    { key: 'sessions', label: 'Sessions', value: c.sessions, glyph: '▦' },
    { key: 'working', label: 'Working', value: c.working, glyph: PHASE_GLYPH.working },
    { key: 'waiting', label: 'Waiting', value: c.waiting, glyph: PHASE_GLYPH.waiting },
    { key: 'done', label: 'Done', value: c.done, glyph: PHASE_GLYPH.done },
    { key: 'failed', label: 'Failed', value: c.failed, glyph: PHASE_GLYPH.failed },
  ];
  return (
    <main className="sidebar">
      <div className="sidebar-source">
        <span className={`source-badge source--${state.source}`} role="status">
          {state.source === 'live' && <span className="live-dot" aria-hidden="true" />}
          {SOURCE_LABEL[state.source]}
        </span>
        <span className={`source-badge hook-badge hook--${hb.cls}`} title={hb.title} aria-label={hb.title}>
          {hb.text}
        </span>
        {state.cliVersion && <span className="muted small">claude {state.cliVersion}</span>}
      </div>
      {state.source === 'loading' && (
        <p className="muted small" role="status">
          Loading Claude sessions…
        </p>
      )}
      {state.error && <p className="sidebar-error small">{state.error}</p>}
      {h.attention.length > 0 && (
        <button className="attention-button wide" onClick={() => postToExtension({ type: 'openCity' })}>
          <span aria-hidden="true">❗</span> {h.attention.length} need{h.attention.length === 1 ? 's' : ''} your attention
        </button>
      )}
      <ul className="tiles" aria-label="Session counts">
        {tiles.map((t) => (
          <li key={t.key} className={`tile tile--${t.key}`}>
            <span className="tile-glyph" aria-hidden="true">
              {t.glyph}
            </span>
            <span className="tile-value">{t.value}</span>
            <span className="tile-label">{t.label}</span>
          </li>
        ))}
      </ul>
      {c.recent > 0 && (
        <p className="sidebar-recent" title="Not running, still in Claude Code's session list (not counted above)">
          <span aria-hidden="true">{PHASE_GLYPH.resting}</span> {c.recent} recent session{c.recent === 1 ? '' : 's'}
        </p>
      )}
      {c.archived > 0 && (
        <p className="sidebar-archived" title="Past sessions imported from local transcripts (not counted above)">
          <span aria-hidden="true">{PHASE_GLYPH.archived}</span> {c.archived} archived session{c.archived === 1 ? '' : 's'}
        </p>
      )}
      <section className="legend" aria-label="Legend">
        <h3 className="detail-subtitle">Legend</h3>
        <ul className="legend-list">
          {LEGEND.map((l) => (
            <li key={l.cls}>
              <span className={`legend-swatch ${l.cls}`} aria-hidden="true" />
              {l.text}
            </li>
          ))}
        </ul>
        <p className="muted small legend-hint">Double-click a house (or press Enter) to go inside: rooms upstairs, archive boxes in the basement.</p>
      </section>
      <button className="primary-button wide" onClick={() => postToExtension({ type: 'openCity' })}>
        Open City
      </button>
      <button className="secondary-button wide" onClick={() => postToExtension({ type: 'importWorkspaces' })}>
        Import Workspaces from Folder…
      </button>
      <div className="sidebar-actions">
        <button className="secondary-button" onClick={() => postToExtension({ type: 'refresh' })}>
          Refresh
        </button>
        <button
          className="secondary-button"
          onClick={() => postToExtension({ type: 'toggleDemo' })}
          aria-pressed={state.source === 'demo'}
        >
          {state.source === 'demo' ? 'Hide demo' : 'Demo data'}
        </button>
      </div>
      {offerInstall && (
        <div className="hook-offer">
          <p className="small">
            {hooks?.install === 'outdated'
              ? 'Live event hooks use an old port or token.'
              : 'Get live subagent, task and attention events by adding Claude City hooks to your Claude settings.'}
          </p>
          <button className="secondary-button wide" onClick={() => postToExtension({ type: 'installHooks' })}>
            {hooks?.install === 'outdated' ? 'Reinstall hooks…' : 'Install live event hooks…'}
          </button>
        </div>
      )}
      {hooks?.bridge === 'unavailable' && (
        <p className="sidebar-error small" role="note">
          Live events unavailable: {hooks.error ?? 'unknown'}. Polling still works.
        </p>
      )}
    </main>
  );
}
