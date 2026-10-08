import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT,
  isAttentionNotification,
  parseHookPayload,
  sanitizeId,
  sanitizeSessionId,
  sanitizeText,
} from '../../src/backend/hookPayload';

const SID = '3f2a9c1e-1111-4222-8333-444455556666';
const base = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID,
  transcript_path: '/tmp/t.jsonl',
  cwd: 'C:\\repo\\app',
  hook_event_name: event,
  ...extra,
});

function ok(raw: unknown) {
  const r = parseHookPayload(raw, 1_700_000_000_000);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.event;
}

describe('parseHookPayload - event mapping', () => {
  it('SessionStart', () => {
    const e = ok(base('SessionStart', { source: 'startup', model: 'x' }));
    expect(e).toMatchObject({ type: 'session-start', sessionId: SID, agentId: `${SID}:main`, source: 'hook', detail: 'startup', cwd: 'C:\\repo\\app' });
    expect(e.message).toBe('Session started (startup)');
    expect(e.timestamp).toBe(1_700_000_000_000);
  });
  it('SessionEnd uses reason', () => {
    expect(ok(base('SessionEnd', { reason: 'prompt_input_exit' }))).toMatchObject({ type: 'session-end', detail: 'prompt_input_exit' });
  });
  it('SubagentStart / SubagentStop map to a per-session agent id with type', () => {
    const s = ok(base('SubagentStart', { agent_id: 'agent-abc123', agent_type: 'Explore' }));
    expect(s).toMatchObject({ type: 'subagent-start', agentId: `${SID}:agent-abc123`, agentType: 'Explore' });
    expect(s.message).toBe('Explore subagent started');
    const t = ok(base('SubagentStop', { agent_id: 'agent-abc123', agent_type: 'Explore', last_assistant_message: 'secret stuff' }));
    expect(t).toMatchObject({ type: 'subagent-stop', agentId: `${SID}:agent-abc123` });
    expect(JSON.stringify(t)).not.toContain('secret stuff');
  });
  it('TaskCreated / TaskCompleted with subject and teammate', () => {
    const c = ok(base('TaskCreated', { task_id: 'task-001', task_subject: 'Implement auth', teammate_name: 'implementer' }));
    expect(c).toMatchObject({ type: 'task-created', taskId: 'task-001', task: 'Implement auth', teammate: 'implementer' });
    expect(c.message).toBe('Task created: Implement auth (implementer)');
    const d = ok(base('TaskCompleted', { task_id: 'task-001', task_name: 'Legacy name' }));
    expect(d).toMatchObject({ type: 'task-completed', task: 'Legacy name' });
  });
  it('Notification keeps type and message', () => {
    const n = ok(base('Notification', { notification_type: 'permission_prompt', message: 'Bash wants to run: npm test' }));
    expect(n).toMatchObject({ type: 'notification', detail: 'permission_prompt' });
    expect(n.message).toBe('Needs attention: Bash wants to run: npm test');
    expect(isAttentionNotification(n)).toBe(true);
    expect(isAttentionNotification(ok(base('Notification', { notification_type: 'auth_success' })))).toBe(false);
  });
  it('Stop, StopFailure, TeammateIdle, Worktree*, tool use', () => {
    expect(ok(base('Stop')).type).toBe('stop');
    expect(ok(base('StopFailure', { error_type: 'rate_limit' }))).toMatchObject({ type: 'stop-failure', detail: 'rate_limit' });
    expect(ok(base('TeammateIdle', { teammate_name: 'researcher' }))).toMatchObject({ type: 'teammate-idle', teammate: 'researcher' });
    expect(ok(base('WorktreeCreate', { name: 'feature-x' }))).toMatchObject({ type: 'worktree-create', detail: 'feature-x' });
    expect(ok(base('WorktreeRemove', { worktree_path: '/w/x' }))).toMatchObject({ type: 'worktree-remove' });
    const t = ok(base('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa' } }));
    expect(t).toMatchObject({ type: 'tool-use', detail: 'Bash' });
    expect(JSON.stringify(t)).not.toContain('id_rsa');
    expect(ok(base('PostToolUse', { tool_name: 'Edit' })).message).toBe('Main agent used Edit');
  });
});

describe('parseHookPayload - malformed input', () => {
  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 42, 'x', [], [base('Stop')]]) {
      expect(parseHookPayload(raw, 1)).toEqual({ ok: false, reason: 'not-object' });
    }
  });
  it('rejects unknown / prototype event names', () => {
    for (const ev of ['UserPromptSubmit', 'toString', '__proto__', 'constructor', '', undefined]) {
      expect(parseHookPayload(base(ev as string), 1)).toEqual({ ok: false, reason: 'unknown-event' });
    }
  });
  it('rejects missing or unsafe session ids', () => {
    for (const sid of [undefined, '', 'a b', '../../etc', 'x'.repeat(129), 5, { a: 1 }, 'id?x=1']) {
      expect(parseHookPayload({ ...base('Stop'), session_id: sid }, 1)).toEqual({ ok: false, reason: 'missing-session' });
    }
  });
  it('missing optional fields fall back gracefully', () => {
    const e = ok({ session_id: SID, hook_event_name: 'TaskCreated' });
    expect(e.message).toBe('Task created: untitled');
    expect(e.cwd).toBeUndefined();
    const s = ok({ session_id: SID, hook_event_name: 'SubagentStart' });
    expect(s.agentId).toBe(`${SID}:main`); // no agent id -> cannot create a subagent
    expect(s.message).toBe('Subagent subagent started');
  });
  it('drops unsafe agent ids and wrong types', () => {
    const e = ok(base('SubagentStart', { agent_id: '<script>', agent_type: 42 }));
    expect(e.agentId).toBe(`${SID}:main`);
    expect(e.agentType).toBeUndefined();
  });
  it('truncates oversized strings and strips control characters', () => {
    const e = ok(base('Notification', { message: 'a\u0000b\u202e' + 'x'.repeat(5000), notification_type: 'idle_prompt' }));
    expect(e.message.length).toBeLessThanOrEqual('Needs attention: '.length + MAX_TEXT);
    expect(e.message).not.toMatch(/[\u0000\u202e]/);
    expect(e.message.endsWith('…')).toBe(true);
  });
  it('generates unique ids', () => {
    expect(ok(base('Stop')).id).not.toBe(ok(base('Stop')).id);
  });
});

describe('sanitizers', () => {
  it('sanitizeText', () => {
    expect(sanitizeText('  hi\n\tthere ')).toBe('hi there');
    expect(sanitizeText('')).toBeUndefined();
    expect(sanitizeText(3)).toBeUndefined();
    expect(sanitizeText('abcdef', 4)).toBe('abc…');
  });
  it('sanitizeId / sanitizeSessionId', () => {
    expect(sanitizeId('agent-1.a:b_c')).toBe('agent-1.a:b_c');
    expect(sanitizeId('a/b')).toBeUndefined();
    expect(sanitizeSessionId('abc-123_X')).toBe('abc-123_X');
    expect(sanitizeSessionId('a.b')).toBeUndefined();
  });
});
