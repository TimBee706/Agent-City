import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session } from '../models/Session';
import { isValidSessionId } from '../shared/sessionLinks';
import { mapLimit } from '../util/concurrency';
import { TranscriptMeta, parseTranscriptChunks } from './transcriptParser';
import type { MementoLike } from './WorkspaceRegistry';

/**
 * Best-effort import of past Claude Code sessions from `~/.claude/projects/<project>/<session-id>.jsonl`.
 * Thin fs layer around the pure `transcriptParser`: lists top-level transcripts, filters by mtime,
 * reads only the first and last 64 KB of each file and caches the extracted metadata keyed by
 * path + mtime + size (in memory, optionally persisted in a memento). Never throws.
 */

export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 64 * 1024;
/** Hard cap on transcript files read per scan (newest by mtime). */
export const MAX_SCAN_FILES = 2000;
/** Hard cap on imported sessions per scan (newest by last activity). */
export const MAX_IMPORTED_SESSIONS = 2000;
/** Hard cap on stat() calls while listing (protects against huge ~/.claude/projects folders). */
export const MAX_CANDIDATES = 10_000;
export const MAX_PROJECT_DIRS = 500;
export const DEFAULT_CONCURRENCY = 8;
export const CACHE_KEY = 'claudeCity.historyCache.v1';
export const MAX_PERSISTED_ENTRIES = 2000;
const DAY_MS = 86_400_000;

export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Minimal async fs surface (injectable for tests). */
export interface HistoryFs {
  readdir(dir: string): Promise<DirEntryLike[]>;
  stat(file: string): Promise<{ mtimeMs: number; size: number }>;
  /** Reads up to `length` bytes at `position`. */
  readRange(file: string, position: number, length: number): Promise<Buffer>;
}

export const nodeHistoryFs: HistoryFs = {
  readdir: (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
  stat: (file) => fs.promises.stat(file),
  async readRange(file, position, length) {
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
};

/** Extracted, display-safe metadata of one past session. */
export interface HistoricalSessionInfo {
  sessionId: string;
  cwd: string;
  startedAt?: number;
  lastActivityAt: number;
  gitBranch?: string;
  title?: string;
  version?: string;
  subagentCount?: number;
}

export interface HistoryScanOptions {
  maxAgeDays: number;
  maxFiles?: number;
  maxSessions?: number;
  concurrency?: number;
}

export interface HistoryScanStats {
  projectDirs: number;
  /** Transcript files found (valid session-id file names). */
  candidates: number;
  /** Files within maxAgeDays and the file cap (read or served from cache). */
  scanned: number;
  /** Files actually read (cache misses). */
  parsed: number;
  cacheHits: number;
  /** Files that could not be read or contained no usable entry. */
  failures: number;
  /** Files without a cwd (cannot be grouped into a workspace). */
  skippedNoCwd: number;
  imported: number;
  bytesRead: number;
  durationMs: number;
}

export interface HistoryScanResult {
  sessions: HistoricalSessionInfo[];
  stats: HistoryScanStats;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null = file had no usable metadata (cached negative result). */
  info: HistoricalSessionInfo | null;
}

export interface ScannerOptions {
  claudeHome?: string;
  fs?: HistoryFs;
  now?: () => number;
  /** If given, the metadata cache is persisted here (small, capped). */
  memento?: MementoLike;
}

function isValidInfo(v: unknown): v is HistoricalSessionInfo {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    isValidSessionId(o.sessionId) &&
    typeof o.cwd === 'string' &&
    o.cwd.length > 0 &&
    typeof o.lastActivityAt === 'number' &&
    Number.isFinite(o.lastActivityAt) &&
    (o.title === undefined || (typeof o.title === 'string' && o.title.length <= 200)) &&
    (o.gitBranch === undefined || typeof o.gitBranch === 'string') &&
    (o.startedAt === undefined || typeof o.startedAt === 'number') &&
    (o.subagentCount === undefined || typeof o.subagentCount === 'number')
  );
}

/**
 * Converts extracted metadata to an archived city session (no workspace assigned yet, no tier =
 * archived). The importer uses `toHistorySession` (historyTiers.ts) to assign recent / archived.
 */
export function toArchivedSession(info: HistoricalSessionInfo): Session {
  const s: Session = {
    id: info.sessionId,
    sessionId: info.sessionId,
    cwd: info.cwd,
    kind: 'history',
    state: 'unknown',
    status: 'unknown',
    origin: 'history',
    lastActivityAt: info.lastActivityAt,
  };
  if (info.title) s.name = info.title;
  if (info.startedAt !== undefined) s.startedAt = info.startedAt;
  if (info.gitBranch) s.gitBranch = info.gitBranch;
  if (info.subagentCount !== undefined) s.subagentCount = info.subagentCount;
  return s;
}

export class HistoricalSessionScanner {
  private readonly root: string;
  private readonly fs: HistoryFs;
  private readonly now: () => number;
  private readonly memento: MementoLike | undefined;
  private cache = new Map<string, CacheEntry>();
  private cacheDirty = false;

  constructor(opts: ScannerOptions = {}) {
    this.root = path.join(opts.claudeHome ?? path.join(os.homedir(), '.claude'), 'projects');
    this.fs = opts.fs ?? nodeHistoryFs;
    this.now = opts.now ?? Date.now;
    this.memento = opts.memento;
    this.loadCache();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private loadCache(): void {
    try {
      const stored = this.memento?.get<unknown>(CACHE_KEY);
      if (!Array.isArray(stored)) return;
      for (const e of stored.slice(0, MAX_PERSISTED_ENTRIES)) {
        if (!Array.isArray(e) || e.length !== 4) continue;
        const [file, mtimeMs, size, info] = e as unknown[];
        if (typeof file !== 'string' || typeof mtimeMs !== 'number' || typeof size !== 'number') continue;
        if (info !== null && !isValidInfo(info)) continue;
        this.cache.set(file, { mtimeMs, size, info: info as HistoricalSessionInfo | null });
      }
    } catch {
      this.cache.clear();
    }
  }

  /** Persists the (pruned) metadata cache if it changed. Never rejects. */
  async persist(): Promise<void> {
    if (!this.memento || !this.cacheDirty) return;
    this.cacheDirty = false;
    const entries = [...this.cache.entries()]
      .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
      .slice(0, MAX_PERSISTED_ENTRIES)
      .map(([file, e]) => [file, e.mtimeMs, e.size, e.info]);
    try {
      await this.memento.update(CACHE_KEY, entries);
    } catch {
      this.cacheDirty = true;
    }
  }

  /** Drops the in-memory and persisted cache (e.g. when the import is switched off). */
  async clear(): Promise<void> {
    this.cache.clear();
    this.cacheDirty = false;
    try {
      await this.memento?.update(CACHE_KEY, []);
    } catch {
      /* ignore */
    }
  }

  async scan(opts: HistoryScanOptions): Promise<HistoryScanResult> {
    const started = this.now();
    const stats: HistoryScanStats = {
      projectDirs: 0,
      candidates: 0,
      scanned: 0,
      parsed: 0,
      cacheHits: 0,
      failures: 0,
      skippedNoCwd: 0,
      imported: 0,
      bytesRead: 0,
      durationMs: 0,
    };
    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    const maxFiles = Math.max(0, opts.maxFiles ?? MAX_SCAN_FILES);
    const maxSessions = Math.max(0, opts.maxSessions ?? MAX_IMPORTED_SESSIONS);
    const maxAgeMs = Math.max(1, Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : 90) * DAY_MS;
    const cutoff = this.now() - maxAgeMs;

    // 1. list top-level transcripts (+ remember per-session subfolders for subagent counts)
    let dirs: string[] = [];
    try {
      dirs = (await this.fs.readdir(this.root))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .slice(0, MAX_PROJECT_DIRS);
    } catch {
      stats.durationMs = this.now() - started;
      return { sessions: [], stats };
    }
    stats.projectDirs = dirs.length;
    const listed = await mapLimit(dirs, concurrency, async (d) => {
      const dir = path.join(this.root, d);
      try {
        const entries = await this.fs.readdir(dir);
        const subdirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
        return entries
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => e.name.slice(0, -'.jsonl'.length))
          .filter((id) => isValidSessionId(id))
          .map((id) => ({ id, file: path.join(dir, `${id}.jsonl`), subdir: subdirs.has(id) ? path.join(dir, id) : undefined }));
      } catch {
        return [];
      }
    });
    const candidates = listed.flat().slice(0, MAX_CANDIDATES);
    stats.candidates = candidates.length;

    // 2. stat + age filter + newest-first cap (no file content read yet)
    const statted = await mapLimit(candidates, concurrency, async (c) => {
      try {
        const st = await this.fs.stat(c.file);
        return { ...c, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return undefined;
      }
    });
    const fresh = statted
      .filter((c): c is NonNullable<typeof c> => !!c && c.mtimeMs >= cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1))
      .slice(0, maxFiles);
    stats.scanned = fresh.length;

    // 3. read head/tail (cache miss only) and parse
    const seen = new Set<string>();
    const infos = await mapLimit(fresh, concurrency, async (c) => {
      seen.add(c.file);
      const cached = this.cache.get(c.file);
      if (cached && cached.mtimeMs === c.mtimeMs && cached.size === c.size) {
        stats.cacheHits++;
        return cached.info;
      }
      stats.parsed++;
      let info: HistoricalSessionInfo | null = null;
      try {
        const meta = await this.readMeta(c.file, c.size, stats);
        if (meta.entries === 0) stats.failures++;
        else if (!meta.cwd) stats.skippedNoCwd++;
        else {
          info = {
            sessionId: c.id,
            cwd: meta.cwd,
            lastActivityAt: meta.lastActivityAt ?? Math.round(c.mtimeMs),
          };
          if (meta.startedAt !== undefined) info.startedAt = meta.startedAt;
          if (meta.gitBranch) info.gitBranch = meta.gitBranch;
          if (meta.title) info.title = meta.title;
          if (meta.version) info.version = meta.version;
          if (c.subdir) {
            const n = await this.countSubagents(c.subdir);
            if (n !== undefined) info.subagentCount = n;
          }
        }
      } catch {
        stats.failures++;
      }
      this.cache.set(c.file, { mtimeMs: c.mtimeMs, size: c.size, info });
      this.cacheDirty = true;
      return info;
    });

    // Prune cache entries for files no longer in scope.
    for (const k of [...this.cache.keys()]) {
      if (!seen.has(k)) {
        this.cache.delete(k);
        this.cacheDirty = true;
      }
    }

    // 4. dedupe by session id (newest wins), newest first, global cap
    const bySession = new Map<string, HistoricalSessionInfo>();
    for (const i of infos) {
      if (!i) continue;
      const prev = bySession.get(i.sessionId);
      if (!prev || i.lastActivityAt > prev.lastActivityAt) bySession.set(i.sessionId, i);
    }
    const sessions = [...bySession.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.sessionId < b.sessionId ? -1 : 1))
      .slice(0, maxSessions);
    stats.imported = sessions.length;
    stats.durationMs = this.now() - started;
    return { sessions, stats };
  }

  /** Reads only the head and tail of a transcript (never the whole file if it is large). */
  private async readMeta(file: string, size: number, stats: HistoryScanStats): Promise<TranscriptMeta> {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = await this.fs.readRange(file, 0, Math.max(0, size));
      stats.bytesRead += buf.length;
      return parseTranscriptChunks({ head: buf.toString('utf8'), headIsWholeFile: true });
    }
    const head = await this.fs.readRange(file, 0, HEAD_BYTES);
    const tail = await this.fs.readRange(file, size - TAIL_BYTES, TAIL_BYTES);
    stats.bytesRead += head.length + tail.length;
    return parseTranscriptChunks({ head: head.toString('utf8'), headIsWholeFile: false, tail: tail.toString('utf8') });
  }

  private async countSubagents(sessionDir: string): Promise<number | undefined> {
    try {
      const entries = await this.fs.readdir(path.join(sessionDir, 'subagents'));
      return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).length;
    } catch {
      return undefined;
    }
  }
}
