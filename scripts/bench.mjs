// Rough render benchmark of the city map: node scripts/bench.mjs [buildings]
// Reports main-thread cost while idle (ambient animations) and while panning / zooming.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const count = Number(process.argv[2] ?? 150);
const work = join(tmpdir(), 'agent-city-preview');
mkdirSync(work, { recursive: true });
const stateBundle = join(work, 'state.cjs');
await esbuild.build({ entryPoints: [join(root, 'scripts/previewState.ts')], outfile: stateBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' });
const { previewState } = require(stateBundle);
const { chromium } = require('playwright');

const file = join(work, 'bench.html');
writeFileSync(
  file,
  `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>html,body{margin:0;height:100%;background:#1e1e1e;color:#ddd;font:13px system-ui}#root{height:100%}</style>
<link href="${pathToFileURL(join(root, 'dist/webview.css'))}" rel="stylesheet"></head><body class="vscode-dark"><div id="root" data-view="panel"></div>
<script>let s;window.acquireVsCodeApi=()=>({postMessage(){},getState:()=>s,setState:(v)=>{s=v}});</script>
<script src="${pathToFileURL(join(root, 'dist/webview.js'))}"></script></body></html>`,
);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const diff = (a, b) => ({
  taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
  styleMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
  layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000),
  scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
  recalcs: b.RecalcStyleCount - a.RecalcStyleCount,
});
await page.goto(pathToFileURL(file).href);
const t0 = Date.now();
await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), previewState(Date.now(), count));
await page.waitForSelector('.iso-building');
console.log(`buildings: ${count}, first render: ${Date.now() - t0} ms, DOM nodes: ${await page.evaluate(() => document.querySelectorAll('*').length)}`);
if (process.env.BENCH_JS) await page.evaluate(process.env.BENCH_JS);
if (process.env.BENCH_LAYERS) { let n = 0; cdp.on('LayerTree.layerTreeDidChange', (e) => { n = e.layers?.length ?? n; }); await cdp.send('LayerTree.enable'); await page.waitForTimeout(500); console.log('compositor layers:', n); }
if (process.env.BENCH_CSS) await page.addStyleTag({ content: process.env.BENCH_CSS });
await page.waitForTimeout(1500);

const idle = async (label) => {
  let best;
  for (let i = 0; i < 3; i++) {
    const a0 = await metrics();
    await page.waitForTimeout(3000);
    const d = diff(a0, await metrics());
    if (!best || d.taskMs < best.taskMs) best = d;
  }
  console.log(label, best);
};
let a;
await idle('idle 3 s (best of 3)       ');

for (let i = 0; i < 6; i++) await page.locator('.zoom-controls button').first().click();
await page.waitForTimeout(800);
await idle('idle 3 s zoomed (best of 3)');

const frames = async (fn) => {
  await page.evaluate(() => {
    window.__f = [];
    let last = performance.now();
    const tick = (t) => {
      window.__f.push(t - last);
      last = t;
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
  });
  await fn();
  return page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    const f = window.__f.slice(2).sort((x, y) => x - y);
    return { frames: f.length, avgMs: +(f.reduce((x, y) => x + y, 0) / f.length).toFixed(1), p95Ms: +f[Math.floor(f.length * 0.95)].toFixed(1) };
  });
};
if (process.env.BENCH_TRACE) {
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  await page.mouse.move(700, 500);
  await page.mouse.down();
  for (let i = 0; i < 90; i++) await page.mouse.move(700 + Math.sin(i / 8) * 300, 500 + Math.cos(i / 8) * 200);
  await page.mouse.up();
  const trace = JSON.parse((await browser.stopTracing()).toString());
  const sum = new Map();
  for (const e of trace.traceEvents) if (e.ph === 'X' && e.dur) sum.set(e.name, (sum.get(e.name) ?? 0) + e.dur / 1000);
  console.log('trace (ms):', [...sum.entries()].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => `${k} ${Math.round(v)}`).join(', '));
}
a = await metrics();
const pan = await frames(async () => {
  await page.mouse.move(700, 500);
  await page.mouse.down();
  for (let i = 0; i < 90; i++) await page.mouse.move(700 + Math.sin(i / 8) * 300, 500 + Math.cos(i / 8) * 200);
  await page.mouse.up();
});
console.log('pan           ', pan, diff(a, await metrics()));
a = await metrics();
const zoom = await frames(async () => {
  await page.mouse.move(700, 500);
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, i < 30 ? 60 : -60);
});
console.log('wheel zoom    ', zoom, diff(a, await metrics()));
await browser.close();
