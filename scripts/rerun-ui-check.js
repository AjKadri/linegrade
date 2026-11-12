#!/usr/bin/env node
// UI check for "Re-run AI never does nothing silently". The classifier is replaced by a stub that streams the
// frozen catalog's rows (no LLM call, no cost), so this runs anywhere, with or without the UNSPSC list.
//
//   node scripts/rerun-ui-check.js        (or: npm run check:rerun)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-rerun-ui-'));
const listFile = path.join(tmp, 'unspsc-subset.csv'); fs.writeFileSync(listFile, 'commodity_code,commodity_title,class_code,class_title\n');
process.env.UNSPSC_LIST_PATH = listFile; // pretend the licensed list is installed so live AI is enabled
process.env.LLM_API_KEY = 'test-key'; process.env.LLM_MODEL = 'test-model'; delete process.env.LIVE_AI;
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) if (!process.env[k]) process.env[k] = 'test-dummy';

const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');
const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'enriched-catalog.json'), 'utf8'));

let runs = 0;
const stub = async (o) => {
  runs += 1;
  const items = Object.values(frozen.items);
  o.onProgress({ type: 'plan', total: items.length, toClassify: items.length, actions: {} });
  for (const it of items) { o.onProgress({ type: 'item', sku: it.sku, action: 'classify', reason: 'force', item: it }); await new Promise((r) => setTimeout(r, 15)); }
  return { items: frozen.items, meta: { model: frozen.meta.model, last_run: { classified: items.length, reused: 0, locked: 0, cost_usd: 0 } } };
};

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

(async () => {
  const app = createApp({ sessions: new SessionManager({ dir: tmp, idleMs: 7_200_000 }), usage: new Usage(path.join(tmp, 'usage.json')), enrichCatalog: stub });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${base}/?screen=enrich`);
    await page.waitForFunction(() => /^40 \/ 40$/.test(document.querySelector('.counter')?.textContent.trim() || ''), null, { timeout: 15000 });
    const btn = page.getByTestId('rerun');
    check('First run: the button says "Run AI on this catalog"', /^Run AI on this catalog/i.test((await btn.innerText()).trim()));
    await btn.click();
    await page.waitForFunction(() => /LIVE AI RUN/.test(document.querySelector('.enrich-left')?.textContent || ''), null, { timeout: 10000 });
    await page.waitForFunction(() => /40 NEW · 0 REUSED · 0 LOCKED/.test(document.querySelector('.enrich-left')?.textContent || ''), null, { timeout: 15000 });
    check('First run: rows stream and it ends with "40 NEW · 0 REUSED · 0 LOCKED"', true);
    await page.waitForFunction(() => /^Re-run AI/i.test((document.querySelector('[data-testid="rerun"]')?.textContent || '').trim()), null, { timeout: 10000 });
    check('Afterwards the button says "Re-run AI (keeps locked rows)"', /Re-run AI \(keeps locked rows\)/i.test((await btn.innerText()).trim()));
    const left0 = (await page.getByTestId('ai-limits').innerText()).trim();
    await btn.click();
    await page.getByTestId('enrich-notice').waitFor({ timeout: 10000 });
    const note = (await page.getByTestId('enrich-notice').innerText()).replace(/\s+/g, ' ');
    check('Nothing changed: no silent no-op, the message names the counts and Force', /Nothing has changed since the last run \(0 new, 40 reused, 0 locked\)\. Tick Force to re-classify all unlocked rows\./.test(note), note);
    check('Nothing changed: no run started and no re-run was used up', runs === 1 && (await page.getByTestId('ai-limits').innerText()).trim() === left0, `${runs} run(s); ${left0}`);
    check('Nothing changed: the rows stay on screen', (await page.locator('.stream-row').count()) === 40);
    await page.getByLabel(/force: re-classify all unlocked rows/i).check();
    await btn.click();
    await page.waitForFunction(() => /40 NEW/.test(document.querySelector('.enrich-left')?.textContent || ''), null, { timeout: 15000 });
    check('Force on: a run happens and ends with the summary', runs === 2);
    await page.screenshot({ path: path.join(tmp, 'rerun-ui.png') });
  } finally {
    await browser.close(); server.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? `FAIL: ${failed} of ${results.length}` : `PASS: ${results.length}/${results.length} checks`}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
