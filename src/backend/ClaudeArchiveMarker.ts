import * as fs from 'fs';
import * as path from 'path';
import { isValidSessionId } from '../shared/sessionLinks';

/**
 * Best-effort reader for the "archived" flag of the official Claude Code VS Code extension.
 *
 * UNSTABLE / UNDOCUMENTED INTERNALS - isolated on purpose:
 *  - Claude Code (VS Code extension `anthropic.claude-code`, observed in 2.1.2xx) keeps the ids of
 *    sessions archived in its session list (manually, or automatically after
 *    `claudeCode.archiveInactiveSessions` days) in its extension globalState under the key
 *    `hiddenSessionIds` (`getArchivedSessionIds()` in its bundle).
 *  - VS Code stores every extension's globalState as one JSON value in the SQLite database
 *    `<user data>/User/globalStorage/state.vscdb`, table `ItemTable(key TEXT, value BLOB)`, row key
 *    = extension id (`Anthropic.claude-code`).
 *
 * Extensions cannot read each other's globalState through the API, so the database file is read
 * directly (read-only, whole file into memory, size-capped) with a tiny pure-JS SQLite b-tree reader
 * - no native module, no write access, no locking. If anything does not match the expected shape,
 * the marker is reported as unavailable and Claude City falls back to the age rule.
 * Only session ids are extracted - nothing else from that database is kept.
 */

export const CLAUDE_CODE_STATE_KEY = 'anthropic.claude-code';
export const ARCHIVED_IDS_PROPERTY = 'hiddenSessionIds';
/** state.vscdb files above this size are not read (typical: 1-5 MB). */
export const MAX_DB_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVED_IDS = 20_000;
const MAX_PAGES_VISITED = 200_000;

// ------------------------------------------------------------------------------------ SQLite

interface Db {
  buf: Buffer;
  pageSize: number;
  usable: number;
  pageCount: number;
}

function openDb(buf: Buffer): Db | undefined {
  if (buf.length < 100 || buf.toString('latin1', 0, 16) !== 'SQLite format 3\u0000') return undefined;
  const raw = buf.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return undefined;
  const reserved = buf[20];
  const encoding = buf.readUInt32BE(56);
  if (encoding !== 0 && encoding !== 1) return undefined; // only UTF-8 databases
  return { buf, pageSize, usable: pageSize - reserved, pageCount: Math.floor(buf.length / pageSize) };
}

/** Reads a SQLite varint. Returns [value, bytesUsed]. Values beyond 2^53 lose precision (irrelevant here). */
export function readVarint(buf: Buffer, pos: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (pos + i >= buf.length) throw new RangeError('varint out of range');
    const b = buf[pos + i];
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return [v, i + 1];
  }
  if (pos + 8 >= buf.length) throw new RangeError('varint out of range');
  return [v * 256 + buf[pos + 8], 9];
}

function pageOffset(db: Db, page: number): number {
  if (!Number.isInteger(page) || page < 1 || page > db.pageCount) throw new RangeError('bad page number');
  return (page - 1) * db.pageSize;
}

/** Full payload of a table-leaf cell (follows overflow pages). */
function cellPayload(db: Db, cellPos: number, visited: { n: number }): Buffer {
  const { buf, usable } = db;
  let p = cellPos;
  const [payloadLen, a] = readVarint(buf, p);
  p += a;
  const [, b] = readVarint(buf, p); // rowid
  p += b;
  const maxLocal = usable - 35;
  if (payloadLen <= maxLocal) return buf.subarray(p, p + payloadLen);
  const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  let local = minLocal + ((payloadLen - minLocal) % (usable - 4));
  if (local > maxLocal) local = minLocal;
  const parts: Buffer[] = [buf.subarray(p, p + local)];
  let remaining = payloadLen - local;
  let next = buf.readUInt32BE(p + local);
  while (remaining > 0 && next !== 0) {
    if (++visited.n > MAX_PAGES_VISITED) throw new RangeError('too many pages');
    const off = pageOffset(db, next);
    const take = Math.min(remaining, usable - 4);
    parts.push(buf.subarray(off + 4, off + 4 + take));
    remaining -= take;
    next = buf.readUInt32BE(off);
  }
  if (remaining > 0) throw new RangeError('truncated overflow chain');
  return Buffer.concat(parts);
}

type SqlValue = null | number | string | Buffer;

/** Decodes a record (row) into column values. TEXT is decoded as UTF-8, BLOB kept as Buffer. */
export function decodeRecord(payload: Buffer): SqlValue[] {
  const [headerLen, h] = readVarint(payload, 0);
  if (headerLen > payload.length) throw new RangeError('bad record header');
  const types: number[] = [];
  let p = h;
  while (p < headerLen) {
    const [t, n] = readVarint(payload, p);
    types.push(t);
    p += n;
  }
  const out: SqlValue[] = [];
  let d = headerLen;
  for (const t of types) {
    if (t === 0) out.push(null);
    else if (t >= 1 && t <= 6) {
      const len = [0, 1, 2, 3, 4, 6, 8][t];
      out.push(len <= 6 ? payload.readIntBE(d, len) : Number(payload.readBigInt64BE(d)));
      d += len;
    } else if (t === 7) {
      out.push(payload.readDoubleBE(d));
      d += 8;
    } else if (t === 8 || t === 9) out.push(t - 8);
    else if (t >= 12) {
      const len = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
      if (d + len > payload.length) throw new RangeError('record value out of range');
      const bytes = payload.subarray(d, d + len);
      out.push(t % 2 === 0 ? bytes : bytes.toString('utf8'));
      d += len;
    } else throw new RangeError('reserved serial type');
  }
  return out;
}

/** Visits every row of the table b-tree rooted at `root` (depth first, cycle safe). */
function walkTable(db: Db, root: number, visit: (row: SqlValue[]) => boolean | void, visited: { n: number }): boolean {
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const page = stack.pop()!;
    if (seen.has(page)) throw new RangeError('b-tree cycle');
    seen.add(page);
    if (++visited.n > MAX_PAGES_VISITED) throw new RangeError('too many pages');
    const base = pageOffset(db, page);
    const hdr = page === 1 ? base + 100 : base;
    const type = db.buf[hdr];
    const cells = db.buf.readUInt16BE(hdr + 3);
    if (type === 0x05) {
      const children: number[] = [];
      for (let i = 0; i < cells; i++) children.push(db.buf.readUInt32BE(base + db.buf.readUInt16BE(hdr + 12 + i * 2)));
      children.push(db.buf.readUInt32BE(hdr + 8));
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    } else if (type === 0x0d) {
      for (let i = 0; i < cells; i++) {
        const cellPos = base + db.buf.readUInt16BE(hdr + 8 + i * 2);
        if (visit(decodeRecord(cellPayload(db, cellPos, visited))) === true) return true;
      }
    } else {
      throw new RangeError(`unexpected page type ${type}`);
    }
  }
  return false;
}

/** Root page of a table from sqlite_master (case-insensitive name). */
function tableRoot(db: Db, name: string, visited: { n: number }): number | undefined {
  let root: number | undefined;
  walkTable(
    db,
    1,
    (row) => {
      if (row[0] === 'table' && typeof row[1] === 'string' && row[1].toLowerCase() === name.toLowerCase() && typeof row[3] === 'number') {
        root = row[3];
        return true;
      }
      return false;
    },
    visited,
  );
  return root;
}

/**
 * Reads the value of `key` (case-insensitive) from a VS Code `ItemTable` in a SQLite database image.
 * Returns undefined if the file is not a readable SQLite database, has no ItemTable or no such key.
 * Never throws.
 */
export function readItemTableValue(buf: Buffer, key: string): string | undefined {
  try {
    const db = openDb(buf);
    if (!db) return undefined;
    const visited = { n: 0 };
    const root = tableRoot(db, 'ItemTable', visited);
    if (root === undefined) return undefined;
    const wanted = key.toLowerCase();
    let value: string | undefined;
    walkTable(
      db,
      root,
      (row) => {
        if (typeof row[0] === 'string' && row[0].toLowerCase() === wanted) {
          const v = row[1];
          value = typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
          return true;
        }
        return false;
      },
      visited,
    );
    return value;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------ marker

/** Extracts the archived session ids from the Claude Code globalState JSON. undefined = unexpected shape. */
export function parseArchivedSessionIds(json: string | undefined): Set<string> | undefined {
  if (json === undefined) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const list = (o as Record<string, unknown>)[ARCHIVED_IDS_PROPERTY];
  if (list === undefined) return new Set(); // nothing archived yet
  if (!Array.isArray(list)) return undefined;
  const ids = new Set<string>();
  for (const id of list.slice(0, MAX_ARCHIVED_IDS)) if (isValidSessionId(id)) ids.add(id.toLowerCase());
  return ids;
}

export interface ArchiveMarker {
  /** False if the marker could not be read (no Claude Code extension state, unknown format, ...). */
  available: boolean;
  /** Archived Claude session ids (lower case). Empty when unavailable. */
  ids: ReadonlySet<string>;
  /** Short diagnostic reason when unavailable (no paths, no content). */
  reason?: string;
}

export const UNAVAILABLE_MARKER: ArchiveMarker = { available: false, ids: new Set(), reason: 'disabled' };

export interface MarkerFs {
  stat(file: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(file: string): Promise<Buffer>;
}

const nodeMarkerFs: MarkerFs = {
  stat: (f) => fs.promises.stat(f),
  readFile: (f) => fs.promises.readFile(f),
};

/** `state.vscdb` next to this extension's own global storage folder (`.../User/globalStorage/<ext id>`). */
export function stateDbPathFromGlobalStorage(globalStorageFsPath: string | undefined): string | undefined {
  if (!globalStorageFsPath) return undefined;
  return path.join(path.dirname(globalStorageFsPath), 'state.vscdb');
}

/**
 * Reads Claude Code's archived session ids from VS Code's global state database. The file is only
 * re-read when its mtime or size changed. Never throws.
 */
export class ClaudeArchiveMarkerReader {
  private cache: { mtimeMs: number; size: number; marker: ArchiveMarker } | undefined;
  private readonly fs: MarkerFs;

  constructor(
    private readonly dbPath: string | undefined,
    opts: { fs?: MarkerFs; maxBytes?: number } = {},
  ) {
    this.fs = opts.fs ?? nodeMarkerFs;
    this.maxBytes = opts.maxBytes ?? MAX_DB_BYTES;
  }

  private readonly maxBytes: number;

  async read(): Promise<ArchiveMarker> {
    if (!this.dbPath) return { available: false, ids: new Set(), reason: 'no state database path' };
    let st: { mtimeMs: number; size: number };
    try {
      st = await this.fs.stat(this.dbPath);
    } catch {
      return { available: false, ids: new Set(), reason: 'state database not found' };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.marker;
    let marker: ArchiveMarker;
    if (st.size > this.maxBytes) marker = { available: false, ids: new Set(), reason: 'state database too large' };
    else {
      try {
        const buf = await this.fs.readFile(this.dbPath);
        const ids = parseArchivedSessionIds(readItemTableValue(buf, CLAUDE_CODE_STATE_KEY));
        marker = ids ? { available: true, ids } : { available: false, ids: new Set(), reason: 'no Claude Code archive state' };
      } catch {
        marker = { available: false, ids: new Set(), reason: 'state database not readable' };
      }
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, marker };
    return marker;
  }
}
