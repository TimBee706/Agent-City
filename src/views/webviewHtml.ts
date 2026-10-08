import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ViewKind } from '../shared/protocol';

export function createNonce(): string {
  return randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/** Webview options: scripts on, resources limited to dist/ and media/. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

/**
 * Builds the webview HTML with a strict CSP:
 * - default-src 'none'
 * - scripts only from our nonce'd bundle (no inline scripts, no eval)
 * - styles only from the extension (no 'unsafe-inline': the UI uses CSS classes + SVG attributes)
 * - images only from the extension or data: URIs
 */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: ViewKind): string {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Claude City</title>
</head>
<body>
<div id="root" data-view="${view}"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
