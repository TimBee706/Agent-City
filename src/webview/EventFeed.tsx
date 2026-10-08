import { memo } from 'react';
import type { AgentEvent } from '../models/AgentEvent';
import { PHASE_GLYPH, clockTime } from './format';
import { Select } from './selection';

interface Props {
  events: AgentEvent[];
  onSelect: Select;
}

const HOOK_GLYPH: Partial<Record<AgentEvent['type'], string>> = {
  'session-start': '+',
  'session-end': '−',
  'subagent-start': '↳',
  'subagent-stop': '↲',
  'task-created': '☐',
  'task-completed': '✓',
  stop: '■',
  'stop-failure': '✕',
  notification: '!',
  'teammate-idle': '…',
  'worktree-create': '⑂',
  'worktree-remove': '⑂',
  'tool-use': '⚙',
};

function glyphFor(e: AgentEvent): string {
  switch (e.type) {
    case 'session.appeared':
      return '+';
    case 'session.disappeared':
      return '−';
    case 'session.phaseChanged':
      return e.to ? PHASE_GLYPH[e.to] : '•';
    default:
      return HOOK_GLYPH[e.type] ?? '•';
  }
}

/**
 * Newest-first activity feed. Not an aria-live region itself (too chatty with hooks); important
 * events are announced through the throttled live region in App.
 */
function EventFeedImpl({ events, onSelect }: Props) {
  return (
    <section className="event-feed glass" aria-label="Activity feed">
      <h2 className="panel-title">Activity</h2>
      {events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <ol className="event-list">
          {events.map((e) => (
            <li
              key={e.id}
              className={`event event--${e.type.replace('.', '-')}${e.to ? ` event-to--${e.to}` : ''}${e.source === 'hook' ? ' event--hook' : ''}`}
            >
              <button
                className="event-button"
                onClick={() =>
                  onSelect(
                    e.agentId && e.source === 'hook' && !e.agentId.endsWith(':main')
                      ? { kind: 'agent', id: e.agentId }
                      : { kind: 'session', id: e.sessionId },
                  )
                }
              >
                <span className="event-glyph" aria-hidden="true">
                  {glyphFor(e)}
                </span>
                <span className="event-message">{e.message}</span>
                <time className="event-time" dateTime={new Date(e.timestamp).toISOString()}>
                  {clockTime(e.timestamp)}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export const EventFeed = memo(EventFeedImpl);
