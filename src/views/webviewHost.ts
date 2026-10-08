import * as vscode from 'vscode';
import { MessageBus } from '../services/MessageBus';
import { StateSynchronizer } from '../services/StateSynchronizer';
import { ViewKind, WebviewToExtensionMessage } from '../shared/protocol';
import { getWebviewHtml, webviewOptions } from './webviewHtml';

export interface WebviewHostDeps {
  extensionUri: vscode.Uri;
  sync: StateSynchronizer;
  onMessage: (msg: WebviewToExtensionMessage) => void;
  log: (msg: string) => void;
}

/**
 * Wires a webview (panel or sidebar) to the synchronizer: HTML/CSP, validated message bus,
 * snapshot on `ready`. Returns a disposable that tears everything down.
 */
export function hostWebview(webview: vscode.Webview, view: ViewKind, deps: WebviewHostDeps): vscode.Disposable {
  webview.options = webviewOptions(deps.extensionUri);
  let target: ReturnType<StateSynchronizer['attach']> | undefined;
  const bus = new MessageBus(
    webview,
    (msg) => {
      if (msg.type === 'ready') target?.markReady();
      else deps.onMessage(msg);
    },
    deps.log,
  );
  target = deps.sync.attach(bus);
  webview.html = getWebviewHtml(webview, deps.extensionUri, view);
  return new vscode.Disposable(() => {
    target?.dispose();
    bus.dispose();
  });
}
