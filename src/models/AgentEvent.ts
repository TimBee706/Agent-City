import { SessionPhase } from './Session';

/**
 * Normalized kinds of Claude Code hook events (phase 3). Names follow the hook event names in the
 * Claude Code docs (SessionStart -> session-start, ...). `tool-use` covers PreToolUse/PostToolUse.
 */
export type HookEventKind =
  | 'session-start'
  | 'session-end'
  | 'subagent-start'
  | 'subagent-stop'
  | 'task-created'
  | 'task-completed'
  | 'stop'
  | 'stop-failure'
  | 'notification'
  | 'teammate-idle'
  | 'worktree-create'
  | 'worktree-remove'
  | 'tool-use';

export const HOOK_EVENT_KINDS: readonly HookEventKind[] = [
  'session-start',
  'session-end',
  'subagent-start',
  'subagent-stop',
  'task-created',
  'task-completed',
  'stop',
  'stop-failure',
  'notification',
  'teammate-idle',
  'worktree-create',
  'worktree-remove',
  'tool-use',
];

/** Events synthesized from polling diffs. */
export type DiffEventType = 'session.appeared' | 'session.phaseChanged' | 'session.disappeared';

export type AgentEventType = DiffEventType | HookEventKind;

export type AgentEventSource = 'diff' | 'hook' | 'demo';

export interface AgentEvent {
  id: string;
  type: AgentEventType;
  timestamp: number;
  sessionId: string;
  /** City agent id: `${sessionId}:main` or `${sessionId}:${hookAgentId}`. */
  agentId?: string;
  workspaceId?: string;
  source: AgentEventSource;
  /** Short human readable text (rendered as plain text). */
  message: string;
  from?: SessionPhase;
  to?: SessionPhase;
  /** Hook-specific extras, e.g. tool name, notification type, end reason. */
  detail?: string;
  /** Subagent type (SubagentStart/Stop) - e.g. "Explore". */
  agentType?: string;
  /** Task id / subject (TaskCreated/TaskCompleted). */
  taskId?: string;
  task?: string;
  /** Teammate name (agent teams). */
  teammate?: string;
  /** Working directory reported by the hook (used to map unknown sessions to a workspace). */
  cwd?: string;
}

export function isHookEvent(e: Pick<AgentEvent, 'source'>): boolean {
  return e.source === 'hook';
}

/**
 * Secondary dedupe key: same type/session/agent/task within the same 1s bucket counts as duplicate.
 */
export function eventDedupeKey(
  e: Pick<AgentEvent, 'type' | 'sessionId' | 'agentId' | 'timestamp' | 'taskId'>,
  bucketMs = 1000,
): string {
  return `${e.type}|${e.sessionId}|${e.agentId ?? ''}|${e.taskId ?? ''}|${Math.floor(e.timestamp / bucketMs)}`;
}
