const test = require('node:test');
const assert = require('node:assert');
const store = require('../server/store');

const ledger = {
  'OLD-1': { status: 'charged', transactionId: 'a1', started_at: '2026-11-07T10:00:00.000Z', updated_at: '2026-11-07T10:00:02.000Z' },
  'OLD-2': { status: 'charged', transactionId: 'a2', started_at: '2026-11-07T11:00:00.000Z', updated_at: '2026-11-07T11:00:02.000Z' },
  'NEW-1': { status: 'charged', transactionId: 'b1', started_at: '2026-11-08T09:00:00.000Z', updated_at: '2026-11-08T09:00:02.000Z' },
  'NEW-FAILED': { status: 'failed', started_at: '2026-11-08T09:05:00.000Z', updated_at: '2026-11-08T09:05:01.000Z' },
  'NEW-PENDING': { status: 'pending', started_at: '2026-11-08T09:06:00.000Z', updated_at: '2026-11-08T09:06:00.000Z' },
  'NEW-2': { status: 'charged', transactionId: 'b2', started_at: '2026-11-08T09:10:00.000Z', updated_at: '2026-11-08T09:10:02.000Z' },
};

test('only charged orders started in this session are counted, oldest first', () => {
  const got = store.sessionOrders(ledger, '2026-11-08T00:00:00.000Z');
  assert.deepStrictEqual(got.map(([id]) => id), ['NEW-1', 'NEW-2']);
});

test('earlier sessions and unfinished or failed orders do not count', () => {
  assert.strictEqual(store.sessionOrders(ledger, '2026-11-09T00:00:00.000Z').length, 0);
  assert.strictEqual(store.sessionOrders({}, '2026-11-08T00:00:00.000Z').length, 0);
});

test('reset() starts a new session', async () => {
  const before = store.getSessionStart();
  await new Promise((r) => setTimeout(r, 5));
  store.reset();
  assert.ok(store.getSessionStart() > before);
});
