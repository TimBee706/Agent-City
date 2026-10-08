/**
 * Pure parsing/mapping of Claude Code hook payloads (JSON POSTed by `type: "http"` hooks) to
 * AgentEvents. Everything in the payload is untrusted: strings are sanitized and truncated, ids are
 * restricted to a safe charset, unknown events are ignored.
 *
 * Evidence (https://code.claude.com/docs/en/hooks, verified 2026-10-08):
 *  - common input fields: session_id, transcript_path, cwd, hook_event_name, permission_mode;
 *    agent_id / agent_type are present when the hook fires inside a subagent.
 *  - SessionStart: source, model (command/mcp_tool hooks only - never installed by Claude City, parsed
 *    for legacy / manual setups) · SessionEnd: reason
 *  - SubagentStart / SubagentStop: agent_id, agent_type (Stop also last_assistant_message - ignored)
 *  - TaskCreated / TaskCompleted: task_id, task_subject, task_description?, teammate_name?
 *  - Notification: notification_type, message, title · TeammateIdle: teammate_name
 *  - StopFailure: error_type · WorktreeCreate: name · WorktreeRemove: worktree_path
 *  - PreToolUse / PostToolUse: tool_name (tool_input / tool_response are never read)
 */
import { AgentEvent, HookEventKind } from '../models/AgentEvent';

export const MAX_TEXT = 200;
export const MAX_ID = 128;

const EVENT_MAP: Record<string, HookEventKind> = {
  SessionStart: 'session-start',
  SessionEnd: 'session-end',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  TaskCreated: 'task-created',
  TaskCompleted: 'task-completed',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  Notification: 'notification',
  TeammateIdle: 'teammate-idle',
  WorktreeCreate: 'worktree-create',
  WorktreeRemove: 'worktree-remove',
  PreToolUse: 'tool-use',
  PostToolUse: 'tool-use',
};

/** Hook event names this module understands (docs names). */
export const SUPPORTED_HOOK_EVENTS = Object.keys(EVENT_MAP);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g;

/** Plain, single-line, trimmed, truncated text (rendered as text by React - never as HTML). */
export function sanitizeText(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Ids: [A-Za-z0-9._:-], 1..128 chars; anything else is rejected (undefined). */
export function sanitizeId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(t) ? t : undefined;
}

/** Session ids must be safe for URIs as well (no dots/colons). */
export function sanitizeSessionId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(t) ? t : undefined;
}

function sanitizePath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROL, '').trim();
  return t && t.length <= 1024 ? t : undefined;
}

export type HookParseResult =
  | { ok: true; event: AgentEvent }
  | { ok: false; reason: 'not-object' | 'unknown-event' | 'missing-session' };

let seq = 0;

/**
 * Maps one hook payload to an AgentEvent. `now` is the receive time (payloads carry no timestamp).
 */
export function parseHookPayload(raw: unknown, now: number): HookParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-object' };
  const p = raw as Record<string, unknown>;
  const eventName = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
  const kind = Object.prototype.hasOwnProperty.call(EVENT_MAP, eventName) ? EVENT_MAP[eventName] : undefined;
  if (!kind) return { ok: false, reason: 'unknown-event' };
  const sessionId = sanitizeSessionId(p.session_id);
  if (!sessionId) return { ok: false, reason: 'missing-session' };

  const hookAgentId = sanitizeId(p.agent_id);
  const agentType = sanitizeText(p.agent_type, 60);
  const cwd = sanitizePath(p.cwd);
  const teammate = sanitizeText(p.teammate_name, 60);
  const taskId = sanitizeId(p.task_id);
  const task = sanitizeText(p.task_subject) ?? sanitizeText(p.task_name);
  const agentId = hookAgentId ? `${sessionId}:${hookAgentId}` : `${sessionId}:main`;

  const e: AgentEvent = {
    id: `hook:${now}:${++seq}`,
    type: kind,
    timestamp: now,
    sessionId,
    agentId,
    source: 'hook',
    message: '',
  };
  if (cwd) e.cwd = cwd;
  if (agentType) e.agentType = agentType;
  if (teammate) e.teammate = teammate;
  if (taskId) e.taskId = taskId;
  if (task) e.task = task;

  const who = hookAgentId ? `${agentType ?? 'Subagent'}` : 'Main agent';
  switch (kind) {
    case 'session-start': {
      const source = sanitizeText(p.source, 30);
      if (source) e.detail = source;
      e.agentId = `${sessionId}:main`;
      e.message = `Session started${source ? ` (${source})` : ''}`;
      break;
    }
    case 'session-end': {
      const reason = sanitizeText(p.reason, 40);
      if (reason) e.detail = reason;
      e.agentId = `${sessionId}:main`;
      e.message = `Session ended${reason ? ` (${reason})` : ''}`;
      break;
    }
    case 'subagent-start':
      e.message = `${agentType ?? 'Subagent'} subagent started`;
      break;
    case 'subagent-stop':
      e.message = `${agentType ?? 'Subagent'} subagent finished`;
      break;
    case 'task-created':
      e.message = `Task created: ${task ?? taskId ?? 'untitled'}${teammate ? ` (${teammate})` : ''}`;
      break;
    case 'task-completed':
      e.message = `Task completed: ${task ?? taskId ?? 'untitled'}${teammate ? ` (${teammate})` : ''}`;
      break;
    case 'stop':
      e.message = `${who} finished responding`;
      break;
    case 'stop-failure': {
      const err = sanitizeText(p.error_type, 40);
      if (err) e.detail = err;
      e.message = `Turn failed${err ? `: ${err}` : ''}`;
      break;
    }
    case 'notification': {
      const type = sanitizeText(p.notification_type, 40);
      const msg = sanitizeText(p.message) ?? sanitizeText(p.title);
      if (type) e.detail = type;
      e.message = `Needs attention: ${msg ?? type ?? 'notification'}`;
      break;
    }
    case 'teammate-idle':
      e.message = `${teammate ?? agentType ?? 'Teammate'} is idle`;
      break;
    case 'worktree-create': {
      const name = sanitizeText(p.name, 80);
      if (name) e.detail = name;
      e.message = `Worktree created${name ? `: ${name}` : ''}`;
      break;
    }
    case 'worktree-remove': {
      const wt = sanitizeText(p.worktree_path, 120);
      if (wt) e.detail = wt;
      e.message = 'Worktree removed';
      break;
    }
    case 'tool-use': {
      const tool = sanitizeText(p.tool_name, 60);
      if (tool) e.detail = tool;
      e.message = `${who} ${eventName === 'PreToolUse' ? 'uses' : 'used'} ${tool ?? 'a tool'}`;
      break;
    }
  }
  return { ok: true, event: e };
}

/** Notification types that mean "the user has to do something". */
export const ATTENTION_NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

/** True if a notification event should flag the session as needing attention. */
export function isAttentionNotification(e: Pick<AgentEvent, 'type' | 'detail'>): boolean {
  return e.type === 'notification' && (!e.detail || ATTENTION_NOTIFICATION_TYPES.has(e.detail));
}
