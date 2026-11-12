// Re-run AI never does nothing silently: no run and no re-run used when nothing changed; the first run classifies all unlocked rows.
// The classifier is replaced by a stub (opts.enrichCatalog); no LLM call is made.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-rerun-'));
const listFile = path.join(tmp(), 'unspsc-subset.csv'); fs.writeFileSync(listFile, 'commodity_code,commodity_title,class_code,class_title\n');
process.env.UNSPSC_LIST_PATH = listFile; // a list "exists", so live AI counts as available
process.env.LLM_API_KEY = 'test-key'; process.env.LLM_MODEL = 'test-model'; delete process.env.LIVE_AI;
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) process.env[k] = 'test-dummy';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');

const calls = [];
const stub = async (o) => {
  calls.push({ force: o.force });
  o.onProgress({ type: 'plan', total: 40, toClassify: 40, actions: {} });
  return { items: {}, meta: { model: 'stub', counts: {}, last_run: { classified: 40, reused: 0, locked: 0, cost_usd: 0 } } };
};
let server; let base;
test.before(async () => {
  const app = createApp({ sessions: new SessionManager({ dir: tmp(), idleMs: 7_200_000 }), usage: new Usage(path.join(tmp(), 'usage.json')), enrichCatalog: stub });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { calls.length = 0; });

function browser() {
  let cookie = '';
  const b = { async call(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* sse */ }
    return { status: res.status, body: json, text };
  } };
  b.get = (u) => b.call('GET', u); b.post = (u, x) => b.call('POST', u, x);
  return b;
}
const limits = async (b) => (await b.get('/api/state')).body.limits;

test('first run from the replay: classifies every unlocked row even with Force off, and uses one re-run', async () => {
  const b = browser();
  const before = await limits(b);
  assert.strictEqual(before.firstRun, true);
  assert.strictEqual(before.rerunsLeft, 2);
  const r = await b.get('/api/enrich/stream');
  assert.match(r.text, /event: done/);
  assert.deepStrictEqual(calls, [{ force: true }], 'Force was forced on for the first run');
  const after = await limits(b);
  assert.strictEqual(after.firstRun, false);
  assert.strictEqual(after.rerunsLeft, 1);
});

test('nothing changed: no run starts, no re-run is used up, and the message says why', async () => {
  const b = browser();
  await b.get('/api/enrich/stream'); // the first run
  calls.length = 0;
  const r = await b.get('/api/enrich/stream');
  assert.match(r.text, /event: nothing/);
  assert.match(r.text, /Nothing has changed since the last run \(0 new, 40 reused, 0 locked\)\. Tick Force to re-classify all unlocked rows\./);
  assert.doesNotMatch(r.text, /event: plan|event: done/);
  assert.strictEqual(calls.length, 0, 'the classifier was not called');
  assert.strictEqual((await limits(b)).rerunsLeft, 1, 'no re-run was used up');
  assert.strictEqual((await limits(b)).firstRun, false);
});

test('locked rows are counted in the message; Force starts a run and uses a re-run', async () => {
  const b = browser();
  await b.get('/api/enrich/stream');
  assert.strictEqual((await b.post('/api/review/approve', { sku: 'NLS-004' })).status, 200);
  calls.length = 0;
  const none = await b.get('/api/enrich/stream');
  assert.match(none.text, /\(0 new, 39 reused, 1 locked\)/);
  assert.strictEqual(calls.length, 0);
  const forced = await b.get('/api/enrich/stream?force=1');
  assert.match(forced.text, /event: done/);
  assert.deepStrictEqual(calls, [{ force: true }]);
  assert.strictEqual((await limits(b)).rerunsLeft, 0);
});

test('resetting the demo makes the next run a first run again', async () => {
  const b = browser();
  await b.get('/api/enrich/stream');
  assert.strictEqual((await limits(b)).firstRun, false);
  await b.post('/api/catalog/reset');
  assert.strictEqual((await limits(b)).firstRun, true);
  calls.length = 0;
  await b.get('/api/enrich/stream');
  assert.deepStrictEqual(calls, [{ force: true }]);
});
