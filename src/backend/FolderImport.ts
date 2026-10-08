import * as fs from 'fs';
import * as path from 'path';
import { normalizePathKey } from './pathUtils';

/**
 * Folder import ("Import Workspaces from Folder…"): finds the projects inside a chosen root folder.
 * Async fs only (never blocks the extension host), never throws.
 *
 * Heuristic (kept deliberately simple):
 *  1. Candidates = DIRECT subfolders of the root, except hidden ones (name starts with ".") and
 *     SKIP_DIR_NAMES (node_modules, bin, obj, out, dist, $RECYCLE.BIN, ...), case-insensitive.
 *  2. If the root itself looks like a project (contains .git, .claude, app.json, package.json or a
 *     *.sln) AND none of the candidates looks like a project, the root itself is imported as ONE
 *     workspace (someone picked a single repo instead of a folder of repos).
 *  3. Otherwise every candidate becomes a workspace (whether or not it has project markers).
 * Drive roots, UNC share roots and the home folder are never imported as one workspace (their
 * subfolders are fine), and the home folder is never imported as a subfolder either.
 */

export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  'bin',
  'obj',
  'out',
  'dist',
  '.git',
]);

export const PROJECT_MARKERS: readonly string[] = ['.git', '.claude', 'app.json', 'package.json'];

/** Maximum workspaces imported from one root (rest is reported as truncated). */
export const MAX_IMPORT_PER_ROOT = 500;

export function isSkippedDirName(name: string): boolean {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name.toLowerCase());
}

/** True for names of entries that mark a folder as a project. */
export function isProjectMarker(name: string): boolean {
  const lower = name.toLowerCase();
  return PROJECT_MARKERS.includes(lower) || lower.endsWith('.sln');
}

/**
 * Drive roots (C:\), the POSIX root, UNC share roots (\\server\share) and the home folder must never
 * become ONE workspace - it would swallow every session on the machine via prefix grouping.
 */
export function isProtectedFolder(p: string, homeDir?: string): boolean {
  const key = normalizePathKey(p);
  if (!key || key === '/' || /^[a-z]:\/?$/i.test(key)) return true;
  if (/^\/\/[^/]+(\/[^/]+)?$/.test(key)) return true; // //server or //server/share
  if (homeDir && key === normalizePathKey(homeDir)) return true;
  return false;
}

export interface RootScanResult {
  root: string;
  /** False if the root does not exist / is not a readable directory. */
  exists: boolean;
  /** 'children' = subfolders imported, 'single' = the root itself is one project. */
  mode: 'children' | 'single';
  /** Absolute folder paths to register (sorted, capped). */
  projects: string[];
  /** Candidates beyond `maxPerRoot` that were not imported. */
  truncated: number;
  error?: string;
}

export interface ScanOptions {
  homeDir?: string;
  maxPerRoot?: number;
}

async function listDirNames(dir: string): Promise<{ dirs: string[]; names: string[] }> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const dirs: string[] = [];
  const names: string[] = [];
  for (const e of entries) {
    names.push(e.name);
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isSymbolicLink()) {
      // Junctions / symlinks to folders count as folders (broken links are ignored).
      try {
        if ((await fs.promises.stat(path.join(dir, e.name))).isDirectory()) dirs.push(e.name);
      } catch {
        /* ignore */
      }
    }
  }
  return { dirs, names };
}

async function looksLikeProject(dir: string): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.some(isProjectMarker);
  } catch {
    return false;
  }
}

/** Scans one root folder (see the heuristic above). Never throws. */
export async function scanRoot(root: string, opts: ScanOptions = {}): Promise<RootScanResult> {
  const max = Math.max(1, Math.floor(opts.maxPerRoot ?? MAX_IMPORT_PER_ROOT));
  const result: RootScanResult = { root, exists: false, mode: 'children', projects: [], truncated: 0 };
  let listing: { dirs: string[]; names: string[] };
  try {
    const st = await fs.promises.stat(root);
    if (!st.isDirectory()) {
      result.error = 'not a folder';
      return result;
    }
    listing = await listDirNames(root);
  } catch (err) {
    result.error = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? String(err);
    return result;
  }
  result.exists = true;
  const homeKey = opts.homeDir ? normalizePathKey(opts.homeDir) : undefined;
  const candidates = listing.dirs
    .filter((n) => !isSkippedDirName(n))
    .map((n) => path.join(root, n))
    .filter((p) => !(homeKey && normalizePathKey(p) === homeKey))
    .sort((a, b) => {
      const ka = normalizePathKey(a);
      const kb = normalizePathKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const rootIsProject = listing.names.some(isProjectMarker) && !isProtectedFolder(root, opts.homeDir);
  if (rootIsProject) {
    let childProject = false;
    for (const c of candidates) {
      if (await looksLikeProject(c)) {
        childProject = true;
        break;
      }
    }
    if (!childProject) {
      result.mode = 'single';
      result.projects = [root];
      return result;
    }
  }
  result.projects = candidates.slice(0, max);
  result.truncated = Math.max(0, candidates.length - max);
  return result;
}

/** Removes duplicate roots (Windows: case / slash insensitive) keeping the first spelling. */
export function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) continue;
    const k = normalizePathKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.trim());
  }
  return out;
}
