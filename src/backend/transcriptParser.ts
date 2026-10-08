/**
 * Pure, best-effort metadata extraction from Claude Code transcript JSONL chunks
 * (`~/.claude/projects/<encoded-project>/<session-id>.jsonl`).
 *
 * The transcript format is NOT a stable API, so everything here is tolerant: unknown entry types are
 * ignored, malformed / truncated lines are skipped, and nothing ever throws. Only a few metadata
 * fields are extracted; message content is never kept except for a short, sanitized title candidate.
 *
 * Observed structure (Claude Code 2.x, keys only):
 *  - conversation entries (`type` user / assistant / attachment / system) carry
 *    `cwd`, `sessionId`, `timestamp` (ISO string), `gitBranch`, `version`, `isSidechain`, `isMeta`
 *  - `user.message.content` is a string or an array of parts (`text`, `tool_result`, `image`, ...)
 *  - title entries without timestamp: `custom-title` {customTitle}, `ai-title` {aiTitle},
 *    `agent-name` {agentName}, `last-prompt` {lastPrompt}; older versions: `summary` {summary}
 *  - other entry types (queue-operation, mode, file-history-snapshot, cost-state, ...) are ignored
 */
import { parseTimestamp } from '../models/Session';

export const TITLE_MAX = 80;
const MAX_FIELD = 300;

export type TitleSource = 'custom' | 'ai' | 'summary' | 'agent' | 'prompt' | 'last-prompt';

export interface TranscriptMeta {
  cwd?: string;
  /** First timestamp found (epoch ms). */
  startedAt?: number;
  /** Last (max) timestamp found (epoch ms). */
  lastActivityAt?: number;
  gitBranch?: string;
  version?: string;
  title?: string;
  titleSource?: TitleSource;
  /** Number of lines that parsed as JSON objects (diagnostics only). */
  entries: number;
  /** Number of complete lines that failed to parse (diagnostics only). */
  malformed: number;
}

export interface TranscriptChunks {
  /** Text from the start of the file. */
  head: string;
  /** True if `head` ends at the real end of the file (no truncated last line). */
  headIsWholeFile: boolean;
  /** Text from the end of the file (undefined if `head` already covers it). */
  tail?: string;
}

// C0/C1 controls and bidi overrides/isolates - never shown in titles.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Makes untrusted text a safe single-line title (whitespace collapsed, controls removed, max length). */
export function sanitizeTitle(raw: unknown, max = TITLE_MAX): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.slice(0, 4000).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  return t.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function shortString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= MAX_FIELD ? t : undefined;
}

/** Text of a user prompt if it is a real, human-typed prompt; undefined for meta / tool / injected content. */
export function promptText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'user') return undefined;
  if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true) return undefined;
  if (entry.isVisibleInTranscriptOnly === true || entry.toolUseResult !== undefined) return undefined;
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return undefined;
  const m = msg as Record<string, unknown>;
  if (m.role !== undefined && m.role !== 'user') return undefined;
  let text: string | undefined;
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) {
    if (m.content.some((p) => p && typeof p === 'object' && (p as Record<string, unknown>).type === 'tool_result')) return undefined;
    for (const p of m.content) {
      if (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text') {
        const t = (p as Record<string, unknown>).text;
        // Skip leading injected parts (e.g. <ide_...> context) and take the first real text part.
        if (typeof t === 'string' && t.trim() && !isInjected(t)) {
          text = t;
          break;
        }
      }
    }
  }
  if (typeof text !== 'string' || !text.trim() || isInjected(text)) return undefined;
  return text;
}

/** System-injected / command content starts with a tag like `<command-name>` or `<local-command-stdout>`. */
function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted');
}

/** Splits a chunk into complete lines, dropping partial first / last lines when the chunk was cut. */
export function completeLines(chunk: string, cutAtStart: boolean, cutAtEnd: boolean): string[] {
  const lines = chunk.split('\n');
  if (cutAtStart) lines.shift();
  if (cutAtEnd) lines.pop();
  return lines;
}

interface Acc {
  meta: TranscriptMeta;
  custom?: string;
  ai?: string;
  summary?: string;
  agent?: string;
  prompt?: string;
  lastPrompt?: string;
}

function visit(acc: Acc, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed[0] !== '{') {
    acc.meta.malformed++;
    return;
  }
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    acc.meta.malformed++;
    return;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    acc.meta.malformed++;
    return;
  }
  const e = o as Record<string, unknown>;
  const m = acc.meta;
  m.entries++;
  const ts = parseTimestamp(e.timestamp);
  if (ts !== undefined) {
    if (m.startedAt === undefined || ts < m.startedAt) m.startedAt = ts;
    if (m.lastActivityAt === undefined || ts > m.lastActivityAt) m.lastActivityAt = ts;
  }
  // Sidechain (subagent) entries may carry another cwd/branch; prefer the main conversation.
  if (e.isSidechain !== true) {
    const cwd = shortString(e.cwd);
    if (cwd && !m.cwd) m.cwd = cwd;
    const branch = shortString(e.gitBranch);
    if (branch) m.gitBranch = branch; // last wins
    const version = shortString(e.version);
    if (version) m.version = version;
  }
  switch (e.type) {
    case 'custom-title':
      acc.custom = sanitizeTitle(e.customTitle) ?? acc.custom;
      break;
    case 'ai-title':
      acc.ai = sanitizeTitle(e.aiTitle) ?? acc.ai;
      break;
    case 'summary':
      acc.summary = sanitizeTitle(e.summary) ?? acc.summary;
      break;
    case 'agent-name':
      acc.agent = sanitizeTitle(e.agentName) ?? acc.agent;
      break;
    case 'last-prompt': {
      const t = typeof e.lastPrompt === 'string' && !isInjected(e.lastPrompt) ? sanitizeTitle(e.lastPrompt) : undefined;
      acc.lastPrompt = t ?? acc.lastPrompt;
      break;
    }
    case 'user':
      if (!acc.prompt) {
        const t = promptText(e);
        if (t) acc.prompt = sanitizeTitle(t);
      }
      break;
    default:
      break;
  }
}

/**
 * Extracts metadata from the head (and optional tail) of a transcript. Later entries win for
 * titles / branch, the first prompt is taken from the head. Title priority:
 * custom title > AI title > summary > agent name > first real prompt > last prompt.
 */
export function parseTranscriptChunks(chunks: TranscriptChunks): TranscriptMeta {
  const acc: Acc = { meta: { entries: 0, malformed: 0 } };
  const headLines = completeLines(chunks.head ?? '', false, !chunks.headIsWholeFile);
  for (const l of headLines) visit(acc, l);
  if (chunks.tail !== undefined) {
    // The tail is always cut at its start; its end is the real end of the file.
    for (const l of completeLines(chunks.tail, true, false)) visit(acc, l);
  }
  const m = acc.meta;
  const candidates: [TitleSource, string | undefined][] = [
    ['custom', acc.custom],
    ['ai', acc.ai],
    ['summary', acc.summary],
    ['agent', acc.agent],
    ['prompt', acc.prompt],
    ['last-prompt', acc.lastPrompt],
  ];
  for (const [source, title] of candidates) {
    if (title) {
      m.title = title;
      m.titleSource = source;
      break;
    }
  }
  return m;
}
