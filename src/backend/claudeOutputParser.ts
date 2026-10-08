import { Session, normalizeSession } from '../models/Session';

export interface ParseResult {
  sessions: Session[];
  /** Number of entries that were ignored because they were malformed. */
  malformed: number;
  /** False if the text did not look like any supported format at all. */
  recognized: boolean;
}

const WRAPPER_KEYS = ['agents', 'sessions', 'items', 'data', 'results'];

function entriesFromValue(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of WRAPPER_KEYS) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
    // Single session object (e.g. one NDJSON line).
    if ('sessionId' in o || 'cwd' in o || 'id' in o || 'pid' in o) return [o];
    // Any array-valued property as a last resort.
    for (const v of Object.values(o)) if (Array.isArray(v)) return v;
  }
  return undefined;
}

/**
 * Parses the output of `claude agents --json [--all]`.
 * Accepts: a JSON array (current CLI format), an object wrapping an array
 * ({agents:[...]}, {sessions:[...]}, ...), or NDJSON (one object or array per line).
 * Malformed entries are skipped individually; duplicates (same id) keep the last occurrence.
 */
export function parseAgentsOutput(text: string): ParseResult {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return { sessions: [], malformed: 0, recognized: true };

  let entries: unknown[] | undefined;
  let malformed = 0;
  try {
    entries = entriesFromValue(JSON.parse(trimmed));
  } catch {
    entries = undefined;
  }

  if (!entries) {
    // NDJSON fallback.
    entries = [];
    let anyLine = false;
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        const parsed = entriesFromValue(JSON.parse(l));
        if (parsed) {
          anyLine = true;
          entries.push(...parsed);
        } else {
          malformed++;
        }
      } catch {
        malformed++;
      }
    }
    if (!anyLine) return { sessions: [], malformed, recognized: false };
  }

  const byId = new Map<string, Session>();
  for (const entry of entries) {
    const s = normalizeSession(entry);
    if (s) byId.set(s.id, s);
    else malformed++;
  }
  return { sessions: [...byId.values()], malformed, recognized: true };
}
