const test = require('node:test');
const assert = require('node:assert');
const { isLookAlike } = require('../src/classify');

const ru = (unspsc, confidence) => ({ unspsc, confidence });

test('flags a runner-up in the same 6-digit class when the gap is under 0.2', () => {
  assert.strictEqual(isLookAlike('42132203', 0.8, ru('42132205', 0.7)), true); // gap 0.1
  assert.strictEqual(isLookAlike('42132203', 0.85, ru('42132209', 0.66)), true); // gap 0.19
});

test('does not flag when the gap is 0.2 or more (no float drift at the boundary)', () => {
  assert.strictEqual(isLookAlike('42132203', 0.9, ru('42132205', 0.7)), false); // exactly 0.2
  assert.strictEqual(isLookAlike('42132203', 0.85, ru('42132205', 0.65)), false); // exactly 0.2
  assert.strictEqual(isLookAlike('42132203', 0.95, ru('42132205', 0.2)), false);
});

test('does not flag a runner-up in a different class, however close', () => {
  assert.strictEqual(isLookAlike('42132203', 0.7, ru('46181504', 0.69)), false);
});

test('does not flag when there is no code or no runner-up', () => {
  assert.strictEqual(isLookAlike(null, 0.7, ru('42132205', 0.7)), false);
  assert.strictEqual(isLookAlike('42132203', 0.7, null), false);
});
