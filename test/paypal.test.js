// PayPal rail: payload, UoM mapping, idempotency and failure paths, against a local fake of the Orders v2 API.
// No real PayPal call is made. Own file = own process, so the env below is read at load.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ALLOW_CHAOS = '1';
process.env.PP_CLIENT_ID = 'test-id';
process.env.PP_CLIENT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const pp = require('../src/paypal');
const ledger = require('../src/ledger');
const { enrichSale, loadCatalog } = require('../src/enrich-sale');

const catalog = loadCatalog();
const demo = (orderId) => enrichSale({ orderId, poNumber: 'PO-77812', items: [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }], shipping: '25.00', taxRate: 0.08, shipsFromPostalCode: '60607', shipTo: { line1: '200 Science Park Rd', city: 'Madison', state: 'WI', postal: '53711' } }, { catalog });
const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-pp-')), 'ledger.json');

// ---------- fake PayPal ----------
const fake = { calls: [], mode: {}, orders: new Map(), byRequestId: new Map(), seq: 0 };
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const rid = req.headers['paypal-request-id'];
    fake.calls.push({ method: req.method, url: req.url, rid });
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json', 'paypal-debug-id': 'dbg-test' }); res.end(JSON.stringify(json)); };
    if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'tok', expires_in: 3600 });
    if (rid && fake.byRequestId.has(rid)) return send(...fake.byRequestId.get(rid)); // idempotent replay, like PayPal
    const remember = (status, json) => { if (rid) fake.byRequestId.set(rid, [status, json]); send(status, json); };
    if (req.method === 'POST' && req.url === '/v2/checkout/orders') {
      if (fake.mode.create === '500') return send(500, { name: 'INTERNAL_SERVER_ERROR' });
      if (fake.mode.create === 'decline') return remember(422, { name: 'UNPROCESSABLE_ENTITY', message: 'declined', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was declined.' }] });
      const body = JSON.parse(raw);
      const id = `FAKE-ORDER-${++fake.seq}`;
      fake.orders.set(id, { id, status: 'APPROVED', body });
      return remember(201, { id, status: 'APPROVED' });
    }
    const cap = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap) {
      if (fake.mode.capture === '500') return send(500, { name: 'INTERNAL_SERVER_ERROR' });
      const o = fake.orders.get(cap[1]); o.status = 'COMPLETED'; o.capture = { id: `FAKE-CAP-${o.id}`, status: 'COMPLETED' };
      return remember(201, { id: o.id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [o.capture] } }] });
    }
    const get = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (get && req.method === 'GET') {
      const o = fake.orders.get(get[1]); const spu = o.body.purchase_units[0];
      const unit = { ...spu, payments: { captures: [o.capture] } };
      if (fake.mode.echo === 'none') delete unit.supplementary_data;
      return send(200, { id: o.id, status: o.status, purchase_units: [unit], payment_source: { card: { brand: 'VISA', last_digits: '1881', type: 'UNKNOWN' } } });
    }
    return send(404, { name: 'NOT_FOUND' });
  });
});
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PAYPAL_API_BASE = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { fake.calls = []; fake.mode = {}; delete process.env.CHAOS_PAYPAL; });
const posts = () => fake.calls.filter((c) => c.method === 'POST' && c.url !== '/v1/oauth2/token');

// ---------- UoM mapping ----------
test('UoM mapping: EA, BX, Each, box and the other short codes become allow-listed uppercase words', () => {
  assert.strictEqual(pp.mapUom('EA').value, 'EACH');
  assert.strictEqual(pp.mapUom('BX').value, 'BOX');
  assert.strictEqual(pp.mapUom('Each').value, 'EACH');
  assert.strictEqual(pp.mapUom('box').value, 'BOX');
  assert.strictEqual(pp.mapUom('PK').value, 'PACK');
  assert.strictEqual(pp.mapUom('CS').value, 'CASE');
  assert.strictEqual(pp.mapUom('LB').value, 'POUND');
  assert.strictEqual(pp.mapUom('KG').value, 'KGM');
  assert.strictEqual(pp.mapUom('kgm').value, 'KGM');
  for (const ok of pp.PAYPAL_UOM_ALLOWED) assert.strictEqual(pp.mapUom(ok).value, ok);
});

test('UoM mapping: anything else is omitted with a reason, and a known-500 value is never returned', () => {
  for (const bad of ['', null, undefined, 'XYZ', 'pallet', 'EA/BX']) {
    const r = pp.mapUom(bad);
    assert.strictEqual(r.value, null, String(bad));
    assert.ok(r.reason);
  }
  for (const v of ['EA', 'BX', 'Each', 'box', 'ea', 'bx']) assert.ok(pp.PAYPAL_UOM_ALLOWED.includes(pp.mapUom(v).value));
  assert.ok(!pp.PAYPAL_UOM_ALLOWED.some((u) => ['EA', 'BX', 'Each', 'box'].includes(u)));
});

// ---------- payload ----------
test('payload: Level 2 and Level 3 are built from the same enriched lines as the Braintree request', () => {
  const request = demo('PAYLOAD-1');
  const { body, uomNotes } = pp.buildPayPalOrder(request, catalog);
  const pu = body.purchase_units[0];
  assert.strictEqual(pu.amount.value, request.amount);
  assert.strictEqual(pu.invoice_id, 'PAYLOAD-1');
  assert.strictEqual(pu.reference_id, request.purchaseOrderNumber);
  assert.strictEqual(pu.amount.breakdown.tax_total.value, request.taxAmount);
  assert.strictEqual(pu.amount.breakdown.shipping.value, request.shippingAmount);
  const l3 = pu.supplementary_data.card.level_3;
  assert.strictEqual(l3.ships_from_postal_code, request.shipsFromPostalCode);
  assert.strictEqual(l3.line_items.length, request.lineItems.length);
  request.lineItems.forEach((li, i) => {
    const x = l3.line_items[i];
    assert.strictEqual(x.commodity_code, li.commodityCode);
    assert.strictEqual(x.total_amount.value, li.totalAmount);
    assert.strictEqual(x.unit_amount.value, li.unitAmount);
    assert.strictEqual(x.tax.value, li.taxAmount === '0.00' ? '0.00' : li.unitTaxAmount);
    assert.strictEqual(x.quantity, li.quantity);
    assert.strictEqual(x.description, li.description);
    assert.ok(pp.PAYPAL_UOM_ALLOWED.includes(x.unit_of_measure));
  });
  assert.strictEqual(pu.supplementary_data.card.level_2.tax_total.value, request.taxAmount);
  assert.ok(!uomNotes.some((n) => n.note && /omitted/.test(n.note)));
  assert.ok(!/"unit_of_measure":"(EA|BX|Each|box)"/.test(JSON.stringify(body)));
});

test('payload: a unit that is not on the list is omitted for that line and the reason is recorded', () => {
  const request = demo('PAYLOAD-2');
  const bad = JSON.parse(JSON.stringify(catalog));
  bad.items['NLS-007'].uom_paypal = 'pallet';
  bad.items['NLS-005'].uom_paypal = 'EA'; // short code: mapped, never sent raw
  const { body, uomNotes } = pp.buildPayPalOrder(request, bad);
  const lines = body.purchase_units[0].supplementary_data.card.level_3.line_items;
  assert.ok(!('unit_of_measure' in lines[1]));
  assert.strictEqual(lines[2].unit_of_measure, 'EACH');
  assert.match(uomNotes.find((n) => n.sku === 'NLS-007').note, /unit_of_measure omitted/);
  assert.match(uomNotes.find((n) => n.sku === 'NLS-005').note, /mapped EA -> EACH/);
  const v = pp.validatePayPalRail(request, bad);
  assert.strictEqual(v.status, 'fail');
  assert.match(v.detail, /NLS-007/);
  assert.strictEqual(pp.validatePayPalRail(request, catalog).status, 'pass');
});

test('payload: unsupported ship-to country is refused before any call', async () => {
  const request = { ...demo('PAYLOAD-3'), shipping: { ...demo('x').shipping, countryCodeAlpha3: 'FRA' } };
  assert.throws(() => pp.buildPayPalOrder(request, catalog), /not supported/);
  const r = await pp.chargePayPal(request, catalog, { ledgerFile: tmpLedger() });
  assert.strictEqual(r.outcome, 'declined');
  assert.strictEqual(fake.calls.length, 0);
});

// ---------- charge, idempotency ----------
test('happy path: create, capture, read-back; every check passes and Level 2/3 are reported as echoed', async () => {
  const file = tmpLedger();
  const r = await pp.chargePayPal(demo('PAY-OK-1'), catalog, { ledgerFile: file });
  assert.strictEqual(r.outcome, 'charged');
  assert.strictEqual(r.rail, 'paypal');
  assert.ok(r.passed && r.checks.length >= 15, `${r.checks.length} checks`);
  assert.ok(r.level3Echoed && r.level2Echoed);
  assert.strictEqual(r.transaction.commercial, null, 'no commercial claim on the PayPal rail');
  const e = ledger.get('PAY-OK-1', file);
  assert.strictEqual(e.status, 'charged'); assert.strictEqual(e.rail, 'paypal'); assert.strictEqual(e.transactionId, r.transactionId);
  assert.deepStrictEqual(posts().map((c) => c.url.split('/').pop()), ['orders', 'capture']);
});

test('idempotency: keys are derived from orderId and attempt; create and capture carry them; a second pay makes no call', async () => {
  assert.strictEqual(pp.requestId('A', 1, 'create'), pp.requestId('A', 1, 'create'));
  assert.notStrictEqual(pp.requestId('A', 1, 'create'), pp.requestId('A', 2, 'create'));
  assert.notStrictEqual(pp.requestId('A', 1, 'create'), pp.requestId('A', 1, 'capture'));
  assert.notStrictEqual(pp.requestId('A', 1, 'create'), pp.requestId('B', 1, 'create'));
  const file = tmpLedger();
  await pp.chargePayPal(demo('IDEM-1'), catalog, { ledgerFile: file });
  const [create, capture] = posts();
  assert.strictEqual(create.rid, pp.requestId('IDEM-1', 1, 'create'));
  assert.strictEqual(capture.rid, pp.requestId('IDEM-1', 1, 'capture'));
  fake.calls = [];
  const again = await pp.chargePayPal(demo('IDEM-1'), catalog, { ledgerFile: file });
  assert.strictEqual(again.outcome, 'already_charged');
  assert.strictEqual(posts().length, 0, 'duplicate orderId makes no PayPal call');
});

test('lost reply: capture fails with a 5xx, ledger unknown; the retry reuses the same keys and never creates a second order', async () => {
  const file = tmpLedger();
  fake.mode.capture = '500';
  const first = await pp.chargePayPal(demo('LOST-1'), catalog, { ledgerFile: file });
  assert.strictEqual(first.outcome, 'paypal_unavailable');
  assert.strictEqual(first.retrySafe, true);
  assert.strictEqual(ledger.get('LOST-1', file).status, 'unknown');
  const firstIds = posts().map((c) => c.rid);
  fake.calls = []; fake.mode.capture = undefined;
  const retry = await pp.chargePayPal(demo('LOST-1'), catalog, { ledgerFile: file });
  assert.strictEqual(retry.outcome, 'charged');
  assert.deepStrictEqual(posts().map((c) => c.rid), firstIds, 'same idempotency keys on the retry');
  assert.strictEqual(fake.orders.size >= 1 && [...fake.orders.keys()].filter((k) => k === retry.paypalOrderId).length, 1);
});

// ---------- failure paths ----------
test('PayPal unreachable (chaos flag): not charged, ledger failed, no HTTP made, a retry works once it is back', async () => {
  const file = tmpLedger();
  process.env.CHAOS_PAYPAL = 'down';
  const r = await pp.chargePayPal(demo('DOWN-1'), catalog, { ledgerFile: file });
  assert.strictEqual(r.outcome, 'paypal_unavailable');
  assert.strictEqual(r.retrySafe, true); assert.strictEqual(r.charged, false);
  assert.strictEqual(ledger.get('DOWN-1', file).status, 'failed');
  assert.strictEqual(fake.calls.length, 0);
  delete process.env.CHAOS_PAYPAL;
  const retry = await pp.chargePayPal(demo('DOWN-1'), catalog, { ledgerFile: file });
  assert.strictEqual(retry.outcome, 'charged');
});

test('PayPal 5xx on create: not completed, safe to retry with the same key', async () => {
  const file = tmpLedger();
  fake.mode.create = '500';
  const r = await pp.chargePayPal(demo('FIVE-1'), catalog, { ledgerFile: file });
  assert.strictEqual(r.outcome, 'paypal_unavailable');
  assert.strictEqual(r.retrySafe, true);
  fake.mode.create = undefined;
  assert.strictEqual((await pp.chargePayPal(demo('FIVE-1'), catalog, { ledgerFile: file })).outcome, 'charged');
});

test('decline: reported with PayPal\'s message, ledger failed; the retry is a fresh attempt with a new key', async () => {
  const file = tmpLedger();
  fake.mode.create = 'decline';
  const r = await pp.chargePayPal(demo('DECL-1'), catalog, { ledgerFile: file });
  assert.strictEqual(r.outcome, 'declined');
  assert.match(r.details.join(' '), /INSTRUMENT_DECLINED/);
  const e = ledger.get('DECL-1', file);
  assert.strictEqual(e.status, 'failed'); assert.strictEqual(e.definitive, true);
  fake.calls = []; fake.mode.create = undefined;
  const retry = await pp.chargePayPal(demo('DECL-1'), catalog, { ledgerFile: file });
  assert.strictEqual(retry.outcome, 'charged');
  assert.strictEqual(posts()[0].rid, pp.requestId('DECL-1', 2, 'create'), 'attempt 2 after a definite decline');
  assert.strictEqual(ledger.get('DECL-1', file).attempt, 2);
});

test('an unresolved attempt on the other rail blocks this rail; a charged one reports already_charged with its rail', async () => {
  const file = tmpLedger();
  ledger.set('X-1', { status: 'unknown', rail: 'braintree' }, file);
  const blocked = await pp.chargePayPal(demo('X-1'), catalog, { ledgerFile: file });
  assert.strictEqual(blocked.outcome, 'blocked_other_rail');
  assert.strictEqual(fake.calls.length, 0);
  ledger.set('X-2', { status: 'charged', rail: 'braintree', transactionId: 'bt123', amount: '958.05' }, file);
  const dup = await pp.chargePayPal(demo('X-2'), catalog, { ledgerFile: file });
  assert.strictEqual(dup.outcome, 'already_charged'); assert.strictEqual(dup.rail, 'braintree');
  assert.strictEqual(fake.calls.length, 0);
});

// ---------- read-back honesty ----------
test('read-back: if PayPal does not return Level 3, it is reported as not echoed and nothing is claimed for it', async () => {
  fake.mode.echo = 'none';
  const r = await pp.chargePayPal(demo('ECHO-1'), catalog, { ledgerFile: tmpLedger() });
  assert.strictEqual(r.outcome, 'charged');
  assert.strictEqual(r.level3Echoed, false); assert.strictEqual(r.level2Echoed, false);
  assert.ok(!r.checks.some((c) => /Level 3/.test(c.check)), 'no Level 3 check is invented');
  assert.ok(!r.fieldsReturned.some((f) => f.includes('level_3')));
});
