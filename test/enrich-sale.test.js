const test = require('node:test');
const assert = require('node:assert');
const { enrichSale, EnrichSaleError } = require('../src/enrich-sale');

const row = (sku, price, extra = {}) => ({ sku, unit_price: price, unspsc: '42132203', uom_braintree: 'BX', description: `Item ${sku} nitrile gloves box of 100`, status: 'ok', ...extra });
const catalog = { items: { A: row('A', '13.90'), B: row('B', '22.40'), C: row('C', '58.50'), R: row('R', '1.00', { status: 'needs_review' }), X: row('X', '1.00', { status: 'excluded' }) } };
const base = { orderId: 'T-1', poNumber: 'PO-1', shipping: '25.00', shipTo: { line1: 'a', city: 'b', state: 'WI', postal: '53711' }, shipsFromPostalCode: '60607', taxRate: 0.08 };

test('builds a reconciled Level 3 request: the $958.05 demo order', () => {
  const r = enrichSale({ ...base, items: [{ sku: 'A', qty: 25 }, { sku: 'B', qty: 10 }, { sku: 'C', qty: 5 }] }, { catalog });
  assert.strictEqual(r.amount, '958.05');
  assert.strictEqual(r.taxAmount, '69.05');
  assert.strictEqual(r.lineItems.length, 3);
  assert.strictEqual(r.lineItems[0].taxAmount, '27.75'); // unit tax 1.11 x 25
  assert.strictEqual(r.creditCard, undefined); // the payment method is added by the caller, server-side
});

test('refuses needs_review, excluded and unknown SKUs, naming them', () => {
  assert.throws(() => enrichSale({ ...base, items: [{ sku: 'A', qty: 1 }, { sku: 'R', qty: 1 }] }, { catalog }), (e) => e instanceof EnrichSaleError && e.code === 'REFUSED' && e.details.needsReview.join() === 'R');
  assert.throws(() => enrichSale({ ...base, items: [{ sku: 'X', qty: 1 }] }, { catalog }), (e) => e.details.excluded.join() === 'X' && /excluded/.test(e.message));
  assert.throws(() => enrichSale({ ...base, items: [{ sku: 'ZZ', qty: 1 }] }, { catalog }), (e) => e.details.missing.join() === 'ZZ');
});

test('rejects invalid orders before touching the catalog', () => {
  assert.throws(() => enrichSale({ ...base, items: [{ sku: 'A', qty: 0 }] }, { catalog }), (e) => e.code === 'INVALID_ORDER');
  assert.throws(() => enrichSale({ ...base, poNumber: 'P'.repeat(18), items: [{ sku: 'A', qty: 1 }] }, { catalog }), /17 characters/);
});
