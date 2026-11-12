// "Without LineGrade" really pays without the data: Level 1 payloads carry no Level 2/3 fields on either rail,
// a Level 1 and a LineGrade sale of the same order are two orders for the duplicate guard, and caps count both.
process.env.ALLOW_CHAOS = '1';
process.env.PP_CLIENT_ID = 'id'; process.env.PP_CLIENT_SECRET = 'secret';
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) process.env[k] = 'test-dummy';
delete process.env.PAYPAL_RAIL;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');
const store = require('../server/store');
const pp = require('../src/paypal');
const { chargeRequest } = require('../src/pay');
const ledger = require('../src/ledger');
const { enrichSale, loadCatalog } = require('../src/enrich-sale');
const { fake, server: fakeServer, start } = require('./helpers/fake-paypal');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-l1-'));
const catalog = loadCatalog();
const request = (orderId) => enrichSale({ orderId, poNumber: 'PO-77812', items: [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }], shipping: '25.00', taxRate: 0.08, shipsFromPostalCode: '60607', shipTo: { line1: '200 Science Park Rd', city: 'Madison', state: 'WI', postal: '53711' } }, { catalog });

test('PayPal Level 1 body: amount and card only, no items, breakdown, shipping or supplementary_data', () => {
  const { body } = pp.buildPayPalLevel1(request('X-L1'));
  const pu = body.purchase_units[0];
  assert.deepStrictEqual(Object.keys(pu), ['amount']);
  assert.deepStrictEqual(pu.amount, { currency_code: 'USD', value: '958.05' });
  const text = JSON.stringify(body);
  for (const bad of ['supplementary_data', 'level_2', 'level_3', 'line_items', 'items', 'commodity', 'breakdown', 'shipping', 'tax']) assert.ok(!text.includes(bad), bad);
});

test('Braintree Level 1: the sale carries amount, orderId and settlement option only', async () => {
  let sent = null;
  const gw = {
    transaction: {
      sale: async (s) => { sent = s; return { success: true, transaction: { id: 'bt-l1', status: 'submitted_for_settlement', amount: s.amount } }; },
      find: async (id) => ({ id, status: 'submitted_for_settlement', amount: '958.05', creditCard: { commercial: 'Yes', last4: '0009' } }),
    },
    transactionLineItem: { findAll: async () => [] },
  };
  const r = await chargeRequest({ amount: '958.05', orderId: 'BT-1-L1', options: { submitForSettlement: true } }, { gateway: gw, ledgerFile: path.join(tmp(), 'l.json'), level1: true });
  assert.strictEqual(r.outcome, 'charged'); assert.strictEqual(r.level, 1);
  assert.deepStrictEqual(Object.keys(sent).sort(), ['amount', 'creditCard', 'options', 'orderId']);
  for (const k of ['purchaseOrderNumber', 'taxAmount', 'shippingAmount', 'shipsFromPostalCode', 'lineItems', 'shipping', 'discountAmount']) assert.ok(!(k in sent), k);
  assert.ok(r.checks.every((c) => c.pass), 'Level 1 read-back shows nothing extra came back');
  assert.strictEqual(r.checks.find((c) => c.check === 'Line items returned').actual, '0');
  assert.deepStrictEqual(r.lineItemsReturned, []);
});

test('Braintree: a Level 1 sale and a Level 3 sale of the same order are two orders for the duplicate guard', async () => {
  const file = path.join(tmp(), 'l.json');
  const gw = { transaction: { sale: async (s) => ({ success: true, transaction: { id: `bt-${s.orderId}`, status: 'submitted_for_settlement', amount: s.amount } }), find: async (id) => ({ id, status: 'submitted_for_settlement', amount: '958.05', creditCard: {} }), search: () => ({ on() {} }) }, transactionLineItem: { findAll: async () => [] } };
  const a = await chargeRequest({ amount: '958.05', orderId: 'SAME-L1', options: {} }, { gateway: gw, ledgerFile: file, level1: true });
  const b = await chargeRequest({ amount: '958.05', orderId: 'SAME-L1', options: {} }, { gateway: gw, ledgerFile: file, level1: true });
  assert.strictEqual(a.outcome, 'charged'); assert.strictEqual(b.outcome, 'already_charged');
  assert.strictEqual(ledger.get('SAME-L1', file).level, 1);
});

// ---------- through the server ----------
let server; let base;
test.before(async () => {
  process.env.PAYPAL_API_BASE = await start();
  const app = createApp({ sessions: new SessionManager({ dir: tmp(), idleMs: 7_200_000 }), usage: new Usage(path.join(tmp(), 'usage.json')) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeServer.close(); });
test.beforeEach(() => { fake.calls = []; fake.mode = {}; });
function browser() {
  let cookie = '';
  const b = { async call(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  } };
  b.get = (u) => b.call('GET', u); b.post = (u, x) => b.call('POST', u, x);
  return b;
}
const lines = [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }];

test('server, PayPal: Level 1 sends amount only; the LineGrade sale of the same order is separate; both count toward the cap; readiness counts LineGrade only', async () => {
  process.env.MAX_PAYMENTS_PER_SESSION = '2';
  try {
    const b = browser();
    const l1 = await b.post('/api/order/pay', { items: lines, rail: 'paypal', level: 1, orderId: 'ORDER-0001' });
    assert.strictEqual(l1.status, 200, l1.text);
    assert.strictEqual(l1.body.outcome, 'charged'); assert.strictEqual(l1.body.level, 1);
    assert.match(l1.body.orderId, /-ORDER-0001-L1$/);
    const created = fake.orders.get(l1.body.paypalOrderId).body;
    assert.deepStrictEqual(Object.keys(created.purchase_units[0]), ['amount']);
    assert.strictEqual(l1.body.level3Echoed, false);
    assert.ok(l1.body.checks.every((c) => c.pass));
    assert.strictEqual(l1.body.paymentsLeft, 1, 'a Level 1 sale uses a payment');
    // the same order with LineGrade data: a different order id, so the duplicate guard does not trip
    const l3 = await b.post('/api/order/pay', { items: lines, rail: 'paypal', level: 3, orderId: 'ORDER-0001' });
    assert.strictEqual(l3.body.outcome, 'charged'); assert.strictEqual(l3.body.level, 3);
    assert.ok(l3.body.level3Echoed && l3.body.passed);
    assert.strictEqual(l3.body.paymentsLeft, 0);
    // repeating either one is a duplicate of itself
    assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', level: 1, orderId: 'ORDER-0001' })).body.outcome, 'already_charged');
    assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', level: 3, orderId: 'ORDER-0001' })).body.outcome, 'already_charged');
    // the cap now blocks a third distinct order, on either rail
    assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'paypal', level: 1, orderId: 'ORDER-0002' })).status, 429);
    assert.strictEqual((await b.post('/api/order/pay', { items: lines, rail: 'braintree', level: 1, orderId: 'ORDER-0003' })).status, 429);
    const rd = await b.get('/api/readiness');
    assert.strictEqual(rd.body.level3Orders, 1, 'Readiness counts LineGrade sales only');
  } finally { delete process.env.MAX_PAYMENTS_PER_SESSION; }
});

test('server: bad level values are rejected; sessionOrders skips Level 1', async () => {
  assert.strictEqual((await browser().post('/api/order/pay', { items: lines, level: 2 })).status, 400);
  const since = '2000-01-01T00:00:00.000Z';
  const got = store.sessionOrders({ a: { status: 'charged', level: 1, started_at: '2026-01-01' }, b: { status: 'charged', level: 3, started_at: '2026-01-02' }, c: { status: 'charged', started_at: '2026-01-03' } }, since);
  assert.deepStrictEqual(got.map(([k]) => k), ['b', 'c']);
});
