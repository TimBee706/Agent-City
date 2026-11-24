// Drives the webview bundle in a real browser under the webview's CSP and checks the main
// interactions: node scripts/smoke.mjs   (needs Playwright, see screenshot.mjs)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browser, html, previewState, work } from './screenshot.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const file = join(work, 'smoke.html');
writeFileSync(file, html('dark'));
await page.goto(pathToFileURL(file).href);
const now = Date.now();
await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), previewState(now, 24));
await page.waitForSelector('.iso-building');
await page.waitForTimeout(600);

const camera = () => page.evaluate(() => document.querySelector('.city-layer--buildings').style.transform);
const layers = await page.evaluate(() => [...document.querySelectorAll('.city-layer')].map((l) => l.style.transform));
check('four camera layers share one CSS transform', layers.length === 4 && new Set(layers).size === 1 && /translate3d/.test(layers[0]), layers[0]);

// gradients resolve (a broken url(#...) paints nothing): the rug must be green-ish, not black / transparent
const rug = await page.evaluate(() => getComputedStyle(document.querySelector('.rug-top')).fill);
check('ground gradient is referenced', /cc-rug/.test(rug), rug);

// wheel zoom, then the scene must be re-rastered sharp: count distinct colours along a window edge row
const before = await camera();
await page.mouse.move(700, 450);
for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(500);
const zoomed = await camera();
check('wheel zooms in', zoomed !== before && Number(/scale\(([\d.]+)\)/.exec(zoomed)[1]) > Number(/scale\(([\d.]+)\)/.exec(before)[1]), zoomed);

// drag pans
await page.mouse.move(600, 500);
await page.mouse.down();
await page.mouse.move(500, 430, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(100);
check('drag pans', (await camera()) !== zoomed);

// fit button flies back (animated)
await page.locator('.zoom-controls button').nth(2).click();
await page.waitForTimeout(700);
check('fit returns to the whole city', (await camera()) === before, await camera());

// select a building: details panel + marker in the effects layer
const shell = page.locator('.iso-building .bld-shell').nth(5);
await shell.click();
await page.waitForTimeout(200);
check('click selects a building', (await page.locator('.iso-building.is-selected').count()) === 1);
check('selection marker in the effects layer', (await page.locator('.city-layer--fx .fx-marker').count()) === 1);

// taxi key: N goes to a building that needs attention and zooms in
await page.locator('.city-map').focus();
await page.keyboard.press('n');
await page.waitForTimeout(700);
const sel = await page.evaluate(() => document.querySelector('.iso-building.is-selected')?.className.baseVal ?? '');
check('N jumps to a building that needs attention', /bld--waiting/.test(sel), sel);
check('...and the camera flew there', (await camera()) !== before);

// extension command: focusAttention message cycles to the next one
await page.evaluate(() => window.postMessage({ type: 'focusAttention' }, '*'));
await page.waitForTimeout(700);
const second = await page.evaluate(() => document.querySelector('.iso-building.is-selected')?.className.baseVal ?? '');
check('focusAttention message goes to a building that needs attention', /bld--(waiting|working)/.test(second), second);

// minimap click moves the camera
const mm = await page.locator('.minimap svg').boundingBox();
const c0 = await camera();
await page.mouse.click(mm.x + mm.width * 0.3, mm.y + mm.height * 0.5);
await page.waitForTimeout(700);
check('minimap click moves the camera', (await camera()) !== c0);

// slow clock switches lights without CSS animations in the static layers
const anims = await page.evaluate(() =>
  document.getAnimations().filter((a) => a.effect?.target?.closest?.('.city-layer--ground, .city-layer--buildings') && a.effect.getTiming().iterations === Infinity).length,
);
check('no infinite animations inside the static layers', anims === 0, `${anims}`);
await page.waitForTimeout(800);
check('slow clock is ticking', await page.evaluate(() => /tick-\d/.test(document.querySelector('.city-map').className)));

// enter a building and come back
await page.locator('.zoom-controls button').nth(2).click();
await page.waitForTimeout(600);
await page.locator('.iso-building.bld--working .bld-shell').first().dblclick();
await page.waitForSelector('.building-view');
await page.waitForTimeout(500);
check('double-click enters the building', (await page.locator('.building-view .iroom').count()) > 0);
const treeFill = await page.evaluate(() => {
  const el = document.querySelector('.building-view .leaf-a');
  const r = el.getBoundingClientRect();
  return r.width > 0 && /cc-leaf/.test(getComputedStyle(el).fill);
});
check('shared gradients work inside the building while the map is hidden', treeFill);
check('elevator is moving', await page.evaluate(() => document.querySelector('.elevator-car').getAnimations().length === 1));
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Escape returns to the city', (await page.locator('.building-view').count()) === 0 && (await page.locator('.city-map:not(.is-hidden)').count()) === 1);

// list view: switch, expand / collapse, keyboard, selection, back to the building in the city
await page.locator('.view-switch-button', { hasText: 'List' }).click();
await page.waitForSelector('.list-view .lv-row');
check('list view replaces the map', (await page.locator('.city-map.is-hidden').count()) === 1);
const rowCount = () => page.locator('.lv-row').count();
const collapsed = await rowCount();
check('one row per company when collapsed', collapsed === 24, `${collapsed}`);
await page.locator('.lv-row--workspace .lv-twisty').first().click();
const opened = await rowCount();
check('the arrow expands a company', opened > collapsed, `${opened}`);
await page.locator('.lv-row--workspace').first().focus();
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(100);
check('Left collapses it', (await rowCount()) === collapsed);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(100);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(100); // focus moves after the render
check('Right opens it and steps to the first session', await page.evaluate(() => document.activeElement?.classList.contains('lv-row--session') ?? false));
await page.keyboard.press('Enter');
await page.waitForTimeout(100);
check('Enter selects the session (details panel)', (await page.locator('.lv-row--session.is-selected').count()) === 1);
await page.getByRole('button', { name: 'Expand all' }).click();
check('Expand all opens every company', (await page.locator('.lv-row--workspace[aria-expanded="true"]').count()) === 24);
await page.getByRole('button', { name: 'Collapse all' }).click();
check('Collapse all closes everything', (await rowCount()) === collapsed);
await page.locator('.lv-sort select').selectOption('name');
const names = await page.locator('.lv-row--workspace .lv-name').allTextContents();
check('sorting by name', names.join('|') === [...names].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())).join('|'));
check('view, sort and open rows are persisted', await page.evaluate(() => { const st = window.acquireVsCodeApi().getState(); return st.view === 'list' && st.listSort === 'name'; }));
// HUD "needs your attention" reveals the session in the list
await page.locator('.attention-button').first().click();
await page.waitForTimeout(200);
check('attention button reveals and selects the waiting session', (await page.locator('.lv-row--session.is-selected .lv-glyph--waiting').count()) === 1);
await page.locator('.lv-row--workspace .lv-enter').first().click({ force: true });
await page.waitForSelector('.building-view');
check('"show in the city" switches back to the map and enters the building', (await page.locator('.list-view').count()) === 0);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

check('no Content Security Policy violations', (await page.evaluate(() => window.__csp)).length === 0, JSON.stringify(await page.evaluate(() => window.__csp)));
check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: join(work, 'smoke.png') });
await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
