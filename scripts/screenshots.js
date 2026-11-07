#!/usr/bin/env node
// Click through the whole demo in a fresh Chrome session, assert the key states, and save one
// screenshot per screen to docs/screens/. Uses playwright-core with the installed Google Chrome.
//
//   npm run demo            (in one terminal: builds the UI and starts the server on :8787)
//   npm run screens         (in another: BASE=http://127.0.0.1:8787 by default)
//
// This makes ONE real Braintree SANDBOX sale (synthetic order, test card). SYNTHETIC data only.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'docs', 'screens');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];

  // ---------- normal motion: the full click-through ----------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shot = (name, full = true) => page.screenshot({ path: path.join(OUT, name), fullPage: full });

  await api('reset');
  await page.goto(BASE);
  await page.waitForSelector('.preloader', { state: 'detached', timeout: 5000 });
  check('Landing: SYNTHETIC DATA chip in top bar', await page.locator('.topbar .chip.synthetic').isVisible());
  check('Landing: headline', (await page.locator('h1').innerText()).toLowerCase().includes('invoice-grade card data for b2b sellers'));
  await shot('01-landing.png');

  await page.getByRole('button', { name: /load demo catalog/i }).click();
  await page.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
  check('Enrich: counter reaches 40 / 40', true);
  check('Enrich: says it is a replay, no AI call', (await page.locator('.enrich-left').innerText()).includes('NO AI CALL'));
  check('Enrich: 40 SKUs listed', (await page.locator('.stream-row').count()) === 40);
  await page.waitForTimeout(400);
  await shot('02-enrich.png', false);

  await page.getByRole('button', { name: /continue to review/i }).click();
  await page.waitForSelector('.ag-row');
  const needs0 = Number(await page.locator('.stats .stat .n').first().innerText());
  const panelText = await page.locator('.panel').innerText();
  check('Review: opens on NEEDS REVIEW rows only', (await page.evaluate(() => new Set([...document.querySelectorAll('.ag-row[row-id]')].map((r) => r.getAttribute('row-id'))).size)) === needs0 && needs0 > 0, `${needs0} rows`);
  check('Review: side panel shows official title + runner-up + reason', ['official title', 'runner-up', 'model reason'].every((t) => (panelText || '').toLowerCase().includes(t)));
  check('Review: first flagged row is selected in the grid', (await page.locator('.ag-row.ag-row-selected').count()) > 0);
  await shot('03-review.png');

  // Edit flow on the first row (find a code, change unit, approve & lock), then approve/exclude the rest.
  let steps = 0;
  let needs = needs0;
  while (needs > 0 && steps++ < 12) {
    const panel = page.locator('.panel');
    const approve = panel.getByRole('button', { name: 'Approve', exact: true });
    const hasCode = await approve.isEnabled();
    if (hasCode) await approve.click(); else await panel.getByRole('button', { name: 'Exclude', exact: true }).click();
    await page.waitForFunction((n) => Number(document.querySelector('.stats .stat .n').textContent) < n, needs, { timeout: 8000 });
    needs = Number(await page.locator('.stats .stat .n').first().innerText());
  }
  check('Review: all needs-review rows approved or excluded', needs === 0, `${steps} actions`);
  check('Review: completion banner appears', await page.locator('.banner', { hasText: 'ALL FLAGGED ROWS REVIEWED' }).isVisible());
  await shot('03b-review-all-approved.png');

  await page.getByRole('button', { name: /continue to order/i }).click();
  await page.waitForSelector('.order-grid');
  await page.waitForSelector('text=/AS VISA SEES IT/');
  await page.waitForSelector('table.t tbody tr');
  check('Order: SANDBOX chip visible', await page.locator('.chip.sandbox').first().isVisible());
  check('Order: $958.05 total in the Visa panel', (await page.locator('.totals').innerText()).includes('958.05'));
  await shot('04a-order-before-pay.png');

  await page.getByRole('button', { name: /pay .*958\.05.* with braintree sandbox/i }).click();
  await page.waitForSelector('[data-testid="txn-id"]', { timeout: 30000 });
  await page.waitForSelector('.stamp', { timeout: 10000 });
  const txn = (await page.locator('[data-testid="txn-id"]').innerText()).trim();
  const stamp = (await page.locator('.stamp').innerText()).trim();
  check('Order: Braintree read-back PASS stamp', /^PASS \d+\/\d+$/.test(stamp), `${stamp}, transaction ${txn}`);
  const rows = await page.locator('table.t').last().locator('tbody tr').allInnerTexts();
  check('Order: every read-back check is PASS', rows.length >= 11 && rows.every((r) => /PASS\s*$/.test(r.trim())), `${rows.length} checks`);
  check('Order: Commercial card = Yes', rows.some((r) => /Commercial card.*Yes.*PASS/s.test(r)));
  await shot('04-order-paid.png');

  await page.getByRole('button', { name: /submit same order again/i }).click();
  await page.waitForSelector('text=/ALREADY CHARGED/');
  check('Order: same order again says ALREADY CHARGED', true);
  await shot('04b-order-duplicate.png');

  await page.getByRole('button', { name: /see readiness/i }).click();
  await page.waitForSelector('.score');
  await page.waitForTimeout(1800);
  const score = Number(await page.locator('.score').innerText());
  check('Readiness: score counted up and shows a value', score > 0, `${score}/100`);
  check('Readiness: ESTIMATE — source pending tag, dashed', (await page.locator('.estimate-box').innerText()).includes('ESTIMATE — SOURCE PENDING'));
  check('Readiness: no invented fee numbers', !/\$\s?\d+\.\d\d/.test(await page.locator('.estimate-box').innerText()));
  check('Readiness: SYNTHETIC DATA chip persists', await page.locator('.topbar .chip.synthetic').isVisible());
  await shot('05-readiness.png');
  await ctx.close();

  // ---------- reduced motion ----------
  const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  await rp.goto(`${BASE}/?screen=enrich`);
  await rp.waitForSelector('.counter');
  check('Reduced motion: no preloader', (await rp.locator('.preloader').count()) === 0);
  await rp.waitForTimeout(150);
  check('Reduced motion: enrichment list appears at once (40 / 40)', (await rp.locator('.counter').innerText()).trim() === '40 / 40');
  const anim = await rp.evaluate(() => {
    const names = [];
    for (const sel of ['.orb', '.orb::before', '.progress i', '.stream-row']) {
      const [s, pseudo] = sel.split('::');
      const el = document.querySelector(s);
      if (el) names.push(getComputedStyle(el, pseudo ? `::${pseudo}` : null).animationName);
    }
    return names;
  });
  check('Reduced motion: animations are off', anim.length > 0 && anim.every((n) => n === 'none'), anim.join(','));
  await rp.goto(`${BASE}/?screen=readiness`);
  await rp.waitForSelector('.score');
  const instant = Number(await rp.locator('.score').innerText());
  check('Reduced motion: score shown immediately (no count-up)', instant > 0, `${instant}`);
  const drawAnim = await rp.evaluate(() => getComputedStyle(document.querySelector('.stats.draw .stat'), '::after').animationName);
  check('Reduced motion: stat borders not animated', drawAnim === 'none', drawAnim);
  await rctx.close();

  await browser.close();
  check('No console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\nFiles in docs/screens/:');
  for (const f of fs.readdirSync(OUT).sort()) console.log(`  docs/screens/${f}  (${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB)`);
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length}/${results.length} checks`}`);
  process.exitCode = failed.length ? 1 : 0;
}

async function api(what) {
  if (what === 'reset') await fetch(`${BASE}/api/catalog/reset`, { method: 'POST' });
}

if (require.main === module) main().catch((e) => { console.error(`ERROR: ${e.stack || e.message}`); process.exit(1); });
