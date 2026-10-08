import * as vscode from 'vscode';
import { WorkspaceRegistry } from '../backend/WorkspaceRegistry';
import { isSameOrChildKey, normalizePathKey } from '../backend/pathUtils';
import { CityState } from '../models/CityState';
import { CLAUDE_CODE_EXTENSION_ID, buildOpenSessionUri, isValidSessionId } from '../shared/sessionLinks';

/**
 * "Open Session" / "Open Workspace" actions. Paths are only taken from the workspace registry
 * (by id), never from webview input; session ids are validated before a URI is built.
 */
export class SessionOpener {
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly getState: () => CityState,
    private readonly log: (msg: string) => void,
  ) {}

  async openWorkspace(workspaceId: string, newWindow: boolean): Promise<void> {
    const ws = this.registry.findById(workspaceId);
    if (!ws || !ws.path) {
      void vscode.window.showWarningMessage('Claude City: this workspace is not known (anymore).');
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(ws.path), { forceNewWindow: newWindow });
    } catch (err) {
      this.log(`openFolder failed: ${(err as Error)?.message ?? String(err)}`);
      void vscode.window.showErrorMessage(`Claude City: could not open ${ws.path}`);
    }
  }

  private isOpenInThisWindow(cwd: string | undefined, workspaceId: string | undefined): boolean {
    if (workspaceId && this.registry.isOpen(workspaceId)) return true;
    if (!cwd) return false;
    const key = normalizePathKey(cwd);
    return (vscode.workspace.workspaceFolders ?? []).some(
      (f) => f.uri.scheme === 'file' && isSameOrChildKey(normalizePathKey(f.uri.fsPath), key),
    );
  }

  async openSession(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      void vscode.window.showWarningMessage('Claude City: invalid session id.');
      return;
    }
    if (this.getState().source === 'demo') {
      void vscode.window.showInformationMessage('Claude City: demo sessions are simulated and cannot be opened.');
      return;
    }
    const session = this.getState().sessions.find((s) => s.id === sessionId || s.sessionId === sessionId);
    const claudeSessionId = session?.sessionId ?? (session ? undefined : sessionId);
    if (!claudeSessionId || !isValidSessionId(claudeSessionId)) {
      void vscode.window.showWarningMessage(
        'Claude City: this session has no Claude session id (it was reported without one), so it cannot be opened.',
      );
      return;
    }
    if (!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)) {
      const pick = await vscode.window.showInformationMessage(
        'Opening a session requires the Claude Code extension for VS Code (anthropic.claude-code). ' +
          `You can also resume it in a terminal with: claude --resume ${claudeSessionId}`,
        'Show Extension',
        'Copy Resume Command',
      );
      if (pick === 'Show Extension') {
        void vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_CODE_EXTENSION_ID);
      } else if (pick === 'Copy Resume Command') {
        await vscode.env.clipboard.writeText(`claude --resume ${claudeSessionId}`);
      }
      return;
    }
    // Past sessions that are only listed in the history index (no room) still know their workspace.
    const indexWsId = session
      ? undefined
      : this.getState().historyIndex?.find((x) => x.items.some((h) => h.id === sessionId))?.workspaceId;
    const target: { cwd?: string; workspaceId?: string } | undefined = session ?? (indexWsId ? { workspaceId: indexWsId } : undefined);
    if (target && !this.isOpenInThisWindow(target.cwd, target.workspaceId)) {
      const ws = target.workspaceId ? this.registry.findById(target.workspaceId) : undefined;
      const choices = ws?.path ? ['Open Workspace', 'Open in New Window', 'Open Session Here'] : ['Open Session Here'];
      const pick = await vscode.window.showInformationMessage(
        `This session belongs to ${ws?.path ?? target.cwd ?? 'another folder'}, which is not open in this window. ` +
          'Claude Code resumes sessions per workspace: open the workspace first, then use "Open Session" there.',
        ...choices,
      );
      if (pick === 'Open Workspace' && ws) return this.openWorkspace(ws.id, false);
      if (pick === 'Open in New Window' && ws) return this.openWorkspace(ws.id, true);
      if (pick !== 'Open Session Here') return;
    }
    const uri = buildOpenSessionUri(claudeSessionId, vscode.env.uriScheme);
    if (!uri) return;
    try {
      const ok = await vscode.env.openExternal(vscode.Uri.parse(uri, true));
      if (!ok) this.log(`openExternal refused ${uri}`);
    } catch (err) {
      this.log(`open session failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  async copySessionId(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) return;
    const session = this.getState().sessions.find((s) => s.id === sessionId || s.sessionId === sessionId);
    const id = session?.sessionId ?? session?.id ?? sessionId;
    await vscode.env.clipboard.writeText(id);
    void vscode.window.setStatusBarMessage('Claude City: session id copied', 2500);
  }
}
