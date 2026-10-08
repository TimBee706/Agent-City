import * as vscode from 'vscode';
import { WebviewHostDeps, hostWebview } from './webviewHost';

/** Singleton editor-area panel showing the full city. */
export class CityPanel implements vscode.Disposable {
  static readonly viewType = 'claudeCity.city';
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly deps: WebviewHostDeps,
    private readonly onVisibilityChanged: () => void,
  ) {}

  get isVisible(): boolean {
    return !!this.panel?.visible;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CityPanel.viewType,
      'Claude City',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { retainContextWhenHidden: false },
    );
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'city.svg');
    this.panel = panel;
    this.disposables.push(
      hostWebview(panel.webview, 'panel', this.deps),
      panel.onDidChangeViewState(() => this.onVisibilityChanged()),
      panel.onDidDispose(() => this.cleanup()),
    );
    this.onVisibilityChanged();
  }

  private cleanup(): void {
    this.panel = undefined;
    const d = this.disposables;
    this.disposables = [];
    for (const x of d) x.dispose();
    this.onVisibilityChanged();
  }

  dispose(): void {
    const p = this.panel;
    this.cleanup();
    p?.dispose();
  }
}
