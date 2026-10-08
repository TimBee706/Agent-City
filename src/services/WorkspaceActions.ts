import * as vscode from 'vscode';
import { UNASSIGNED_WORKSPACE_ID, WorkspaceRegistry } from '../backend/WorkspaceRegistry';
import { WorkspaceImporter, formatImportSummary } from '../backend/WorkspaceImporter';
import { MAX_IMPORT_PER_ROOT, dedupeRoots } from '../backend/FolderImport';
import { isSameOrChildKey, normalizePathKey } from '../backend/pathUtils';

export interface WorkspaceActionsDeps {
  registry: WorkspaceRegistry;
  importer: WorkspaceImporter;
  getRoots: () => string[];
  log: (msg: string) => void;
  /** Registry changed: regroup + republish (and optionally zoom the city to fit). */
  afterChange: (opts: { fit?: boolean }) => void;
}

/**
 * Commands for managing the city's workspaces: folder import, root removal, remove/pin buildings.
 * Paths only come from the native folder dialog, the settings or the registry - never from a webview.
 */
export class WorkspaceActions {
  constructor(private readonly deps: WorkspaceActionsDeps) {}

  async importFromFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      openLabel: 'Import Workspaces',
      title: 'Claude City: choose the folder(s) that contain your projects',
    });
    const folders = (uris ?? []).filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    if (!folders.length) return;
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Claude City: importing workspaces…' },
      () => this.deps.importer.importFolders(folders),
    );
    this.deps.afterChange({ fit: true });
    const text = `Claude City: ${formatImportSummary(summary)}.`;
    if (summary.truncated || summary.failed.length) {
      void vscode.window.showWarningMessage(
        summary.truncated ? `${text} At most ${MAX_IMPORT_PER_ROOT} workspaces are imported per folder.` : text,
      );
    } else {
      void vscode.window.showInformationMessage(text);
    }
  }

  async removeRoot(): Promise<void> {
    const roots = dedupeRoots(this.deps.getRoots());
    if (!roots.length) {
      void vscode.window.showInformationMessage(
        'Claude City: no workspace root folders are configured. Use "Import Workspaces from Folder…" to add one.',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: r, description: `${this.deps.registry.workspacesOfRoot(r).length} workspace(s)`, root: r })),
      { title: 'Claude City: remove workspace root', placeHolder: 'Root folder to stop scanning' },
    );
    if (!pick) return;
    const count = this.deps.registry.workspacesOfRoot(pick.root).length;
    let removeWorkspaces = false;
    if (count > 0) {
      const removeAll = 'Remove Root and Its Workspaces';
      const keep = 'Remove Root, Keep Workspaces';
      const answer = await vscode.window.showWarningMessage(
        `Stop scanning ${pick.root}? ${count} workspace(s) were imported from it.`,
        { modal: true, detail: 'Folders on disk are never touched.' },
        removeAll,
        keep,
      );
      if (!answer) return;
      removeWorkspaces = answer === removeAll;
    }
    const removed = await this.deps.importer.removeRoot(pick.root, removeWorkspaces);
    this.deps.afterChange({ fit: removed > 0 });
    void vscode.window.showInformationMessage(
      `Claude City: removed root ${pick.root}${removeWorkspaces ? ` and ${removed} workspace(s)` : ''}.`,
    );
  }

  async removeWorkspace(arg?: unknown): Promise<void> {
    let id = typeof arg === 'string' && arg.length <= 200 ? arg : undefined;
    if (!id) {
      const pick = await vscode.window.showQuickPick(
        this.deps.registry
          .all()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((w) => ({ label: w.name, description: w.path, id: w.id })),
        { title: 'Claude City: remove workspace from the city', placeHolder: 'Workspace to remove', matchOnDescription: true },
      );
      if (!pick) return;
      id = pick.id;
    }
    if (id === UNASSIGNED_WORKSPACE_ID) return;
    const ws = this.deps.registry.findById(id);
    if (!ws) {
      void vscode.window.showWarningMessage('Claude City: this workspace is not known (anymore).');
      return;
    }
    const key = normalizePathKey(ws.path);
    const underRoot = this.deps.getRoots().some((r) => isSameOrChildKey(normalizePathKey(r), key));
    const answer = await vscode.window.showWarningMessage(
      `Remove "${ws.name}" from Claude City?`,
      {
        modal: true,
        detail:
          `${ws.path}\n\nThe folder itself is not touched. ` +
          (underRoot ? 'It is excluded from future root folder scans. ' : '') +
          'It reappears only if a live Claude session runs there or you import it again.',
      },
      'Remove from City',
    );
    if (answer !== 'Remove from City') return;
    this.deps.registry.remove(id);
    await this.deps.registry.flush();
    this.deps.log(`removed workspace ${ws.name} from the city`);
    this.deps.afterChange({});
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    if (!this.deps.registry.setPinned(id, pinned)) return;
    await this.deps.registry.flush();
    this.deps.afterChange({});
  }
}
