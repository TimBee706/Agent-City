import { memo } from 'react';
import { CityFilters, DEFAULT_FILTERS, PHASE_FILTERS, PhaseFilter, TIER_FILTERS, TierFilter, togglePhase, toggleTier } from './filters';
import { PHASE_GLYPH } from './format';
import { VIEW_MODES, ViewMode } from './listModel';

const TIER_TEXT: Record<TierFilter, string> = { live: 'Live', recent: 'Recent', archived: 'Archived' };
const TIER_GLYPH: Record<TierFilter, string> = { live: '●', recent: PHASE_GLYPH.resting, archived: PHASE_GLYPH.archived };
const TIER_TITLE: Record<TierFilter, string> = {
  live: 'Sessions reported by claude agents (running or just finished)',
  recent: 'Not running, still in Claude Code\'s session list (resumable)',
  archived: 'Archived in Claude Code (without its archive marker: inactive longer than claudeCity.history.recentDays) - boxes in each building\'s basement',
};

interface Props {
  filters: CityFilters;
  onChange: (f: CityFilters) => void;
  hiddenWorkspaces: number;
  hiddenSessions: number;
  active: boolean;
  /** Map or list; the switch is only shown when a handler is given. */
  view?: ViewMode;
  onViewChange?: (view: ViewMode) => void;
}

const VIEW_TEXT: Record<ViewMode, string> = { city: 'City', list: 'List' };
const VIEW_GLYPH: Record<ViewMode, string> = { city: '⌂', list: '☰' };
const VIEW_TITLE: Record<ViewMode, string> = {
  city: 'Show the city map',
  list: 'Show companies, sessions and agents as a list that can be expanded',
};

const PHASE_TEXT: Record<PhaseFilter, string> = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** Search + filter bar for the city panel. */
function ToolbarImpl({ filters, onChange, hiddenWorkspaces, hiddenSessions, active, view = 'city', onViewChange }: Props) {
  return (
    <div className="toolbar glass" role="search" aria-label="Search and filter the city">
      {onViewChange && (
        <div className="view-switch" role="group" aria-label="View">
          {VIEW_MODES.map((m) => (
            <button key={m} className={`view-switch-button${view === m ? ' is-on' : ''}`} aria-pressed={view === m} title={VIEW_TITLE[m]} onClick={() => onViewChange(m)}>
              <span aria-hidden="true">{VIEW_GLYPH[m]}</span> {VIEW_TEXT[m]}
            </button>
          ))}
        </div>
      )}
      <input
        className="search-input"
        type="search"
        placeholder="Search companies, sessions, agents, paths, branches…"
        aria-label="Search companies, sessions (including archived titles and branches), agents or paths"
        value={filters.query}
        maxLength={200}
        onChange={(e) => onChange({ ...filters, query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && filters.query) {
            e.stopPropagation();
            onChange({ ...filters, query: '' });
          }
        }}
      />
      <div className="chip-group" role="group" aria-label="Filter by state">
        {PHASE_FILTERS.map((p) => {
          const on = filters.phases.includes(p);
          return (
            <button
              key={p}
              className={`chip chip--${p}${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange(togglePhase(filters, p))}
            >
              <span aria-hidden="true">{PHASE_GLYPH[p]}</span> {PHASE_TEXT[p]}
            </button>
          );
        })}
      </div>
      <label className="check">
        <input type="checkbox" checked={filters.hideInactive} onChange={(e) => onChange({ ...filters, hideInactive: e.target.checked })} />
        Hide inactive companies
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={filters.onlyWithSessions}
          onChange={(e) => onChange({ ...filters, onlyWithSessions: e.target.checked })}
        />
        Only with sessions
      </label>
      <div className="chip-group" role="group" aria-label="Filter by session tier (none selected = all)">
        {TIER_FILTERS.map((t) => {
          const on = filters.tiers.includes(t);
          return (
            <button
              key={t}
              className={`chip chip--tier-${t}${on ? ' is-on' : ''}`}
              aria-pressed={on}
              title={TIER_TITLE[t]}
              onClick={() => onChange(toggleTier(filters, t))}
            >
              <span aria-hidden="true">{TIER_GLYPH[t]}</span> {TIER_TEXT[t]}
            </button>
          );
        })}
      </div>
      {active && (
        <>
          <span className="muted small" role="status">
            {hiddenWorkspaces + hiddenSessions > 0
              ? `${hiddenWorkspaces} compan${hiddenWorkspaces === 1 ? 'y' : 'ies'}, ${hiddenSessions} session${hiddenSessions === 1 ? '' : 's'} hidden`
              : 'nothing hidden'}
          </span>
          <button className="link-button" onClick={() => onChange({ ...DEFAULT_FILTERS })}>
            Clear filters
          </button>
        </>
      )}
    </div>
  );
}

export const Toolbar = memo(ToolbarImpl);
