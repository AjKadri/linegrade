const test = require('node:test');
const assert = require('node:assert');
const { loadRates, validateRates, estimateFeeDifference } = require('../src/fees');

test('data/rates.json: every rate cites a source with an https URL and dates', () => {
  const r = loadRates();
  assert.ok(r.sources.some((s) => s.kind === 'primary' && /usa\.visa\.com/.test(s.url) && s.effective));
  for (const x of r.rates) assert.ok(r.sources.find((s) => s.id === x.source));
});

test('validateRates rejects a rate with no source, and a source with no URL or date', () => {
  const r = JSON.parse(JSON.stringify(loadRates()));
  r.rates[0].source = 'nope';
  assert.throws(() => validateRates(r), /unknown source/);
  const r2 = JSON.parse(JSON.stringify(loadRates())); r2.sources[0].url = 'http://x';
  assert.throws(() => validateRates(r2), /https URL/);
  const r3 = JSON.parse(JSON.stringify(loadRates())); delete r3.sources[0].accessed;
  assert.throws(() => validateRates(r3), /access date/);
});

test('fee estimate for the $958.05 demo order, computed in cents and labelled ESTIMATE', () => {
  const e = estimateFeeDifference('958.05');
  assert.strictEqual(e.label, 'ESTIMATE');
  const by = Object.fromEntries(e.scenarios.map((s) => [s.id, s]));
  // Visa Purchasing/Corporate: 2.70% + $0.10 vs Commercial Product 3 1.75% + $0.10
  assert.strictEqual(by.purchasing_corporate_cnp.standard.fee, '25.97');
  assert.strictEqual(by.purchasing_corporate_cnp.product3.fee, '16.87');
  assert.strictEqual(by.purchasing_corporate_cnp.difference, '9.10');
  assert.strictEqual(by.purchasing_corporate_nonqualified.difference, '11.49');
  assert.strictEqual(by.business_card.difference, '2.40');
  assert.deepStrictEqual(e.range, { low: '2.40', high: '11.49' });
  assert.strictEqual(e.isRange, true);
  assert.ok(e.conflicts.length > 0 && e.excluded.length > 0);
});
