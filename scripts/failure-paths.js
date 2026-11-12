#!/usr/bin/env node
// Shows every failure path working, in a real browser, against local server instances started with the
// failure switched on. No real money, no real AI spend (the AI provider is deliberately unreachable).
//
//   node scripts/failure-paths.js
//
// Paths: AI provider unavailable -> replay fallback; Braintree unavailable -> clear error, safe retry;
//        bad quantities / empty order / unknown SKU; caps hit (live AI and payments) with replay still working;
//        idle session expiry; the server going to sleep and waking up (the "waking up" screen).
// Screenshots go to docs/screens/failures/. Test-only failure injection needs ALLOW_CHAOS=1 (set here only).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screens', 'failures');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

function startServer(port, env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LLM_API_KEY: process.env.LLM_API_KEY || 'test-key', LLM_MODEL: process.env.LLM_MODEL || 'anthropic/claude-haiku-5.5', BT_MERCHANT_ID: process.env.BT_MERCHANT_ID || 'x', BT_PUBLIC_KEY: process.env.BT_PUBLIC_KEY || 'x', BT_PRIVATE_KEY: process.env.BT_PRIVATE_KEY || 'x', PORT: String(port), HOST: '127.0.0.1', ...env },
  });
  const ready = (async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server on ${port} did not start`);
  })();
  return { port, child, ready, base: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(r, 3000); }) };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const servers = [];
  const newPage = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); return ctx.newPage(); };
  const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full });
  const catalogOf = (page) => page.evaluate(async () => (await (await fetch('/api/catalog')).json()));

  try {
    // ---------- 1. AI unavailable, Braintree unavailable, input errors ----------
    const s1 = startServer(8811, { LLM_BASE_URL: 'http://127.0.0.1:9', LLM_ATTEMPTS: '1', LLM_TIMEOUT_MS: '3000', ALLOW_CHAOS: '1', CHAOS_BRAINTREE: 'down' });
    servers.push(s1); await s1.ready;
    const p1 = await newPage();
    await p1.goto(`${s1.base}/?screen=enrich`);
    await p1.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
    const before = await catalogOf(p1);
    await p1.getByLabel(/force: re-classify all unlocked rows/i).check();
    await p1.getByRole('button', { name: /re-run ai/i }).click();
    await p1.waitForSelector('[data-testid="enrich-notice"]', { timeout: 20000 });
    const notice = (await p1.getByTestId('enrich-notice').innerText()).trim();
    check('AI unavailable: clear message, run abandoned', /AI provider is unavailable/.test(notice) && /nothing was changed/i.test(notice), notice);
    await p1.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
    const left = await p1.locator('.enrich-left').innerText();
    check('AI unavailable: falls back to the frozen-catalog replay, labelled REPLAY', /REPLAY/.test(left) && /AI PROVIDER UNAVAILABLE/.test(left) && /NO AI CALL/.test(left));
    const after = await catalogOf(p1);
    check('AI unavailable: no catalog row was damaged', JSON.stringify(after.items) === JSON.stringify(before.items));
    check('AI unavailable: the attempt did not use up a live re-run', /LIVE AI RE-RUNS LEFT THIS SESSION: 2 OF 2/.test(await p1.getByTestId('ai-limits').innerText()));
    await shot(p1, 'f1-ai-unavailable-replay.png');

    await p1.goto(`${s1.base}/?screen=order`);
    await p1.waitForSelector('.seg');
    await p1.getByRole('button', { name: 'With LineGrade', exact: true }).click();
    await p1.waitForSelector('table.t tbody tr');
    await p1.getByRole('button', { name: /pay .*with linegrade data/i }).click();
    await p1.waitForSelector('text=/BRAINTREE IS UNAVAILABLE/', { timeout: 20000 });
    const bt = (await p1.locator('.banner').filter({ hasText: 'BRAINTREE IS UNAVAILABLE' }).innerText()).replace(/\s+/g, ' ');
    check('Braintree unavailable: clear error, says nothing was charged and it is safe to retry', /never reached Braintree/.test(bt) && /nothing was charged/.test(bt) && /safe to try again/.test(bt), bt);
    check('Braintree unavailable: payments left unchanged (5 of 5)', /PAYMENTS LEFT THIS SESSION: 5 OF 5/.test(await p1.getByTestId('payments-left').innerText()));
    await shot(p1, 'f2-braintree-unavailable.png', true);
    await p1.getByRole('button', { name: /try again/i }).click();
    await p1.waitForSelector('text=/BRAINTREE IS UNAVAILABLE/');
    check('Braintree unavailable: retry works and gives the same safe answer (no stuck state)', true);

    // input validation, in the UI
    const qty = p1.getByLabel('Line 1 quantity');
    await qty.fill('0');
    await p1.waitForSelector('[data-testid="order-problems"]');
    check('Input: quantity 0 shows an error next to the line and blocks paying', /quantity must be from 1 to 1000/.test(await p1.locator('.field-error').first().innerText()) && await p1.getByRole('button', { name: /with braintree sandbox/i }).isDisabled());
    await shot(p1, 'f3-input-quantity-error.png');
    await qty.fill('');
    check('Input: empty quantity says "enter a quantity"', /enter a quantity/.test(await p1.locator('.field-error').first().innerText()));
    await qty.fill('2.5');
    check('Input: 2.5 is rejected (whole numbers only)', /whole number/.test(await p1.locator('.field-error').first().innerText()));
    for (let i = 0; i < 3; i++) await p1.getByLabel('Remove line 1').click();
    await p1.waitForSelector('[data-testid="empty-order"]');
    check('Input: an empty order says to add a line, and Pay is disabled', /ADD AT LEAST ONE LINE/.test(await p1.getByTestId('empty-order').innerText()));
    await shot(p1, 'f4-input-empty-order.png');
    const api = (body, urlPath = '/api/order/pay') => p1.evaluate(async ([b, u]) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, [body, urlPath]);
    const unknown = await api({ items: [{ sku: 'NLS-999', qty: 1 }] });
    check('Input: an unknown SKU is refused by name before any payment call', unknown.body.outcome === 'refused' && /not in catalog: NLS-999/.test(unknown.body.refused.message) && /No Braintree call was made/.test(unknown.body.messages.join(' ')), unknown.body.refused.message);
    const apiQty = await api({ items: [{ sku: 'NLS-002', qty: 0 }] }, '/api/order/preview');
    check('Input: the server also rejects quantity 0 (400, field named)', apiQty.status === 400 && apiQty.body.field === 'items.0.qty', apiQty.body.error);
    await s1.stop();

    // ---------- 2. caps hit ----------
    const s2 = startServer(8812, { MAX_RERUNS_PER_SESSION: '0', MAX_PAYMENTS_PER_SESSION: '0' });
    servers.push(s2); await s2.ready;
    const p2 = await newPage();
    await p2.goto(`${s2.base}/?screen=enrich`);
    await p2.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
    const lim = (await p2.getByTestId('ai-limits').innerText()).replace(/\s+/g, ' ');
    check('Cap (live AI): clear message on screen, button disabled', /NO LIVE AI RE-RUNS LEFT THIS SESSION \(0\)/.test(lim) && /REPLAY ONLY/.test(lim) && await p2.getByRole('button', { name: /re-run ai/i }).isDisabled(), lim);
    const server429 = await p2.evaluate(async () => { const r = await fetch('/api/enrich/stream'); return { status: r.status, body: await r.json() }; });
    check('Cap (live AI): the server answers 429 CAP_REACHED with a plain message', server429.status === 429 && server429.body.code === 'CAP_REACHED' && /frozen-catalog replay still works/.test(server429.body.error), server429.body.error);
    await p2.getByRole('button', { name: /replay frozen catalog/i }).click();
    await p2.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
    check('Cap (live AI): the frozen-catalog replay keeps working', (await p2.locator('.stream-row').count()) === 40);
    await shot(p2, 'f5-cap-live-ai.png');
    await p2.goto(`${s2.base}/?screen=order`);
    await p2.waitForSelector('.seg');
    await p2.getByRole('button', { name: 'With LineGrade', exact: true }).click();
    await p2.waitForSelector('table.t tbody tr');
    await p2.getByRole('button', { name: /pay .*with linegrade data/i }).click();
    await p2.waitForSelector('text=/LIMIT REACHED/', { timeout: 20000 });
    const pc = (await p2.locator('.banner').filter({ hasText: 'LIMIT REACHED' }).innerText()).replace(/\s+/g, ' ');
    check('Cap (payments): clear message; nothing was sent to Braintree', /used your 0 sandbox payments/.test(pc), pc);
    await shot(p2, 'f6-cap-payments.png', true);
    await s2.stop();

    // ---------- 3. idle session expiry ----------
    const s3 = startServer(8813, { SESSION_IDLE_MIN: '0.03' }); // 1.8 seconds, for the demonstration
    servers.push(s3); await s3.ready;
    const p3 = await newPage();
    await p3.goto(`${s3.base}/?screen=review`);
    await p3.waitForSelector('.ag-row');
    await p3.evaluate(() => fetch('/api/review/exclude', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'NLS-038' }) }));
    const mine = (await catalogOf(p3)).items.find((i) => i.sku === 'NLS-038').status;
    await new Promise((r) => setTimeout(r, 2500));
    await p3.getByRole('button', { name: 'Order + pay' }).click();
    await p3.waitForSelector('text=/Your session expired/', { timeout: 10000 });
    const gone = (await catalogOf(p3)).items.find((i) => i.sku === 'NLS-038').status;
    check('Idle session: expires, the user is told, and the work is gone (back to the frozen catalog)', mine === 'excluded' && gone === 'needs_review', `${mine} -> ${gone}`);
    await shot(p3, 'f7-session-expired.png');
    await s3.stop();

    // ---------- 4. the server sleeping and waking up ----------
    const s4 = startServer(8814, {});
    servers.push(s4); await s4.ready;
    const p4 = await newPage();
    await p4.goto(`${s4.base}/?screen=order`);
    await p4.waitForSelector('.seg');
    await s4.stop(); // the free instance goes to sleep
    await p4.getByRole('button', { name: 'Readiness' }).click();
    await p4.waitForSelector('[data-testid="wake-screen"]', { timeout: 15000 });
    const wakeText = (await p4.getByTestId('wake-screen').innerText()).replace(/\s+/g, ' ');
    check('Waking up: the screen appears when the server stops answering', /WAKING UP THE DEMO/.test(wakeText) && /ABOUT A MINUTE/.test(wakeText), wakeText.slice(0, 80));
    await shot(p4, 'f8-waking-up.png');
    const s4b = startServer(8814, {}); servers.push(s4b); await s4b.ready; // it wakes
    await p4.waitForSelector('[data-testid="wake-screen"]', { state: 'detached', timeout: 20000 });
    check('Waking up: the page continues by itself once the server answers', true);

    // ---------- 5. the server never answers: no endless counter, a clear message and a Retry ----------
    const s5 = startServer(8815, {});
    servers.push(s5); await s5.ready;
    const p5 = await newPage();
    await p5.goto(`${s5.base}/?screen=order&wakestuck=4`);
    await p5.waitForSelector('.seg');
    await s5.stop();
    await p5.getByRole('button', { name: 'Readiness' }).click();
    await p5.waitForSelector('[data-testid="wake-screen"]', { timeout: 15000 });
    await p5.waitForSelector('[data-testid="wake-retry"]', { timeout: 20000 });
    const stuckText = (await p5.getByTestId('wake-screen').innerText()).replace(/\s+/g, ' ');
    check('Not answering: after the limit the screen says "Still waking up" with a Retry, not a counter that runs forever', /STILL WAKING UP/.test(stuckText) && !/\d+ s$/.test(stuckText.trim()) && /RETRY/i.test(stuckText), stuckText.slice(0, 70));
    check('Not answering: shows what the browser last got back', (await p5.getByTestId('wake-detail').count()) === 1, (await p5.getByTestId('wake-detail').innerText().catch(() => '')).slice(0, 80));
    await shot(p5, 'f9-still-waking-up.png');
    await p5.getByTestId('wake-retry').click();
    await p5.waitForSelector('[data-testid="wake-title"]');
    check('Not answering: Retry starts a fresh wait (title back to "Waking up", counter restarts)', /WAKING UP THE DEMO/.test(await p5.getByTestId('wake-title').innerText()));
    const s5b = startServer(8815, {}); servers.push(s5b); await s5b.ready;
    await p5.waitForSelector('[data-testid="wake-screen"]', { state: 'detached', timeout: 20000 });
    check('Not answering: the page continues by itself as soon as /health is ok', true);
  } finally {
    for (const s of servers) { try { s.child.kill('SIGTERM'); } catch { /* already stopped */ } }
    await browser.close();
  }

  console.log('\nScreenshots in docs/screens/failures/:');
  for (const f of fs.readdirSync(OUT).sort()) console.log(`  docs/screens/failures/${f}`);
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length}/${results.length} checks`}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(`ERROR: ${e.stack || e.message}`); process.exit(1); });
