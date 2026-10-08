import { MAX_IMPORT_PER_ROOT, RootScanResult, ScanOptions, dedupeRoots, scanRoot } from './FolderImport';
import { normalizePathKey } from './pathUtils';
import { WorkspaceRegistry } from './WorkspaceRegistry';

export interface ImportSummary {
  /** Roots that were scanned successfully. */
  roots: number;
  /** New workspaces added to the city. */
  imported: number;
  /** Found folders that were already in the city (now pinned / imported). */
  alreadyKnown: number;
  /** Folders not imported because of the per-root cap. */
  truncated: number;
  /** Roots imported as one single project (heuristic). */
  single: number;
  /** Chosen folders that could not be read. */
  failed: string[];
}

export interface WorkspaceImporterDeps {
  registry: WorkspaceRegistry;
  /** Configured roots (claudeCity.workspaceRoots). */
  getRoots: () => string[];
  /** Persists the roots (user/global settings). */
  setRoots: (roots: string[]) => PromiseLike<void>;
  homeDir?: string;
  maxPerRoot?: number;
  scan?: (root: string, opts: ScanOptions) => Promise<RootScanResult>;
  /** User-visible warning (shown once per missing root per session). */
  warn?: (msg: string) => void;
  log?: (msg: string) => void;
  /** Called after the registry changed (refresh the city). */
  onChanged?: () => void;
}

/**
 * Imports workspaces from root folders and keeps them in sync: new subfolders appear, vanished ones
 * are marked missing (never deleted automatically), missing roots only produce a warning.
 */
export class WorkspaceImporter {
  private readonly warnedRoots = new Set<string>();
  private inFlight: Promise<void> | undefined;
  private readonly scan: (root: string, opts: ScanOptions) => Promise<RootScanResult>;

  constructor(private readonly deps: WorkspaceImporterDeps) {
    this.scan = deps.scan ?? scanRoot;
  }

  private scanOpts(): ScanOptions {
    return { homeDir: this.deps.homeDir, maxPerRoot: this.deps.maxPerRoot ?? MAX_IMPORT_PER_ROOT };
  }

  /** Explicit import of the chosen folders: imports, then adds them to the configured roots. */
  async importFolders(folders: readonly string[]): Promise<ImportSummary> {
    const summary: ImportSummary = { roots: 0, imported: 0, alreadyKnown: 0, truncated: 0, single: 0, failed: [] };
    const scanned: string[] = [];
    for (const root of dedupeRoots(folders)) {
      const res = await this.scan(root, this.scanOpts());
      if (!res.exists) {
        summary.failed.push(root);
        continue;
      }
      summary.roots++;
      scanned.push(root);
      if (res.mode === 'single') summary.single++;
      summary.truncated += res.truncated;
      for (const p of res.projects) {
        // Explicit import: the user picked this folder, so earlier "Remove from City" is undone.
        const r = this.deps.registry.registerImported(p, root, { force: true });
        if (r?.added) summary.imported++;
        else summary.alreadyKnown++;
      }
      // Mark vanished folders of an already configured root.
      this.deps.registry.syncRoot(root, res.projects);
    }
    if (scanned.length) {
      const current = this.deps.getRoots();
      const next = dedupeRoots([...current, ...scanned]);
      if (next.length !== dedupeRoots(current).length) {
        try {
          await this.deps.setRoots(next);
        } catch (err) {
          this.deps.log?.(`could not save claudeCity.workspaceRoots: ${(err as Error)?.message ?? String(err)}`);
        }
      }
    }
    await this.deps.registry.flush();
    this.deps.onChanged?.();
    this.deps.log?.(
      `import: ${summary.imported} new, ${summary.alreadyKnown} known, ${summary.truncated} over cap, ${summary.failed.length} unreadable root(s)`,
    );
    return summary;
  }

  /** Rescans all configured roots (coalesced, never rejects). */
  rescan(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.rescanOnce()
      .catch((err) => this.deps.log?.(`workspace root rescan failed: ${(err as Error)?.message ?? String(err)}`))
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async rescanOnce(): Promise<void> {
    const roots = dedupeRoots(this.deps.getRoots());
    if (!roots.length) return;
    let changed = false;
    let added = 0;
    for (const root of roots) {
      const key = normalizePathKey(root);
      const res = await this.scan(root, this.scanOpts());
      if (!res.exists) {
        if (!this.warnedRoots.has(key)) {
          this.warnedRoots.add(key);
          this.deps.warn?.(`Claude City: workspace root folder not found: ${root} (its buildings are shown as "folder not found").`);
        }
        changed = this.deps.registry.markRootMissing(root) > 0 || changed;
        continue;
      }
      this.warnedRoots.delete(key);
      const r = this.deps.registry.syncRoot(root, res.projects);
      added += r.added;
      changed = r.changed > 0 || changed;
    }
    if (added) this.deps.log?.(`workspace roots: ${added} new folder(s) found`);
    if (changed) {
      await this.deps.registry.flush();
      this.deps.onChanged?.();
    }
  }

  /** Removes a configured root; optionally also the workspaces imported from it. */
  async removeRoot(root: string, removeWorkspaces: boolean): Promise<number> {
    const key = normalizePathKey(root);
    const next = dedupeRoots(this.deps.getRoots()).filter((r) => normalizePathKey(r) !== key);
    await this.deps.setRoots(next);
    this.warnedRoots.delete(key);
    const removed = removeWorkspaces ? this.deps.registry.removeByRoot(root) : 0;
    await this.deps.registry.flush();
    this.deps.onChanged?.();
    return removed;
  }
}

/** "12 workspaces imported, 3 already known" style summary. */
export function formatImportSummary(s: ImportSummary): string {
  const parts = [`${s.imported} workspace${s.imported === 1 ? '' : 's'} imported`];
  if (s.alreadyKnown) parts.push(`${s.alreadyKnown} already known`);
  if (s.single) parts.push(`${s.single} folder${s.single === 1 ? '' : 's'} imported as a single project`);
  if (s.truncated) parts.push(`${s.truncated} skipped (limit ${MAX_IMPORT_PER_ROOT} per folder)`);
  if (s.failed.length) parts.push(`${s.failed.length} folder${s.failed.length === 1 ? '' : 's'} could not be read`);
  return parts.join(', ');
}
