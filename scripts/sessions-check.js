#!/usr/bin/env node
// Two browsers at the same time, each in its own session. Proves one browser's approvals, order and order
// counter never show up in the other. Makes TWO real Braintree SANDBOX sales (one per browser), synthetic order.
//
//   BASE=http://127.0.0.1:8787 node scripts/sessions-check.js

const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

async function counts(page) { return page.evaluate(async () => (await (await fetch('/api/catalog')).json()).counts); }
async function level3(page) { return page.evaluate(async () => { const r = await (await fetch('/api/readiness')).json(); return { n: r.level3Orders, last: r.lastOrder && r.lastOrder.transactionId }; }); }

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const mk = async (name) => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); return { name, ctx, page }; };
  const [A, B] = await Promise.all([mk('A'), mk('B')]);

  // Both open the app at the same moment.
  await Promise.all([A, B].map((x) => x.page.goto(`${BASE}/?screen=review`, { timeout: 180000 })));
  await Promise.all([A, B].map((x) => x.page.waitForSelector('.ag-row', { timeout: 60000 })));
  const idA = (await A.ctx.cookies()).find((c) => c.name === 'lg_sid')?.value;
  const idB = (await B.ctx.cookies()).find((c) => c.name === 'lg_sid')?.value;
  check('Each browser has its own session cookie', !!idA && !!idB && idA !== idB, `${idA?.slice(0, 6)}… vs ${idB?.slice(0, 6)}…`);
  const cookie = (await A.ctx.cookies()).find((c) => c.name === 'lg_sid');
  check('Session cookie is HttpOnly and SameSite=Lax', cookie.httpOnly === true && cookie.sameSite === 'Lax');

  const a0 = await counts(A.page); const b0 = await counts(B.page);
  check('Both start on the same frozen catalog', a0.needs_review === b0.needs_review && a0.needs_review > 0, `${a0.needs_review} rows need review in each`);

  // A reviews every flagged row (approve, or exclude when no code); B does nothing.
  let needs = a0.needs_review;
  while (needs > 0) {
    const panel = A.page.locator('.panel');
    const approve = panel.getByRole('button', { name: /^Approve/ });
    if (await approve.isEnabled()) await approve.click(); else await panel.getByRole('button', { name: /^Exclude/ }).click();
    await A.page.waitForFunction((n) => Number(document.querySelector('.stats .stat .n').textContent) < n, needs, { timeout: 8000 });
    needs = Number(await A.page.locator('.stats .stat .n').first().innerText());
  }
  const a1 = await counts(A.page); const b1 = await counts(B.page);
  check('A finished review (0 need review, rows locked)', a1.needs_review === 0 && a1.approved > 0, `A: ${a1.needs_review} need review, ${a1.approved} approved/locked`);
  check('B is untouched by A\'s approvals', b1.needs_review === b0.needs_review && b1.approved === 0, `B: ${b1.needs_review} need review, ${b1.approved} approved`);

  // B reloads its page from the server: still the frozen catalog.
  await B.page.reload(); await B.page.waitForSelector('.ag-row');
  check('B\'s review screen still shows every flagged row after a reload', Number(await B.page.locator('.stats .stat .n').first().innerText()) === b0.needs_review);

  // A can order (all rows OK); B cannot yet (its flagged rows are unreviewed) when it orders a flagged SKU.
  const refusedForB = await B.page.evaluate(async () => (await (await fetch('/api/order/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ sku: 'NLS-028', qty: 1 }] }) })).json()));
  const refusedForA = await A.page.evaluate(async () => (await (await fetch('/api/order/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ sku: 'NLS-028', qty: 1 }] }) })).json()));
  check('Same SKU, different answers: refused as needs_review for B, as excluded for A', (refusedForB.refused?.details.needsReview || []).includes('NLS-028') && (refusedForA.refused?.details.excluded || []).includes('NLS-028'));

  // Both pay at the same time (two sandbox sales).
  await Promise.all([A, B].map(async (x) => {
    await x.page.goto(`${BASE}/?screen=order`, { timeout: 60000 });
    await x.page.waitForSelector('.seg');
    await x.page.getByRole('button', { name: /with linegrade/i }).click();
    await x.page.waitForSelector('table.t tbody tr');
  }));
  await Promise.all([A, B].map((x) => x.page.getByRole('button', { name: /pay .*with braintree sandbox/i }).click()));
  await Promise.all([A, B].map((x) => x.page.waitForSelector('[data-testid="txn-id"]', { timeout: 60000 })));
  const txA = (await A.page.locator('[data-testid="txn-id"]').innerText()).trim();
  const txB = (await B.page.locator('[data-testid="txn-id"]').innerText()).trim();
  check('Both payments went through, with different transactions', !!txA && !!txB && txA !== txB, `A ${txA}, B ${txB}`);

  const la = await level3(A.page); const lb = await level3(B.page);
  check('Each browser counts only its own order (1 and 1, not 2)', la.n === 1 && lb.n === 1, `A: ${la.n} (${la.last}), B: ${lb.n} (${lb.last})`);
  check('Each browser\'s last order is its own transaction', la.last === txA && lb.last === txB);

  await browser.close();
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length}/${results.length} checks`}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(`ERROR: ${e.stack || e.message}`); process.exit(1); });
