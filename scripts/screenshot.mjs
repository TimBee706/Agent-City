// Renders the webview bundle with a deterministic preview city and takes screenshots.
// Usage: npm run compile && node scripts/screenshot.mjs [outDir]
// Needs Playwright (not a dependency of this repo): `npm i -g playwright` or NODE_PATH pointing to it.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(root, 'docs/screenshots'));
mkdirSync(outDir, { recursive: true });

const work = join(tmpdir(), 'agent-city-preview');
mkdirSync(work, { recursive: true });
const stateBundle = join(work, 'state.cjs');
await esbuild.build({ entryPoints: [join(root, 'scripts/previewState.ts')], outfile: stateBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' });
const { previewState } = require(stateBundle);

const THEMES = {
  dark: {
    cls: 'vscode-dark',
    vars: { '--vscode-editor-background': '#1e1e1e', '--vscode-editor-foreground': '#d4d4d4', '--vscode-foreground': '#cccccc', '--vscode-focusBorder': '#007fd4', '--vscode-font-family': 'system-ui, sans-serif', '--vscode-button-background': '#0e639c', '--vscode-button-foreground': '#ffffff', '--vscode-panel-border': '#3c3c3c', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-input-background': '#3c3c3c', '--vscode-input-foreground': '#cccccc', '--vscode-sideBar-background': '#252526', '--vscode-textLink-foreground': '#3794ff' },
  },
  light: {
    cls: 'vscode-light',
    vars: { '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#333333', '--vscode-foreground': '#3b3b3b', '--vscode-focusBorder': '#0090f1', '--vscode-font-family': 'system-ui, sans-serif', '--vscode-button-background': '#007acc', '--vscode-button-foreground': '#ffffff', '--vscode-panel-border': '#d4d4d4', '--vscode-descriptionForeground': '#717171', '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#616161', '--vscode-sideBar-background': '#f3f3f3', '--vscode-textLink-foreground': '#006ab1' },
  },
};

function html(theme) {
  const t = THEMES[theme];
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(';');
  // Same Content Security Policy as the real webview (see src/views/webviewHtml.ts): no inline styles, nonce'd scripts.
  // The theme variables therefore come from a generated stylesheet file, like VS Code's own.
  const themeCss = join(work, `theme-${theme}.css`);
  writeFileSync(
    themeCss,
    `html{${vars}}html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:13px}#root{height:100%}`,
  );
  const csp = "default-src 'none'; img-src file: data:; style-src file:; font-src file:; script-src 'nonce-preview'";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${pathToFileURL(themeCss)}" rel="stylesheet">
<link href="${pathToFileURL(join(root, 'dist/webview.css'))}" rel="stylesheet"></head>
<body class="${t.cls}"><div id="root" data-view="panel"></div>
<script nonce="preview">let s;window.__posted=[];window.acquireVsCodeApi=()=>({postMessage(m){window.__posted.push(m)},getState:()=>s,setState:(v)=>{s=v}});
window.__csp=[];document.addEventListener('securitypolicyviolation',(e)=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));</script>
<script nonce="preview" src="${pathToFileURL(join(root, 'dist/webview.js'))}"></script></body></html>`;
}

const { chromium } = require('playwright');
const browser = await chromium.launch();
export { browser, html, previewState, work };

/** shots: [name, theme, hour, action?] */
async function shot(name, theme, hour, { reduced = false, count, act, clip } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const at = new Date(2026, 5, 15, hour, 53, 0);
  await page.clock.install({ time: at });
  const file = join(work, `${theme}.html`);
  writeFileSync(file, html(theme));
  page.on('pageerror', (e) => console.error(`[${name}]`, e.message));
  await page.goto(pathToFileURL(file).href);
  await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), previewState(at.getTime(), count));
  await page.clock.runFor(1200);
  await page.waitForSelector('.iso-building');
  if (act) await act(page);
  await page.clock.runFor(1500);
  await page.waitForTimeout(700); // Web Animations run on real frames
  await page.screenshot({ path: join(outDir, `${name}.png`), clip });
  await page.close();
  console.log('wrote', join(outDir, `${name}.png`));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const enter = async (page) => {
    await page.locator('.iso-building .bld-shell').nth(6).dblclick();
    await page.clock.runFor(800);
  };
  const list = async (page) => {
    await page.locator('.view-switch-button', { hasText: 'List' }).click();
    for (const i of [0, 1]) await page.locator('.lv-row--workspace .lv-twisty').nth(i).click();
    await page.locator('.lv-row--group .lv-twisty').first().click();
    await page.locator('.lv-row--session').first().click();
  };
  const only = process.argv[3];
  const shots = [
    ['city-dark', 'dark', 21, {}],
    ['city-light-closeup', 'light', 11, { act: async (page) => { for (let i = 0; i < 4; i++) await page.locator('.zoom-controls button').first().click(); await page.clock.runFor(600); } }],
    ['building-dark', 'dark', 21, { act: enter }],
    ['building-light-reduced-motion', 'light', 11, { reduced: true, act: enter }],
    ['list-dark', 'dark', 21, { act: list }],
  ];
  for (const [name, theme, hour, opts] of shots) if (!only || name.includes(only)) await shot(name, theme, hour, opts);
  await browser.close();
}
