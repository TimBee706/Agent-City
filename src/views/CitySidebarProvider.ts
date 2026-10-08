import * as vscode from 'vscode';
import { WebviewHostDeps, hostWebview } from './webviewHost';

/** Activity bar sidebar: compact counts + "Open City" button. */
export class CitySidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'claudeCity.overview';
  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly deps: WebviewHostDeps,
    private readonly onVisibilityChanged: () => void,
  ) {}

  get isVisible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;
    this.disposables.push(
      hostWebview(view.webview, 'sidebar', this.deps),
      view.onDidChangeVisibility(() => this.onVisibilityChanged()),
      view.onDidDispose(() => {
        this.disposeView();
        this.onVisibilityChanged();
      }),
    );
    this.onVisibilityChanged();
  }

  private disposeView(): void {
    this.view = undefined;
    const d = this.disposables;
    this.disposables = [];
    for (const x of d) x.dispose();
  }

  dispose(): void {
    this.disposeView();
  }
}
