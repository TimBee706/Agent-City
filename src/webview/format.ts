import type { CharacterState } from '../models/Agent';
import type { DataSource } from '../models/CityState';
import type { SessionPhase } from '../models/Session';

/** Glyphs so that state is never conveyed by color alone. */
export const PHASE_GLYPH: Record<SessionPhase, string> = {
  working: '▶',
  waiting: '!',
  idle: '…',
  done: '✓',
  failed: '✕',
  stopped: '■',
  unknown: '?',
  resting: 'z',
  archived: '▤',
};

export const PHASE_LABEL: Record<SessionPhase, string> = {
  working: 'working',
  waiting: 'waiting for input',
  idle: 'idle',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'unknown',
  resting: 'recent (not running)',
  archived: 'archived session',
};

export const CHARACTER_GLYPH: Record<CharacterState, string> = {
  working: '▶',
  busy: '▶▶',
  idle: '…',
  blocked: '!',
  done: '✓',
  failed: '✕',
  stopped: '■',
};

export const SOURCE_LABEL: Record<DataSource, string> = {
  live: 'LIVE',
  demo: 'DEMO',
  unavailable: 'CLI unavailable',
  error: 'ERROR',
  loading: 'LOADING',
};

export function relativeTime(ts: number | undefined, now: number): string {
  if (!ts) return 'unknown';
  const d = Math.max(0, now - ts);
  const s = Math.floor(d / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Truncates to `max` chars with an ellipsis (plain text, rendered via React). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + '…';
}
