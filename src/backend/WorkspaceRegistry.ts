import { Session } from '../models/Session';
import { CityWorkspace, WORKSPACE_SOURCES, Workspace, WorkspaceSource } from '../models/Workspace';
import { stableId } from '../util/hash';
import { displayName, isSameOrChildKey, normalizePathKey } from './pathUtils';

/** Subset of vscode.Memento - keeps this module free of vscode imports. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Key kept at v1: entries from older versions are migrated in place (missing fields get defaults). */
export const REGISTRY_KEY = 'claudeCity.workspaces.v1';
/** Normalized path keys the user removed from the city ("Remove from City"); root rescans skip them. */
export const EXCLUSIONS_KEY = 'claudeCity.workspaceExclusions.v1';
export const UNASSIGNED_WORKSPACE_ID = 'unassigned';
/** Soft cap: only unpinned, auto-discovered, session-less entries are pruned (oldest first). */
export const MAX_ENTRIES = 1000;
const MAX_EXCLUSIONS = 5000;
const LAST_SEEN_WRITE_GRANULARITY_MS = 60_000;

/** Sources that were added automatically (and may be pruned when unpinned and unused). */
const AUTO_SOURCES: ReadonlySet<WorkspaceSource> = new Set(['open', 'session', 'history']);
/** Sources the user added explicitly (always pinned, never pruned). */
const USER_SOURCES: ReadonlySet<WorkspaceSource> = new Set(['imported', 'manual']);

export interface WorkspaceRegistryOptions {
  now?: () => number;
  /** Home directory; it (and drive roots) never act as a prefix anchor, only exact match. */
  homeDir?: string;
}

export interface RootSyncResult {
  /** Workspaces newly added to the registry. */
  added: number;
  /** Found folders that were already registered (now imported/pinned). */
  known: number;
  /** Found folders skipped because the user removed them earlier. */
  excluded: number;
  /** Imported workspaces of this root that are now marked missing. */
  missing: number;
  /** Workspaces whose missing flag flipped (plus added ones) - 0 = nothing visible changed. */
  changed: number;
}

/**
 * Validates and migrates a stored entry. Entries from versions before `source`/`pinned` existed
 * keep all their data and become `source: 'session'`, unpinned (the only way they could have been
 * created besides open folders / discovery, which are equivalent for pruning).
 */
export function migrateStoredWorkspace(w: unknown): { ws: Workspace; migrated: boolean } | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const o = w as Record<string, unknown>;
  if (
    typeof o.id !== 'string' ||
    typeof o.path !== 'string' ||
    !o.path.trim() ||
    typeof o.name !== 'string' ||
    typeof o.firstSeen !== 'number' ||
    typeof o.lastSeen !== 'number'
  ) {
    return undefined;
  }
  const validSource = WORKSPACE_SOURCES.includes(o.source as WorkspaceSource);
  const source: WorkspaceSource = validSource ? (o.source as WorkspaceSource) : 'session';
  const ws: Workspace = {
    id: o.id,
    path: o.path,
    name: o.name,
    firstSeen: o.firstSeen,
    lastSeen: o.lastSeen,
    source,
    pinned: o.pinned === true || USER_SOURCES.has(source),
  };
  if (typeof o.root === 'string' && o.root.trim()) ws.root = o.root;
  if (o.missing === true) ws.missing = true;
  return { ws, migrated: !validSource || typeof o.pinned !== 'boolean' };
}

export function workspaceIdForPath(path: string): string {
  return 'w' + stableId(normalizePathKey(path));
}

/**
 * Persistent registry of known workspaces (companies/buildings) in globalState.
 * Every registered workspace is shown in the city. Sessions are grouped to the workspace whose path
 * is the longest prefix of the session cwd; otherwise a new workspace is created from the cwd.
 */
export class WorkspaceRegistry {
  private readonly byKey = new Map<string, Workspace>();
  private openKeys = new Set<string>();
  /** Keys that had live / archived sessions in the last grouping (protected from pruning). */
  private liveKeys = new Set<string>();
  private historyKeys = new Set<string>();
  private readonly exclusions = new Set<string>();
  private dirty = false;
  private exclusionsDirty = false;
  private readonly now: () => number;
  private readonly homeKey: string | undefined;

  constructor(
    private readonly memento: MementoLike,
    opts: WorkspaceRegistryOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.homeKey = opts.homeDir ? normalizePathKey(opts.homeDir) : undefined;
    const stored = memento.get<unknown>(REGISTRY_KEY);
    if (Array.isArray(stored)) {
      for (const raw of stored) {
        const m = migrateStoredWorkspace(raw);
        if (!m) continue;
        this.byKey.set(normalizePathKey(m.ws.path), m.ws);
        if (m.migrated) this.dirty = true; // persist the migrated shape on the next flush
      }
    }
    const excl = memento.get<unknown>(EXCLUSIONS_KEY);
    if (Array.isArray(excl)) {
      for (const k of excl) if (typeof k === 'string' && k.trim()) this.exclusions.add(normalizePathKey(k));
    }
  }

  all(): Workspace[] {
    return [...this.byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.byKey.size;
  }

  isOpen(id: string): boolean {
    for (const k of this.openKeys) if (this.byKey.get(k)?.id === id) return true;
    return false;
  }

  findById(id: string): Workspace | undefined {
    for (const w of this.byKey.values()) if (w.id === id) return w;
    return undefined;
  }

  /** Exact (normalized) path lookup. */
  findByPath(path: string): Workspace | undefined {
    return this.byKey.get(normalizePathKey(path));
  }

  /** Registers (or touches) a workspace path and returns its entry. */
  register(path: string, source: WorkspaceSource = 'session'): Workspace {
    const key = normalizePathKey(path);
    const now = this.now();
    const existing = this.byKey.get(key);
    if (existing) {
      if (now - existing.lastSeen >= LAST_SEEN_WRITE_GRANULARITY_MS) {
        existing.lastSeen = now;
        this.dirty = true;
      }
      return existing;
    }
    const ws: Workspace = {
      id: workspaceIdForPath(path),
      path: path.trim(),
      name: displayName(path.trim()),
      firstSeen: now,
      lastSeen: now,
      source,
      pinned: USER_SOURCES.has(source),
    };
    this.byKey.set(key, ws);
    this.dirty = true;
    this.prune();
    return ws;
  }

  /**
   * Registers a folder found under an import root (pinned, source 'imported'). Already known entries
   * are upgraded in place (id/history kept). Unpinned auto entries strictly below it (session /
   * history cwds such as `repo/src`) are absorbed so their sessions land in this building.
   * Returns undefined if the path was excluded by the user (unless `force`, which clears the exclusion).
   */
  registerImported(path: string, root: string, opts: { force?: boolean } = {}): { ws: Workspace; added: boolean } | undefined {
    const key = normalizePathKey(path);
    if (this.isExcluded(path)) {
      if (!opts.force) return undefined;
      this.clearExclusion(path);
    }
    let ws = this.byKey.get(key);
    let added = false;
    if (ws) {
      if (ws.source !== 'manual' && ws.source !== 'imported') ws.source = 'imported';
      if (!ws.pinned || ws.root !== root || ws.missing) {
        ws.pinned = true;
        ws.root = root;
        delete ws.missing;
      }
      this.dirty = true;
    } else {
      const now = this.now();
      ws = {
        id: workspaceIdForPath(path),
        path: path.trim(),
        name: displayName(path.trim()),
        firstSeen: now,
        lastSeen: now,
        source: 'imported',
        pinned: true,
        root,
      };
      this.byKey.set(key, ws);
      this.dirty = true;
      added = true;
    }
    for (const [k, other] of [...this.byKey]) {
      if (k === key || !isSameOrChildKey(key, k)) continue;
      if (other.pinned || !AUTO_SOURCES.has(other.source) || this.openKeys.has(k)) continue;
      this.byKey.delete(k);
    }
    if (added) this.prune();
    return { ws, added };
  }

  /**
   * Applies a root rescan: new folders are imported (exclusions respected), imported workspaces of
   * this root whose folder is gone are marked missing (not deleted), re-appearing ones are unmarked.
   */
  syncRoot(root: string, foundPaths: readonly string[]): RootSyncResult {
    const rootKey = normalizePathKey(root);
    const res: RootSyncResult = { added: 0, known: 0, excluded: 0, missing: 0, changed: 0 };
    const found = new Set<string>();
    for (const p of foundPaths) {
      const key = normalizePathKey(p);
      found.add(key);
      const existing = this.byKey.get(key);
      if (existing && existing.root !== undefined && normalizePathKey(existing.root) === rootKey && existing.pinned && !existing.missing) {
        res.known++; // fast path: nothing to change
        continue;
      }
      const r = this.registerImported(p, existing?.root && normalizePathKey(existing.root) !== rootKey ? existing.root : root);
      if (!r) res.excluded++;
      else if (r.added) {
        res.added++;
        res.changed++;
      } else {
        res.known++;
        res.changed++; // upgraded to imported, re-rooted or no longer missing
      }
    }
    for (const [k, ws] of this.byKey) {
      if (ws.source !== 'imported' || !ws.root || normalizePathKey(ws.root) !== rootKey) continue;
      // The root itself (single-project import) exists - we are scanning it.
      const missing = k !== rootKey && !found.has(k);
      if (missing) res.missing++;
      if (!!ws.missing !== missing) {
        if (missing) ws.missing = true;
        else delete ws.missing;
        this.dirty = true;
        res.changed++;
      }
    }
    // Known folders take the fast path above, so auto entries that were (re-)registered below an
    // imported building since the import (e.g. by project discovery) are absorbed here.
    res.changed += this.absorbCoveredAutoEntries();
    return res;
  }

  /** The imported / manual workspace strictly above `key`, if any (longest match). */
  private coveringUserWorkspace(key: string): Workspace | undefined {
    let best: { key: string; ws: Workspace } | undefined;
    for (const [k, ws] of this.byKey) {
      if (k === key || !USER_SOURCES.has(ws.source) || !this.isAnchorable(k)) continue;
      if (isSameOrChildKey(k, key) && (!best || k.length > best.key.length)) best = { key: k, ws };
    }
    return best?.ws;
  }

  /**
   * Removes unpinned auto entries (session / history / discovered, not open in VS Code) that lie
   * strictly below an imported or manual workspace, so their sessions are grouped into that building
   * instead of a duplicate one (e.g. `C:\VSO\Wardow\Wardow` below the imported `C:\VSO\Wardow`).
   * Returns the number of removed entries.
   */
  absorbCoveredAutoEntries(): number {
    let removed = 0;
    for (const [k, ws] of [...this.byKey]) {
      if (ws.pinned || !AUTO_SOURCES.has(ws.source) || this.openKeys.has(k)) continue;
      if (!this.coveringUserWorkspace(k)) continue;
      this.byKey.delete(k);
      removed++;
    }
    if (removed) this.dirty = true;
    return removed;
  }

  /** Root folder itself is gone: mark all its imported workspaces missing. Returns how many changed. */
  markRootMissing(root: string): number {
    const rootKey = normalizePathKey(root);
    let n = 0;
    for (const ws of this.byKey.values()) {
      if (ws.source !== 'imported' || !ws.root || normalizePathKey(ws.root) !== rootKey) continue;
      if (!ws.missing) {
        ws.missing = true;
        this.dirty = true;
        n++;
      }
    }
    return n;
  }

  /** Imported workspaces that came from `root`. */
  workspacesOfRoot(root: string): Workspace[] {
    const rootKey = normalizePathKey(root);
    return this.all().filter((w) => w.source === 'imported' && !!w.root && normalizePathKey(w.root) === rootKey);
  }

  /** Removes all workspaces imported from `root` (no exclusions: the root itself is gone). */
  removeByRoot(root: string): number {
    const ids = this.workspacesOfRoot(root);
    for (const w of ids) this.byKey.delete(normalizePathKey(w.path));
    if (ids.length) this.dirty = true;
    return ids.length;
  }

  /**
   * Removes a workspace from the city and remembers its path as excluded, so root rescans, discovery
   * and archived sessions do not bring it back (a live Claude session there still does).
   */
  remove(id: string): Workspace | undefined {
    for (const [k, ws] of this.byKey) {
      if (ws.id !== id) continue;
      this.byKey.delete(k);
      this.dirty = true;
      this.addExclusion(k);
      return ws;
    }
    return undefined;
  }

  setPinned(id: string, pinned: boolean): boolean {
    const ws = this.findById(id);
    if (!ws) return false;
    // Imported/manual workspaces are always pinned.
    const next = pinned || USER_SOURCES.has(ws.source);
    if (ws.pinned !== next) {
      ws.pinned = next;
      this.dirty = true;
    }
    return true;
  }

  private addExclusion(key: string): void {
    if (this.exclusions.has(key)) return;
    this.exclusions.add(key);
    while (this.exclusions.size > MAX_EXCLUSIONS) this.exclusions.delete(this.exclusions.values().next().value as string);
    this.exclusionsDirty = true;
  }

  clearExclusion(path: string): void {
    if (this.exclusions.delete(normalizePathKey(path))) this.exclusionsDirty = true;
  }

  /** True if `path` equals or lies below a folder the user removed from the city. */
  isExcluded(path: string): boolean {
    if (!this.exclusions.size) return false;
    const key = normalizePathKey(path);
    if (this.exclusions.has(key)) return true;
    for (const e of this.exclusions) if (isSameOrChildKey(e, key)) return true;
    return false;
  }

  get exclusionCount(): number {
    return this.exclusions.size;
  }

  /** Replaces the set of VS Code workspace folders currently open. */
  setOpenFolders(paths: readonly string[]): void {
    this.openKeys = new Set(paths.map((p) => normalizePathKey(this.register(p, 'open').path)));
  }

  /**
   * Registers historical project paths (opt-in discovery). Excluded paths and paths inside an
   * imported / manual building (their sessions belong to that building) are skipped.
   */
  setHistoricalProjects(paths: readonly string[]): void {
    for (const p of paths) {
      if (this.isExcluded(p)) continue;
      const key = normalizePathKey(p);
      if (!this.byKey.has(key) && this.coveringUserWorkspace(key)) continue;
      this.register(p, 'history');
    }
    this.absorbCoveredAutoEntries();
  }

  private isAnchorable(key: string): boolean {
    if (this.homeKey && key === this.homeKey) return false;
    if (/^[a-z]:\/$/i.test(key) || key === '/' || key === '//') return false;
    return true;
  }

  /** Finds the registered workspace whose path is the longest prefix of `cwd`. */
  findForPath(cwd: string): Workspace | undefined {
    const key = normalizePathKey(cwd);
    const exact = this.byKey.get(key);
    if (exact) return exact;
    let best: { key: string; ws: Workspace } | undefined;
    for (const [k, ws] of this.byKey) {
      if (!this.isAnchorable(k)) continue;
      if (isSameOrChildKey(k, key) && (!best || k.length > best.key.length)) best = { key: k, ws };
    }
    return best?.ws;
  }

  /**
   * Assigns `workspaceId` to each session (returns new objects), registering new workspaces
   * for unknown cwds. Sessions without cwd are assigned to the "unassigned" pseudo workspace.
   * `touch: false` marks archived (history) grouping: lastSeen is not updated, and sessions whose
   * cwd only matches a folder the user removed from the city are dropped instead of re-adding it.
   */
  groupSessions(sessions: readonly Session[], opts: { touch?: boolean } = {}): Session[] {
    const touch = opts.touch !== false;
    const keys = new Set<string>();
    const out: Session[] = [];
    for (const s of sessions) {
      if (!s.cwd) {
        out.push({ ...s, workspaceId: UNASSIGNED_WORKSPACE_ID });
        continue;
      }
      let ws = this.findForPath(s.cwd);
      if (!ws) {
        if (!touch && this.isExcluded(s.cwd)) continue;
        ws = this.register(s.cwd, touch ? 'session' : 'history');
      }
      keys.add(normalizePathKey(ws.path));
      if (touch) this.touch(ws);
      out.push({ ...s, workspaceId: ws.id });
    }
    if (touch) this.liveKeys = keys;
    else this.historyKeys = keys;
    return out;
  }

  private touch(ws: Workspace): void {
    const now = this.now();
    if (now - ws.lastSeen >= LAST_SEEN_WRITE_GRANULARITY_MS) {
      ws.lastSeen = now;
      this.dirty = true;
    }
  }

  /**
   * Workspaces displayed in the city: every registry entry (always visible, with or without
   * sessions) plus the "Unassigned" pseudo workspace if needed.
   * Sorted deterministically: open first, then by name, then id (the webview layout re-sorts).
   */
  buildCityWorkspaces(groupedSessions: readonly Session[]): CityWorkspace[] {
    const sessionsByWs = new Map<string, string[]>();
    for (const s of groupedSessions) {
      const id = s.workspaceId ?? UNASSIGNED_WORKSPACE_ID;
      const list = sessionsByWs.get(id) ?? [];
      list.push(s.id);
      sessionsByWs.set(id, list);
    }
    const result: CityWorkspace[] = [];
    const openIds = new Set([...this.openKeys].map((k) => this.byKey.get(k)?.id).filter(Boolean) as string[]);
    for (const ws of this.byKey.values()) {
      const ids = sessionsByWs.get(ws.id);
      result.push({ ...ws, open: openIds.has(ws.id), sessionIds: [...(ids ?? [])].sort() });
    }
    const unassigned = sessionsByWs.get(UNASSIGNED_WORKSPACE_ID);
    if (unassigned) {
      const now = this.now();
      result.push({
        id: UNASSIGNED_WORKSPACE_ID,
        path: '',
        name: 'Unassigned',
        firstSeen: now,
        lastSeen: now,
        source: 'session',
        pinned: false,
        open: false,
        sessionIds: [...unassigned].sort(),
      });
    }
    return result.sort(
      (a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  /**
   * Keeps the registry at MAX_ENTRIES by dropping the oldest (lastSeen) entries that are unpinned,
   * auto-discovered, not open and had no live or archived session in the last grouping. Imported,
   * manual and pinned workspaces are never pruned (the registry may then exceed the cap).
   */
  private prune(): void {
    if (this.byKey.size <= MAX_ENTRIES) return;
    const candidates = [...this.byKey.entries()]
      .filter(
        ([k, w]) =>
          !w.pinned &&
          AUTO_SOURCES.has(w.source) &&
          !this.openKeys.has(k) &&
          !this.liveKeys.has(k) &&
          !this.historyKeys.has(k),
      )
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen || a[1].id.localeCompare(b[1].id));
    let excess = this.byKey.size - MAX_ENTRIES;
    for (const [k] of candidates) {
      if (excess <= 0) break;
      this.byKey.delete(k);
      excess--;
    }
  }

  get isDirty(): boolean {
    return this.dirty || this.exclusionsDirty;
  }

  /** Persists to the memento if anything changed. Never rejects. */
  async flush(): Promise<void> {
    if (this.dirty) {
      this.dirty = false;
      try {
        await this.memento.update(REGISTRY_KEY, this.all());
      } catch (err) {
        this.dirty = true;
        console.error('[claude-city] failed to persist workspace registry', err);
      }
    }
    if (this.exclusionsDirty) {
      this.exclusionsDirty = false;
      try {
        await this.memento.update(EXCLUSIONS_KEY, [...this.exclusions]);
      } catch (err) {
        this.exclusionsDirty = true;
        console.error('[claude-city] failed to persist workspace exclusions', err);
      }
    }
  }
}
