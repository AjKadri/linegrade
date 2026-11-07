const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');
const store = require('../server/store');

let server; let base;
test.before(async () => {
  store.reset(); // always start from the frozen demo catalog, never leftover session state
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('state says synthetic + sandbox', async () => {
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.strictEqual(s.synthetic, true);
  assert.strictEqual(s.sandbox, true);
});

test('preview of the demo order matches enrichSale and carries no card data', async () => {
  const r = await post('/api/order/preview', { items: [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }] });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.totals.total, '958.05');
  assert.ok(!JSON.stringify(r.body).includes('4009040000000009'));
  assert.strictEqual(r.body.request.creditCard, undefined);
});

test('preview and pay refuse a needs_review SKU without any payment call', async () => {
  const p = await post('/api/order/preview', { items: [{ sku: 'NLS-028', qty: 1 }] });
  assert.strictEqual(p.body.ok, false);
  const pay = await post('/api/order/pay', { items: [{ sku: 'NLS-028', qty: 1 }] });
  assert.strictEqual(pay.body.outcome, 'refused');
  assert.deepStrictEqual(pay.body.refused.details.needsReview, ['NLS-028']);
});

test('bad input is a 400, a card number in the body is ignored', async () => {
  assert.strictEqual((await post('/api/order/preview', { items: [{ sku: 'NLS-002', qty: 0 }] })).status, 400);
  assert.strictEqual((await post('/api/order/preview', { items: [{ sku: "x'; drop", qty: 1 }] })).status, 400);
  assert.strictEqual((await post('/api/review/approve', { sku: '../etc' })).status, 400);
});
