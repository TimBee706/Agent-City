import * as vscode from 'vscode';
import { CityState, computeCounts, summaryText } from '../models/CityState';

/** Status bar item, e.g. "$(organization) 3 working · 1 waiting"; click opens the city. */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('claudeCity.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Claude City';
    this.item.command = 'claudeCity.open';
    this.item.text = '$(organization) Claude City';
    this.item.show();
  }

  update(state: CityState): void {
    const c = computeCounts(state);
    let text: string;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    switch (state.source) {
      case 'demo':
        text = `$(organization) DEMO · ${summaryText(c)}`;
        tooltip.appendText('Claude City is showing DEMO data.');
        if (state.error) tooltip.appendText(`\n${state.error}`);
        break;
      case 'unavailable':
        text = '$(organization) Claude CLI unavailable';
        tooltip.appendText(state.error ?? 'claude executable not found');
        break;
      case 'error':
        text = `$(warning) ${summaryText(c)}`;
        tooltip.appendText(`Error reading sessions: ${state.error ?? 'unknown'}`);
        break;
      case 'loading':
        text = '$(sync~spin) Claude City';
        tooltip.appendText('Loading sessions...');
        break;
      default:
        text = `$(organization) ${summaryText(c)}`;
        tooltip.appendText(
          `${c.workspaces} workspaces · ${c.sessions} sessions\n${c.working} working · ${c.waiting} waiting · ${c.idle} idle · ${c.done} done · ${c.failed} failed` +
            (c.archived ? `\n${c.archived} archived past sessions` : ''),
        );
        if (state.cliVersion) tooltip.appendText(`\nClaude ${state.cliVersion}`);
    }
    tooltip.appendText('\n\nClick to open Claude City');
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor =
      c.waiting > 0 && state.source === 'live' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
