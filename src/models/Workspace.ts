/**
 * How a workspace got into the registry:
 * - open: a VS Code workspace folder
 * - session: cwd of a live Claude session
 * - history: cwd of an imported past session / discovered ~/.claude/projects entry
 * - imported: subfolder of a folder chosen via "Import Workspaces from Folder…" (claudeCity.workspaceRoots)
 * - manual: explicitly added by the user (reserved; treated like imported)
 */
export type WorkspaceSource = 'open' | 'session' | 'history' | 'imported' | 'manual';

export const WORKSPACE_SOURCES: readonly WorkspaceSource[] = ['open', 'session', 'history', 'imported', 'manual'];

export interface Workspace {
  /** Stable hash of the normalized path key. */
  id: string;
  /** Original (display) path as first seen. */
  path: string;
  /** Display name, basename of the path. */
  name: string;
  firstSeen: number;
  lastSeen: number;
  source: WorkspaceSource;
  /** Pinned workspaces are never pruned (imported ones are always pinned). */
  pinned: boolean;
  /** Imported workspaces: the configured root folder they were found in. */
  root?: string;
  /** Imported workspaces: the folder was not found on the last root rescan (never auto-deleted). */
  missing?: boolean;
}

/** Workspace as shown in the city (registry entry + runtime flags). */
export interface CityWorkspace extends Workspace {
  /** True if currently opened as a VS Code workspace folder. */
  open: boolean;
  sessionIds: string[];
  /** Archived (history) sessions of this workspace beyond the per-workspace limit (not in `sessionIds`). */
  archivedOverflow?: number;
  /** Recent (resting) sessions of this workspace beyond the per-workspace room limit (not in `sessionIds`). */
  recentOverflow?: number;
}
