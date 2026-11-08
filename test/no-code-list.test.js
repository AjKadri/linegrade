// Both UNSPSC list files are absent (the Render case). Own file = own process, so the env is read at load.
process.env.UNSPSC_LIST_PATH = '/nonexistent/unspsc-subset.csv';
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) if (!process.env[k]) process.env[k] = 'test-dummy';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');
const { codeListKind, loadIndex, classify } = require('../src/classify');
const { enrichCatalog, approveSku } = require('../src/enrich-catalog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-nolist-'));
let server; let base;
test.before(async () => {
  const app = createApp({ sessions: new SessionManager({ dir: tmp(), idleMs: 7_200_000 }), usage: new Usage(path.join(tmp(), 'usage.json')) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

let cookie = '';
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, body: json, text };
}
const noTrace = (r) => assert.doesNotMatch(r.text, /\bat .*\.js:\d+|ENOENT|node_modules/);

test('/health reports codeList none', async () => {
  const r = await call('GET', '/health');
  assert.strictEqual(r.body.codeList, 'none');
  assert.strictEqual(codeListKind(), 'none');
});

test('classifier modules fail with a clear NO_CODE_LIST error, not a crash', async () => {
  assert.throws(() => loadIndex(), (e) => e.code === 'NO_CODE_LIST');
  await assert.rejects(classify('nitrile gloves'), (e) => e.code === 'NO_CODE_LIST' || /code list/i.test(e.message));
  const out = path.join(tmp(), 'c.json');
  await assert.rejects(enrichCatalog({ output: out, log: () => {} }), (e) => e.code === 'NO_CODE_LIST');
  assert.ok(!fs.existsSync(out), 'nothing written');
});

test('state says live AI is off with the replay message; Re-run is refused with 429-style cap, no stack trace', async () => {
  const s = await call('GET', '/api/state');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.limits.codeList, 'none');
  assert.strictEqual(s.body.limits.liveAi.enabled, false);
  assert.strictEqual(s.body.limits.liveAi.message, 'Live AI runs locally with the licensed UNSPSC list; this demo replays a saved run.');
  const r = await call('GET', '/api/enrich/stream');
  assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
  noTrace(r);
});

test('replay path: catalog, readiness and order preview all work from the frozen catalog', async () => {
  const cat = await call('GET', '/api/catalog'); assert.strictEqual(cat.status, 200); assert.strictEqual(cat.body.items.length, 40);
  const rd = await call('GET', '/api/readiness'); assert.strictEqual(rd.status, 200);
  const pv = await call('POST', '/api/order/preview', { items: [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }] });
  assert.strictEqual(pv.status, 200, pv.text);
});

test('Edit-code search works from codes already in the catalog, with a note', async () => {
  const r = await call('GET', '/api/codes?q=glove');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.codeList, 'none');
  assert.ok(r.body.results.length > 0 && r.body.note);
  const empty = await call('GET', '/api/codes?q=');
  assert.strictEqual(empty.status, 200); assert.ok(empty.body.note);
});

test('approve: keep suggested code works; known catalog code works; unknown code is a 400 with a clear message', async () => {
  assert.strictEqual((await call('POST', '/api/review/approve', { sku: 'NLS-004' })).status, 200);
  const known = await call('POST', '/api/review/approve', { sku: 'NLS-005', code: '42132203' });
  assert.strictEqual(known.status, 200, known.text);
  const bad = await call('POST', '/api/review/approve', { sku: 'NLS-006', code: '99999999' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error || bad.body.message, /not installed|cannot be checked/i);
  noTrace(bad);
});

test('approveSku without a list: library-level check', () => {
  const f = path.join(tmp(), 'cat.json');
  fs.writeFileSync(f, JSON.stringify({ meta: {}, items: { A: { sku: 'A', unspsc: '42132203', unspsc_title: 'T', uom_braintree: 'BX', uom_paypal: 'BOX', description: 'd', status: 'ok' }, B: { sku: 'B', unspsc: null, uom_braintree: 'BX', uom_paypal: 'BOX', description: 'd', status: 'needs_review' } } }));
  assert.strictEqual(approveSku('B', { code: '42132203' }, { output: f }).item.unspsc_title, 'T');
  assert.throws(() => approveSku('B', { code: '11111111' }, { output: f }), /cannot be checked/);
});
