const test = require('node:test');
const assert = require('node:assert');
const { validateRequest, validateCatalogRow, level1Payload, descriptionProblem } = require('../src/validate');
const { enrichSale } = require('../src/enrich-sale');
const { orderReadiness, catalogReadiness } = require('../src/readiness');

const row = (sku, price, extra = {}) => ({ sku, unit_price: price, unspsc: '42132203', uom_braintree: 'BX', uom_paypal: 'BOX', description: `Nitrile exam gloves for ${sku}, powder-free, 100 per box`, status: 'ok', ...extra });
const catalog = { items: { A: row('A', '13.90'), B: row('B', '22.40', { uom_braintree: 'PK', uom_paypal: 'PACK' }), C: row('C', '58.50', { uom_braintree: 'CS', uom_paypal: 'CASE' }) } };
const base = { orderId: 'T-1', poNumber: 'PO-1', shipping: '25.00', shipTo: { line1: 'a', city: 'b', state: 'WI', postal: '53711' }, shipsFromPostalCode: '60607', taxRate: 0.08 };
const good = () => enrichSale({ ...base, items: [{ sku: 'A', qty: 25 }, { sku: 'B', qty: 10 }, { sku: 'C', qty: 5 }] }, { catalog });
const failing = (v) => v.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('a complete Level 3 request passes every check', () => {
  const v = validateRequest(good());
  assert.deepStrictEqual(failing(v), []);
  assert.strictEqual(v.score, 100);
  assert.strictEqual(v.total, 10);
});

test('totals must reconcile to the cent: one cent off is caught at line, tax and amount level', () => {
  let r = good(); r.amount = '958.06';
  assert.deepStrictEqual(failing(validateRequest(r)), ['totals']);
  r = good(); r.lineItems[0].totalAmount = '347.51';
  assert.match(validateRequest(r).issues[0].message, /347\.51 != unit 13\.90 x 25/);
  r = good(); r.lineItems[1].taxAmount = '17.91';
  assert.ok(validateRequest(r).issues.some((i) => /tax 17\.91/.test(i.message)));
  r = good(); r.taxAmount = '69.04';
  assert.ok(validateRequest(r).issues.some((i) => /sum of line tax/.test(i.message)));
});

test('generic or placeholder descriptions are rejected', () => {
  for (const d of ['ITEM1', 'Item 1', 'Misc', 'miscellaneous', 'Supplies', 'N/A', 'TBD', 'product-12', 'Assorted', '12345', '', 'Gloves', 'lorem ipsum dolor sit amet']) {
    assert.ok(descriptionProblem(d), `should reject "${d}"`);
  }
  for (const d of ['Nitrile exam gloves, size M, powder-free, 100 per box', 'Filtered pipette tips, 1000 uL, rack of 100']) assert.strictEqual(descriptionProblem(d), null);
  const r = good(); r.lineItems[0].description = 'ITEM1';
  assert.deepStrictEqual(failing(validateRequest(r)), ['descriptions']);
});

test('the same description on several lines, or a description equal to the product code, fails', () => {
  let r = good(); r.lineItems.forEach((l) => { l.description = 'Laboratory consumable goods box'; });
  assert.ok(validateRequest(r).issues.some((i) => /same description is used on 3 lines/.test(i.message)));
  r = good(); r.lineItems[0].description = 'A'; // equals the product code
  assert.ok(failing(validateRequest(r)).includes('descriptions'));
});

test('units are checked per processor', () => {
  let r = good(); r.lineItems[0].unitOfMeasure = 'EACH'; // a PayPal word, not a Braintree code
  assert.deepStrictEqual(failing(validateRequest(r)), ['uom_braintree', 'uom_paypal']);
  r = good(); r.lineItems[2].unitOfMeasure = 'RK'; // placeholder value from the old fixture
  assert.deepStrictEqual(failing(validateRequest(r)), ['uom_braintree', 'uom_paypal']);
  const okRow = validateCatalogRow(row('A', '1.00'));
  assert.strictEqual(okRow.valid, true);
  assert.deepStrictEqual(failing(validateCatalogRow(row('A', '1.00', { uom_paypal: 'EA' }))), ['uom_paypal']); // EA makes PayPal's sandbox return 500
  assert.deepStrictEqual(failing(validateCatalogRow(row('A', '1.00', { uom_paypal: 'BOX', uom_braintree: 'EA' }))), ['uom_paypal']); // units disagree
});

test('field lengths follow the Braintree limits', () => {
  let r = good(); r.lineItems[0].productCode = 'P'.repeat(13);
  assert.ok(failing(validateRequest(r)).includes('field_lengths'));
  r = good(); r.lineItems[0].name = 'N'.repeat(36);
  assert.ok(validateRequest(r).issues.some((i) => /name is longer than 35/.test(i.message)));
  r = good(); r.lineItems[0].description = 'D'.repeat(128);
  assert.ok(failing(validateRequest(r)).includes('field_lengths'));
  r = good(); r.purchaseOrderNumber = 'P'.repeat(18);
  assert.ok(failing(validateRequest(r)).includes('po_number'));
});

test('a Level 1 payload (amount + order id) scores 0: nothing but the amount is sent', () => {
  const v = validateRequest(level1Payload(good()));
  assert.strictEqual(v.score, 0);
  assert.strictEqual(v.passed, 0);
  assert.deepStrictEqual(failing(v), ['po_number', 'tax', 'shipping', 'line_items', 'commodity_codes', 'uom_braintree', 'uom_paypal', 'descriptions']);
  assert.deepStrictEqual(v.checks.filter((c) => c.status === 'n/a').map((c) => c.id), ['totals', 'field_lengths']);
});

test('enrichSale refuses an order whose built data fails validation', () => {
  const bad = { items: { ...catalog.items, A: row('A', '13.90', { description: 'ITEM1' }) } };
  assert.throws(() => enrichSale({ ...base, items: [{ sku: 'A', qty: 1 }] }, { catalog: bad }), (e) => e.code === 'VALIDATION' && /placeholder/.test(e.message));
});

test('readiness: before (Level 1) versus after (Level 2/3), built from the same validator', () => {
  const { before, after } = orderReadiness(good());
  assert.strictEqual(before.score, 0);
  assert.strictEqual(after.score, 100);
  const c = catalogReadiness([{ ...catalog.items.A, raw_name: 'glv' }, { ...catalog.items.B, raw_name: 'tube', status: 'needs_review' }, { sku: 'X', raw_name: 'fee', unit_price: '1.00', status: 'excluded' }]);
  assert.strictEqual(c.rows, 2); // excluded rows are not goods
  assert.strictEqual(c.before.score, 0);
  assert.strictEqual(c.after.score, 50);
});
