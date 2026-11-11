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
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f)); // always a fresh set
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];

  // ---------- normal motion: the full click-through ----------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shot = async (name, full = true) => {
    // the sticky top bar would be stitched into the middle of a full-page capture: make it static for the shot
    if (full) await page.addStyleTag({ content: '.topbar{position:static !important}', });
    await page.screenshot({ path: path.join(OUT, name), fullPage: full });
    if (full) await page.evaluate(() => { document.querySelectorAll('style').forEach((st) => { if (st.textContent === '.topbar{position:static !important}') st.remove(); }); });
  };
  const noHScroll = async (label) => check(`${label}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll('.card, .tscroll')].every((el) => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX === 'auto')));

  // A fresh browser context is a fresh session: nothing to reset. A sleeping free-tier server can take about a minute.
  const t0 = Date.now();
  for (;;) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* asleep or starting */ } if (Date.now() - t0 > 240000) throw new Error('server did not wake up in 4 minutes'); await new Promise((r) => setTimeout(r, 2000)); }
  check('Server answers /health', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.goto(BASE, { timeout: 120000 });
  await page.waitForSelector('.preloader', { state: 'detached', timeout: 5000 });
  check('Landing: SYNTHETIC DATA chip in top bar', await page.locator('.topbar .chip.synthetic').isVisible());
  check('Landing: headline', (await page.locator('h1').innerText()).toLowerCase().includes('invoice-grade card data for b2b sellers'));
  const pv = await page.locator('.pv').boundingBox();
  check('Landing: hero right half holds the raw name to code preview', !!pv && pv.x > 640 && /\d{8}/.test(await page.locator('.pv-code').innerText()), pv ? `x=${Math.round(pv.x)}` : 'missing');
  check('Design: wordmark is lowercase "linegrade" (top bar)', (await page.locator('.brand .wm').innerText()) === 'linegrade' && (await page.locator('.brand .wm').evaluate((e) => getComputedStyle(e).textTransform)) === 'none');
  check('Design: no notched buttons', await page.evaluate(() => [...document.querySelectorAll('.btn')].every((b) => getComputedStyle(b).clipPath === 'none')));
  check('Design: no pixel-noise bands, line-item bands present', (await page.locator('.noiseband').count()) === 0 && (await page.locator('.band svg line').count()) >= 4);
  check('Design: no slash-prefixed labels or nav items', await page.evaluate(() => [...document.querySelectorAll('.label, .nav button')].every((e) => !e.textContent.trim().startsWith('/'))));
  check('Design: labels use the line-item stub (SVG), not a square bullet', (await page.locator('.label svg').count()) > 0 && await page.evaluate(() => [...document.querySelectorAll('.label')].every((e) => getComputedStyle(e, '::before').content === 'none')));
  await shot('01-landing.png');

  await page.getByRole('button', { name: /load demo catalog/i }).click();
  await page.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
  check('Enrich: counter reaches 40 / 40', true);
  check('Enrich: says it is a replay, no AI call', (await page.locator('.enrich-left').innerText()).includes('NO AI CALL'));
  check('Enrich: 40 SKUs listed', (await page.locator('.stream-row').count()) === 40);
  await page.waitForTimeout(400);
  await shot('02-enrich.png', false);

  const lim = await page.getByTestId('ai-limits').innerText();
  const noList = (await (await fetch(`${BASE}/health`)).json()).codeList === 'none'; // hosted case: live AI is off by design
  check(noList ? 'Enrich: live AI off, replay only (no code list)' : 'Enrich: live AI re-runs left shown (2 of 2)', noList ? /REPLAY ONLY/.test(lim) : /RE-RUNS LEFT THIS SESSION: 2 OF 2/.test(lim));
  await page.getByRole('button', { name: /continue to review/i }).click();
  await page.waitForSelector('.ag-row');
  const needs0 = Number(await page.locator('.stats .stat .n').first().innerText());
  const panelText = await page.locator('.panel').innerText();
  check('Review: opens on NEEDS REVIEW rows only', (await page.evaluate(() => new Set([...document.querySelectorAll('.ag-row[row-id]')].map((r) => r.getAttribute('row-id'))).size)) === needs0 && needs0 > 0, `${needs0} rows`);
  const gridH = await page.locator('.ag-root-wrapper').first().evaluate((e) => e.getBoundingClientRect().height);
  check('Review: grid height fits the rows shown', Math.abs(gridH - (36 + needs0 * 44 + 2)) <= 6, `${Math.round(gridH)}px for ${needs0} rows`);
  check('Review: no duplicate chips in the section header', (await page.locator('section.section.tight > div:first-child .chip').count()) === 0);
  check('Review: side panel shows official title + runner-up + reason', ['official title', 'runner-up', 'model reason'].every((t) => panelText.toLowerCase().includes(t)));
  check('Review: first flagged row is selected in the grid', (await page.locator('.ag-row.ag-row-selected').count()) > 0);
  await shot('03-review.png');

  let steps = 0; let needs = needs0;
  while (needs > 0 && steps++ < 12) {
    const panel = page.locator('.panel');
    const approve = panel.getByRole('button', { name: /^Approve/ });
    if (await approve.isEnabled()) await approve.click(); else await panel.getByRole('button', { name: /^Exclude/ }).click();
    await page.waitForFunction((n) => Number(document.querySelector('.stats .stat .n').textContent) < n, needs, { timeout: 8000 });
    needs = Number(await page.locator('.stats .stat .n').first().innerText());
  }
  check('Review: all needs-review rows approved or excluded', needs === 0, `${steps} actions`);
  check('Review: completion banner appears', await page.locator('.banner', { hasText: 'ALL FLAGGED ROWS REVIEWED' }).isVisible());
  await shot('03b-review-all-approved.png');

  await page.getByRole('button', { name: /continue to order/i }).click();
  await page.waitForSelector('.order-grid');
  await page.waitForSelector('.seg');
  check('Order: one SYNTHETIC chip in the top bar only (no header duplicates)', (await page.locator('.chip.synthetic').count()) === 1);
  check('Order: toggle defaults to WITHOUT LineGrade', (await page.getByRole('button', { name: /without linegrade/i }).getAttribute('aria-pressed')) === 'true');
  await page.waitForSelector('text=Level 1 · standard rate');
  await page.waitForSelector('.order-grid .kv dt:has-text("Amount")');
  const w = await page.locator('.order-grid .card').nth(1).innerText();
  check('Order (without): Level 1 sends amount and order total only, no line items or codes', /AMOUNT\s*958\.05/i.test(w.replace(/\n/g, ' ')) && /ORDER TOTAL/i.test(w) && !/42132203/.test(w) && (await page.locator('.order-grid table.t').count()) === 0, 'chip: Level 1 · standard rate');
  check('Order (without): validator readiness 0 / 100', /0 \/ 100/.test(w));
  await shot('04a-order-without.png', false);

  await page.getByRole('button', { name: /with linegrade/i }).click();
  await page.waitForSelector('table.t tbody tr');
  check('Order (with): line items appear with commodity codes', (await page.locator('table.t tbody tr').count()) === 3 && /42132203/.test(await page.locator('table.t').innerText()));
  check('Order (with): $958.05 total and readiness 100 / 100', (await page.locator('.totals').innerText()).includes('958.05') && /100 \/ 100/.test(await page.locator('.order-grid').innerText()));
  check('Order: SANDBOX chip visible near payment', await page.locator('.chip.sandbox').first().isVisible());
  await page.waitForTimeout(900);
  await shot('04c-order-with-linegrade.png', false);
  await noHScroll('Order (before pay)');

  check('Order: sandbox payments left shown (5 of 5)', /PAYMENTS LEFT THIS SESSION: 5 OF 5/.test(await page.getByTestId('payments-left').innerText()));
  const payBtn = page.getByRole('button', { name: /pay .*958\.05.* with braintree sandbox/i });
  await payBtn.click();
  await page.waitForSelector('[data-testid="txn-id"]', { timeout: 30000 });
  await page.waitForSelector('.stamp');
  const txn = (await page.locator('[data-testid="txn-id"]').innerText()).trim();
  const stamp = (await page.locator('.stamp').innerText()).trim();
  const bBtn = await page.getByRole('button', { name: /^Paid/ }).boundingBox();
  const bStamp = await page.locator('.stamp').boundingBox();
  check('Order: PASS stamp + transaction ID directly under the Pay button', /PASS \d+\/\d+/.test(stamp) && bStamp.y > bBtn.y && bStamp.y - (bBtn.y + bBtn.height) < 140, `${stamp.replace(/\s+/g, ' ')}, transaction ${txn}`);
  check('Order: payments left drops to 4 of 5 after one sale', /PAYMENTS LEFT THIS SESSION: 4 OF 5/.test(await page.getByTestId('payments-left').innerText()));
  check('Order: the 11 checks are collapsed behind "Show all checks"', (await page.locator('table[aria-label="All read-back checks"]').count()) === 0 && await page.getByRole('button', { name: /show all checks/i }).isVisible());
  await page.waitForTimeout(1500);
  await shot('04-order-paid.png');
  await page.getByRole('button', { name: /show all checks/i }).click();
  const rows = await page.locator('table[aria-label="All read-back checks"] tbody tr').allInnerTexts();
  check('Order: all read-back checks are PASS once expanded', rows.length >= 11 && rows.every((r) => /PASS\s*$/.test(r.trim())), `${rows.length} checks`);
  check('Order: Commercial card = Yes', rows.some((r) => /Commercial card.*Yes.*PASS/s.test(r)));
  check('Order: read-back panel shows the 3 line items', (await page.locator('.card', { hasText: 'Visa data read back from Braintree' }).locator('tbody tr').count()) === 3);
  await noHScroll('Order (paid, checks open)');
  await page.setViewportSize({ width: 1100, height: 900 });
  await noHScroll('Order (paid, 1100px wide)');
  await shot('04d-order-paid-checks-open.png');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('button', { name: /submit same order again/i }).click();
  await page.waitForSelector('text=/ALREADY CHARGED/');
  check('Order: same order again says ALREADY CHARGED', true);
  await shot('04b-order-duplicate.png');
  await page.getByRole('button', { name: /see readiness/i }).click();
  await page.waitForSelector('.score');
  await page.waitForTimeout(1800);
  const after = Number(await page.locator('.score').innerText());
  const before = Number(await page.locator('.score-before').innerText());
  check('Readiness: before (Level 1) 0 and after (LineGrade) 100, from the validator', before === 0 && after === 100, `${before} -> ${after}`);
  check('Readiness: validator table lists 10 checks', (await page.locator('.checks3').first().locator('tbody tr').count()) === 10);
  const headline = (await page.getByTestId('fee-headline').innerText()).trim();
  check('Readiness: headline is the rate difference from rates.json, labelled ESTIMATE', /^≈ 0\.95% back on purchasing-card sales$/.test(headline) && (await page.locator('.fee-main + .chip.estimate').count()) === 1, headline);
  check('Readiness: slider defaults to $500,000 with a live yearly ESTIMATE of $4,750', (await page.getByTestId('volume-value').innerText()).trim() === '$500,000' && (await page.getByTestId('yearly-value').innerText()).includes('$4,750') && (await page.locator('.vol .chip.estimate').count()) === 1);
  const setSlider = (v) => page.locator('#volume').evaluate((el, val) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(val)); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setSlider(0);
  const lo = [(await page.getByTestId('volume-value').innerText()).trim(), (await page.getByTestId('yearly-value').innerText()).trim()];
  await setSlider(100);
  const hi = [(await page.getByTestId('volume-value').innerText()).trim(), (await page.getByTestId('yearly-value').innerText()).trim()];
  await setSlider(50);
  check('Readiness: slider range $50,000 to $5,000,000 gives about $475 to $47,500 a year', lo[0] === '$50,000' && lo[1].includes('$475') && hi[0] === '$5,000,000' && hi[1].includes('$47,500'), `${lo.join(' -> ')} | ${hi.join(' -> ')}`);
  check('Readiness: states the all-qualifying-volume assumption and the purchasing/corporate case', /ASSUMES ALL VOLUME IS ON QUALIFYING CARDS/.test(await page.locator('.vol').innerText()) && /PURCHASING \/ CORPORATE CARD CASE/.test(await page.locator('.vol').innerText()));
  const rangeText = (await page.getByTestId('fee-range').innerText()).trim();
  check('Readiness: the $958 range and the table stay as detail, labelled ESTIMATE', /\$2\.40 – \$11\.49/.test(rangeText) && (await page.locator('.navy tbody tr').count()) === 3 && /DIFFERENCE · ESTIMATE/i.test(await page.locator('.navy thead').innerText()), rangeText);
  const l3 = (await page.locator('.stats .stat').nth(2).innerText()).replace(/\s+/g, ' ');
  check('Readiness: Level 3 orders counts only this session (1 sale made in this run)', /^1 LEVEL 3 ORDERS/i.test(l3), l3);
  const href = await page.locator('.estimate-box a').first().getAttribute('href');
  check('Readiness: cites the Visa schedule with its URL and dates', /usa\.visa\.com/.test(href) && /EFFECTIVE 2026-10-24/.test(await page.locator('.estimate-box').innerText()) && /ACCESSED 2026-11-07/.test(await page.locator('.estimate-box').innerText()));
  check('Readiness: SYNTHETIC DATA chip persists; footer wordmark lowercase with tick', await page.locator('.topbar .chip.synthetic').isVisible() && (await page.locator('.wordmark span').innerText()) === 'linegrade' && (await page.locator('.wordmark .tick').count()) === 1);
  await shot('05-readiness.png');
  await ctx.close();

  // ---------- returning browsers: an old/expired session cookie, and a browser without AbortSignal.timeout ----------
  // The wake screen must not appear and the app must load fast whenever /health is ok.
  const loadsFast = async (label, ctxOpts, init) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...ctxOpts });
    if (init) await c.addInitScript(init);
    const pgx = await c.newPage();
    const t = Date.now();
    await pgx.goto(BASE, { timeout: 120000 });
    await pgx.waitForSelector('.preloader', { state: 'detached', timeout: 8000 }).catch(() => {});
    await pgx.getByRole('button', { name: /load demo catalog/i }).waitFor({ timeout: 8000 });
    await pgx.waitForFunction(() => !document.querySelector('[data-testid="wake-screen"]'), null, { timeout: 8000 });
    const ms = Date.now() - t;
    check(`${label}: loads in under 5 s and never shows the waking-up screen (server warm)`, ms < 5000 && (await pgx.getByTestId('wake-screen').count()) === 0, `${(ms / 1000).toFixed(1)} s`);
    await c.close();
  };
  const host = new URL(BASE);
  await loadsFast('Returning browser with an old session cookie', { storageState: { cookies: [{ name: 'lg_sid', value: 'OLDOLDOLDOLDOLDOLDOLDOLD', domain: host.hostname, path: '/', httpOnly: true, secure: host.protocol === 'https:', sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 }], origins: [] } });
  await loadsFast('Older browser without AbortSignal.timeout', {}, 'delete AbortSignal.timeout;');

  // ---------- PayPal rail (only when the server has the PayPal credentials; on Render without them it must stay hidden) ----------
  const hz = await (await fetch(`${BASE}/health`)).json();
  const pctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // fresh browser = fresh session
  const pg = await pctx.newPage();
  pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shotPg = async (name) => {
    await pg.addStyleTag({ content: '.topbar{position:static !important}' });
    await pg.screenshot({ path: path.join(OUT, name), fullPage: true });
    await pg.evaluate(() => { document.querySelectorAll('style').forEach((st) => { if (st.textContent === '.topbar{position:static !important}') st.remove(); }); });
  };
  await pg.goto(`${BASE}/?screen=order`, { timeout: 120000 });
  await pg.waitForSelector('.preloader', { state: 'detached', timeout: 8000 }).catch(() => {});
  await pg.getByRole('button', { name: /with linegrade/i }).click();
  await pg.waitForSelector('table.t tbody tr');
  if (hz.paypalRail !== 'on') {
    check('PayPal rail hidden: no rail selector on the Order screen (server has no PayPal credentials)', (await pg.getByRole('group', { name: 'Payment rail' }).count()) === 0);
    check('PayPal rail hidden: Braintree is the only rail', /BRAINTREE SANDBOX/.test(await pg.getByTestId('rail-line').innerText()));
  } else {
    const sel = pg.getByRole('group', { name: 'Payment rail' });
    check('Rails: selector shows Braintree and PayPal, Braintree is the default', await sel.isVisible() && (await sel.getByRole('button', { name: 'Braintree' }).getAttribute('aria-pressed')) === 'true');
    check('Rails (Braintree): pay line claims the commercial test card', /COMMERCIAL/.test(await pg.getByTestId('rail-line').innerText()));
    await pg.waitForTimeout(900);
    await shotPg('06a-order-rail-braintree.png');
    await sel.getByRole('button', { name: 'PayPal' }).click();
    await pg.waitForSelector('[data-testid="pp-commercial-note"]');
    await pg.waitForSelector('table.t tbody tr');
    await pg.waitForTimeout(900);
    const railLine = await pg.getByTestId('rail-line').innerText();
    check('Rails (PayPal): no claim that the card is commercial; a note says sandbox gives no BIN data', !/COMMERCIAL/.test(railLine) && /no card BIN data/i.test(await pg.getByTestId('pp-commercial-note').innerText()), railLine);
    const units = await pg.locator('table.t tbody tr td:nth-child(3)').allInnerTexts();
    check('Rails (PayPal): units shown as PayPal words, not EA/BX codes', units.join(',') === 'BOX,PACK,CASE', units.join(','));
    await shotPg('06b-order-rail-paypal.png');
    await pg.getByRole('button', { name: /pay .*958\.05.* with paypal sandbox/i }).click();
    await pg.waitForSelector('[data-testid="txn-id"]', { timeout: 60000 });
    await pg.waitForSelector('.stamp');
    const capId = (await pg.getByTestId('txn-id').innerText()).trim();
    const stampPp = (await pg.getByTestId('stamp').innerText()).trim();
    const notEchoed = await pg.getByTestId('pp-not-echoed').count();
    const note = notEchoed ? (await pg.getByTestId('pp-not-echoed').innerText()) : '';
    check('PayPal: captured, capture id shown', /^[A-Z0-9]{10,}$/.test(capId), capId);
    check('PayPal: stamp is PASS n/n only if the read-back returned Level 3, otherwise ACCEPTED with the explanation', notEchoed ? (/ACCEPTED/.test(stampPp) && /LEVEL 3 SENT; PAYPAL DOES NOT RETURN IT/i.test(note)) : /PASS \d+\/\d+/.test(stampPp), `${stampPp} | ${notEchoed ? note : 'level 3 echoed'}`);
    await pg.getByRole('button', { name: 'Show all checks' }).click();
    const rbText = await pg.locator('table[aria-label="All read-back checks"]').innerText();
    check('PayPal: read-back table is headed "PayPal returned" and has no commercial-card row', /PayPal returned/i.test(rbText) && !/Commercial card/i.test(rbText));
    check('PayPal: payments left drops to 4 of 5', /PAYMENTS LEFT THIS SESSION: 4 OF 5/.test(await pg.getByTestId('payments-left').innerText()));
    await pg.waitForTimeout(1500);
    await shotPg('06c-order-paypal-paid.png');
    await pg.getByRole('button', { name: /submit same order again/i }).click();
    await pg.waitForSelector('.banner');
    check('PayPal: same order again says ALREADY CHARGED on PayPal', /ALREADY CHARGED/.test(await pg.locator('.banner').innerText()) && /PayPal/.test(await pg.locator('.banner').innerText()));
    console.log(`        PayPal capture ${capId}`);
  }
  await pctx.close();

  // ---------- reduced motion ----------
  const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  await rp.goto(`${BASE}/?screen=enrich`);
  await rp.waitForSelector('.counter');
  check('Reduced motion: no preloader', (await rp.locator('.preloader').count()) === 0);
  await rp.waitForTimeout(150);
  check('Reduced motion: enrichment list appears at once (40 / 40)', (await rp.locator('.counter').innerText()).trim() === '40 / 40');
  const anim = await rp.evaluate(() => ['.orb', '.progress i', '.stream-row'].map((sel) => getComputedStyle(document.querySelector(sel)).animationName));
  check('Reduced motion: animations are off', anim.every((n) => n === 'none'), anim.join(','));
  const health = await (await fetch(`${BASE}/health`)).json();
  if (health.codeList === 'none') {
    // Hosted case: no licensed UNSPSC list. Replay must be labelled, Re-run must be off with the note.
    await rp.waitForSelector('[data-testid="ai-limits"]');
    check('No code list: Re-run AI is disabled', await rp.getByRole('button', { name: /^Re-run AI/ }).isDisabled());
    check('No code list: note says live AI runs locally, demo replays a saved run', /LIVE AI RUNS LOCALLY WITH THE LICENSED UNSPSC LIST; THIS DEMO REPLAYS A SAVED RUN/i.test(await rp.locator('[data-testid="ai-limits"]').innerText()), (await rp.locator('[data-testid="ai-limits"]').innerText()).slice(0, 120));
    check('No code list: replay is labelled REPLAY', /REPLAY/.test(await rp.locator('main').innerText()));
  }
  await rp.goto(`${BASE}/?screen=readiness`);
  await rp.waitForSelector('.score');
  await rp.waitForLoadState('networkidle'); // remote hosts answer slower: let /api/readiness land before reading the score
  const instant = Number(await rp.locator('.score').innerText());
  check('Reduced motion: score shown immediately (no count-up)', instant > 0, `${instant}`);
  const drawAnim = await rp.evaluate(() => getComputedStyle(document.querySelector('.stats.draw .stat'), '::after').animationName);
  check('Reduced motion: stat borders not animated', drawAnim === 'none', drawAnim);
  const tick = await rp.evaluate(() => { const t = document.querySelector('.wordmark .tick'); const cs = getComputedStyle(t); return [cs.animationName, cs.strokeDashoffset]; });
  check('Reduced motion: logo tick is fully drawn, not animated', tick[0] === 'none' && parseFloat(tick[1]) === 0, tick.join(','));
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
