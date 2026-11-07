const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planEnrichment, approveSku, unapproveSku } = require('../src/enrich-catalog');
const { CLASSIFIER_VERSION } = require('../src/classify');

const row = (sku, raw_name, unit_price = '1.00') => ({ sku, raw_name, unit_price });
const item = (sku, raw_name, extra = {}) => ({ sku, raw_name, unit_price: '1.00', unspsc: '42132203', unspsc_title: 'T', uom_braintree: 'BX', uom_paypal: 'BOX', description: 'd', status: 'ok', approved: false, flags: [], classifier_version: CLASSIFIER_VERSION, ...extra });

test('only new or changed SKUs are classified; unchanged rows are reused', () => {
  const rows = [row('A', 'gloves'), row('B', 'tubes v2'), row('C', 'new thing')];
  const existing = { A: item('A', 'gloves'), B: item('B', 'tubes') };
  const { actions } = planEnrichment(rows, existing);
  assert.deepStrictEqual(actions.A, { action: 'reuse', reason: 'unchanged' });
  assert.deepStrictEqual(actions.B, { action: 'classify', reason: 'changed' });
  assert.deepStrictEqual(actions.C, { action: 'classify', reason: 'new' });
});

test('approved rows are locked, even with force and even if the name changed', () => {
  const existing = { A: item('A', 'gloves', { approved: true }) };
  assert.strictEqual(planEnrichment([row('A', 'gloves')], existing, { force: true }).actions.A.action, 'locked');
  const changed = planEnrichment([row('A', 'gloves NEW NAME')], existing);
  assert.strictEqual(changed.actions.A.action, 'locked');
  assert.match(changed.warnings[0], /name changed/);
});

test('force re-classifies every unapproved row', () => {
  const existing = { A: item('A', 'x'), B: item('B', 'y', { approved: true }) };
  const { actions } = planEnrichment([row('A', 'x'), row('B', 'y')], existing, { force: true });
  assert.strictEqual(actions.A.action, 'classify');
  assert.strictEqual(actions.B.action, 'locked');
});

test('a classifier version change or a failed earlier call triggers re-classification of unapproved rows only', () => {
  const existing = {
    A: item('A', 'x', { classifier_version: CLASSIFIER_VERSION - 1 }),
    B: item('B', 'y', { flags: ['call_failed'] }),
    C: item('C', 'z', { classifier_version: CLASSIFIER_VERSION - 1, approved: true }),
  };
  const { actions } = planEnrichment([row('A', 'x'), row('B', 'y'), row('C', 'z')], existing);
  assert.strictEqual(actions.A.reason, 'classifier_version');
  assert.strictEqual(actions.B.reason, 'retry_failed');
  assert.strictEqual(actions.C.action, 'locked');
});

test('rows removed from the CSV are dropped unless approved', () => {
  const existing = { A: item('A', 'x'), B: item('B', 'y', { approved: true }) };
  const plan = planEnrichment([], existing);
  assert.deepStrictEqual(plan.dropped, ['A']);
  assert.deepStrictEqual(plan.removed, ['B']);
});

test('approve locks a needs_review row that already has a code; unapprove unlocks it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')), 'enriched.json');
  fs.writeFileSync(file, JSON.stringify({ meta: {}, items: { A: item('A', 'x', { status: 'needs_review', review_reasons: ['look_alike'] }) } }));
  approveSku('A', {}, { output: file });
  let saved = JSON.parse(fs.readFileSync(file, 'utf8')).items.A;
  assert.strictEqual(saved.approved, true);
  assert.strictEqual(saved.status, 'ok');
  unapproveSku('A', { output: file });
  saved = JSON.parse(fs.readFileSync(file, 'utf8')).items.A;
  assert.strictEqual(saved.approved, false);
  assert.strictEqual(saved.status, 'needs_review');
});

test('approve refuses a row with no code unless one is supplied', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')), 'enriched.json');
  fs.writeFileSync(file, JSON.stringify({ meta: {}, items: { A: item('A', 'x', { unspsc: null, status: 'needs_review' }) } }));
  assert.throws(() => approveSku('A', {}, { output: file }), /no code yet/);
});
