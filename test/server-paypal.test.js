// Server routes with the PayPal rail: availability, preview, pay, duplicate guard across rails, caps, chaos.
// PayPal is a local fake; Braintree keys are dummies, so any accidental Braintree call would fail loudly.
process.env.ALLOW_CHAOS = '1';
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) process.env[k] = 'test-dummy';
delete process.env.PP_CLIENT_ID; delete process.env.PP_CLIENT_SECRET; delete process.env.PAYPAL_RAIL;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');
const { fake, server: fakeServer, start } = require('./helpers/fake-paypal');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-srvpp-'));
let server; let base;
test.before(async () => {
  process.env.PAYPAL_API_BASE = await start();
  const app = createApp({ sessions: new SessionManager({ dir: tmp(), idleMs: 7_200_000 }), usage: new Usage(path.join(tmp(), 'usage.json')) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeServer.close(); });
test.beforeEach(() => { fake.calls = []; fake.mode = {}; delete process.env.CHAOS_PAYPAL; });
const withCreds = () => { process.env.PP_CLIENT_ID = 'id'; process.env.PP_CLIENT_SECRET = 'secret'; };
const noCreds = () => { delete process.env.PP_CLIENT_ID; delete process.env.PP_CLIENT_SECRET; delete process.env.PAYPAL_RAIL; };

function browser() {
  let cookie = '';
  const b = {
    async call(method, url, body) {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    },
    get: (u) => b.call('GET', u), post: (u, body) => b.call('POST', u, body),
  };
  return b;
}
const lines = [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }];
const ppCalls = () => fake.calls.filter((c) => c.method === 'POST' && c.url !== '/v1/oauth2/token');

test('without PP_* credentials the rail is hidden: state and health say so, and a PayPal request is refused cleanly', async () => {
  noCreds();
  const b = browser();
  assert.strictEqual((await b.get('/health')).body.paypalRail, 'off');
  assert.strictEqual((await b.get('/api/state')).body.limits.rails.paypal, false);
  const r = await b.post('/api/order/pay', { items: lines, rail: 'paypal' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'RAIL_UNAVAILABLE');
  assert.doesNotMatch(r.text, /\bat .*\.js:\d+|node_modules/);
  const pv = await b.post('/api/order/preview', { items: lines });
  assert.strictEqual(pv.status, 200); assert.strictEqual(pv.body.rail, 'braintree');
  assert.strictEqual(pv.body.validation.after.total, 10, 'Braintree validation is exactly as before');
  assert.strictEqual(fake.calls.length, 0);
});

test('PAYPAL_RAIL=off hides the rail even with credentials; unknown rail values are rejected', async () => {
  withCreds(); process.env.PAYPAL_RAIL = 'off';
  const b = browser();
  assert.strictEqual((await b.get('/health')).body.paypalRail, 'off');
  assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal' })).body.code, 'RAIL_UNAVAILABLE');
  delete process.env.PAYPAL_RAIL;
  assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'venmo' })).status, 400);
  assert.strictEqual((await b.get('/health')).body.paypalRail, 'on');
  noCreds();
});

test('preview on the PayPal rail adds the rail-only check and the unit notes; the Level 1 side is unchanged', async () => {
  withCreds();
  const b = browser();
  const pv = await b.post('/api/order/preview', { items: lines, rail: 'paypal' });
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.body.rail, 'paypal');
  assert.strictEqual(pv.body.validation.after.total, 11);
  assert.ok(pv.body.validation.after.checks.some((c) => c.id === 'paypal_rail' && c.status === 'pass'));
  assert.strictEqual(pv.body.validation.before.total, 8);
  assert.deepStrictEqual(pv.body.paypal.uomNotes.map((n) => n.sent), ['BOX', 'PACK', 'CASE']);
  assert.doesNotMatch(pv.text, /4012888888881881|security_code|PP_CLIENT/);
  noCreds();
});

test('pay on the PayPal rail: charged, read-back returned, ledger rail paypal, no card data in the reply', async () => {
  withCreds();
  const b = browser();
  const r = await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0001' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.outcome, 'charged');
  assert.strictEqual(r.body.rail, 'paypal');
  assert.ok(r.body.passed && r.body.level3Echoed);
  assert.strictEqual(r.body.transaction.commercial, null);
  assert.strictEqual(r.body.paymentsLeft, 4);
  assert.doesNotMatch(r.text, /4012888888881881|security_code|secret/);
  // The same order id again, on either rail: already charged, no new call anywhere.
  fake.calls = [];
  const again = await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0001' });
  assert.strictEqual(again.body.outcome, 'already_charged'); assert.strictEqual(again.body.rail, 'paypal');
  const cross = await b.post('/api/order/pay', { items: lines, rail: 'braintree', orderId: 'PP-ORDER-0001' });
  assert.strictEqual(cross.body.outcome, 'already_charged'); assert.strictEqual(cross.body.rail, 'paypal');
  assert.strictEqual(ppCalls().length, 0);
  assert.strictEqual(again.body.paymentsLeft, 4, 'a duplicate does not use a payment');
  noCreds();
});

test('PayPal down (chaos flag): clear outcome, not charged, safe to retry, payment not counted; retry then works', async () => {
  withCreds(); process.env.CHAOS_PAYPAL = 'down';
  const b = browser();
  const r = await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0002' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.outcome, 'paypal_unavailable');
  assert.strictEqual(r.body.retrySafe, true); assert.strictEqual(r.body.charged, false);
  assert.strictEqual(r.body.paymentsLeft, 5);
  assert.doesNotMatch(r.text, /\bat .*\.js:\d+|node_modules/);
  delete process.env.CHAOS_PAYPAL;
  assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0002' })).body.outcome, 'charged');
  noCreds();
});

test('decline on PayPal: outcome declined with the reason; the same order id can be retried', async () => {
  withCreds(); fake.mode.create = 'decline';
  const b = browser();
  const r = await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0003' });
  assert.strictEqual(r.body.outcome, 'declined');
  assert.match(r.body.details.join(' '), /INSTRUMENT_DECLINED/);
  fake.mode.create = undefined;
  assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0003' })).body.outcome, 'charged');
  noCreds();
});

test('payment caps count both rails: the per-session cap stops a PayPal payment before any call', async () => {
  withCreds(); process.env.MAX_PAYMENTS_PER_SESSION = '1';
  try {
    const b = browser();
    assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0004' })).body.outcome, 'charged');
    fake.calls = [];
    const r = await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0005' });
    assert.strictEqual(r.status, 429); assert.strictEqual(r.body.code, 'CAP_REACHED');
    const r2 = await b.post('/api/order/pay', { items: lines, rail: 'braintree', orderId: 'PP-ORDER-0006' });
    assert.strictEqual(r2.status, 429, 'the same budget covers Braintree');
    assert.strictEqual(fake.calls.length, 0);
  } finally { delete process.env.MAX_PAYMENTS_PER_SESSION; noCreds(); }
});

test('an unresolved PayPal attempt blocks the same order id on Braintree (no double charge across rails)', async () => {
  withCreds(); fake.mode.capture = '500';
  const b = browser();
  const first = await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0007' });
  assert.strictEqual(first.body.outcome, 'paypal_unavailable'); assert.strictEqual(first.body.charged, 'unknown');
  const cross = await b.post('/api/order/pay', { items: lines, rail: 'braintree', orderId: 'PP-ORDER-0007' });
  assert.strictEqual(cross.body.outcome, 'blocked_other_rail');
  fake.mode.capture = undefined;
  assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', orderId: 'PP-ORDER-0007' })).body.outcome, 'charged');
  noCreds();
});

test('refused order (unknown SKU) on the PayPal rail names the rail and makes no call', async () => {
  withCreds();
  const r = await browser().post('/api/order/pay', { items: [{ sku: 'NLS-999', qty: 1 }], rail: 'paypal' });
  assert.strictEqual(r.body.outcome, 'refused');
  assert.match(r.body.messages[0], /No PayPal call/);
  assert.strictEqual(fake.calls.length, 0);
  noCreds();
});
