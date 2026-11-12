const test = require('node:test');
const assert = require('node:assert');
const store = require('../server/store');

test('counts: excluded rows are locked but counted under excluded, not approved', () => {
  const c = store.counts([
    { status: 'ok', approved: true },
    { status: 'excluded', approved: true, excluded: true },
    { status: 'excluded', approved: true, excluded: true },
    { status: 'needs_review', approved: false },
    { status: 'ok', approved: false },
  ]);
  assert.strictEqual(c.approved, 1);
  assert.strictEqual(c.excluded, 2);
  assert.strictEqual(c.needs_review, 1);
});
