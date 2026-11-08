const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../server/store');
const { SessionManager, parseCookies } = require('../server/sessions');
const { rateLimiter } = require('../server/ratelimit');
const { Usage } = require('../server/usage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-sess-'));
const clock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t }; return c; };

test('every session gets its own id and its own directory', () => {
  const m = new SessionManager({ dir: tmp() });
  const a = m.create(); const b = m.create();
  assert.notStrictEqual(a.id, b.id);
  assert.match(a.id, /^[A-Za-z0-9_-]{24}$/);
  assert.notStrictEqual(a.dir, b.dir);
  assert.strictEqual(m.get(a.id), a);
});

test('one session\'s catalog changes never reach another session or the frozen file', () => {
  const m = new SessionManager({ dir: tmp() });
  const a = m.create(); const b = m.create();
  const sa = store.forSession(a); const sb = store.forSession(b);
  const { excludeSku } = require('../src/enrich-catalog');
  const frozenBefore = fs.readFileSync(store.FROZEN, 'utf8');
  excludeSku('NLS-038', { output: sa.ensureSession() });
  assert.strictEqual(sa.read().items.find((i) => i.sku === 'NLS-038').status, 'excluded');
  assert.strictEqual(sb.read().items.find((i) => i.sku === 'NLS-038').status, 'needs_review'); // B still reads the frozen catalog
  assert.strictEqual(sb.source(), 'frozen');
  assert.strictEqual(fs.readFileSync(store.FROZEN, 'utf8'), frozenBefore);
  sa.reset();
  assert.strictEqual(sa.read().items.find((i) => i.sku === 'NLS-038').status, 'needs_review');
});

test('idle sessions expire after the idle time and their files are deleted; activity slides the window', () => {
  const c = clock();
  const m = new SessionManager({ dir: tmp(), idleMs: 7_200_000, now: c.now });
  const s = m.create();
  store.forSession(s).ensureSession();
  assert.ok(fs.existsSync(s.dir));
  c.t += 7_199_000; m.touch(s); // activity just before the limit
  c.t += 7_199_000;
  assert.strictEqual(m.get(s.id), s, 'still alive: the last activity moved the window');
  c.t += 7_201_000; // idle for more than 2 hours
  assert.strictEqual(m.get(s.id), null);
  assert.strictEqual(fs.existsSync(s.dir), false);
});

test('sweep removes only the idle sessions', () => {
  const c = clock();
  const m = new SessionManager({ dir: tmp(), idleMs: 1000, now: c.now });
  const idle = m.create(); c.t += 600; const fresh = m.create(); c.t += 600; // idle is 1200 old, fresh is 600
  assert.strictEqual(m.sweep(), 1);
  assert.strictEqual(m.get(idle.id), null);
  assert.strictEqual(m.get(fresh.id), fresh);
});

test('cookie ids that are not ours are rejected (no path tricks)', () => {
  const m = new SessionManager({ dir: tmp() });
  for (const bad of ['../etc/passwd', '..', 'a', 'x'.repeat(24) + '/../..', '', undefined, 'short']) assert.strictEqual(m.get(bad), null);
  assert.deepStrictEqual(parseCookies('a=1; lg_sid=abc; b=2'), { a: '1', lg_sid: 'abc', b: '2' });
});

test('over capacity, the longest-idle session is dropped', () => {
  const c = clock();
  const m = new SessionManager({ dir: tmp(), maxSessions: 2, now: c.now });
  const a = m.create(); c.t += 10; const b = m.create(); c.t += 10; m.touch(a); c.t += 10;
  const third = m.create();
  assert.strictEqual(m.count(), 2);
  assert.strictEqual(m.get(b.id), null, 'b was idle the longest');
  assert.ok(m.get(a.id) && m.get(third.id));
});

test('clearAll deletes every session directory', () => {
  const dir = tmp();
  const m = new SessionManager({ dir });
  store.forSession(m.create()).ensureSession(); store.forSession(m.create()).ensureSession();
  assert.strictEqual(fs.readdirSync(dir).length, 2);
  m.clearAll();
  assert.strictEqual(fs.existsSync(dir), false);
});

test('only charged orders started in this session window are counted, oldest first', () => {
  const ledger = {
    'OLD-1': { status: 'charged', transactionId: 'a1', started_at: '2026-11-07T10:00:00.000Z' },
    'NEW-1': { status: 'charged', transactionId: 'b1', started_at: '2026-11-08T09:00:00.000Z' },
    'NEW-FAILED': { status: 'failed', started_at: '2026-11-08T09:05:00.000Z' },
    'NEW-2': { status: 'charged', transactionId: 'b2', started_at: '2026-11-08T09:10:00.000Z' },
  };
  assert.deepStrictEqual(store.sessionOrders(ledger, '2026-11-08T00:00:00.000Z').map(([id]) => id), ['NEW-1', 'NEW-2']);
  assert.strictEqual(store.sessionOrders(ledger, '2026-11-09T00:00:00.000Z').length, 0);
});

test('reset() starts a new order window for that session only', async () => {
  const m = new SessionManager({ dir: tmp() });
  const a = m.create(); const b = m.create();
  const aStart = a.start; const bStart = b.start;
  await new Promise((r) => setTimeout(r, 5));
  store.forSession(a).reset();
  assert.ok(a.start > aStart);
  assert.strictEqual(b.start, bStart);
});

test('rate limiter: blocks over the limit, reports Retry-After, recovers after the window', () => {
  const c = clock();
  const limit = rateLimiter({ name: 'session', windowMs: 60_000, max: 3, keyFn: (r) => r.k, now: c.now });
  const res = () => { const r = { code: 200, headers: {}, set(k, v) { r.headers[k] = v; }, status(n) { r.code = n; return r; }, json(b) { r.body = b; } }; return r; };
  const hit = (k) => { const r = res(); let passed = false; limit({ k }, r, () => { passed = true; }); return { passed, r }; };
  assert.ok(hit('a').passed && hit('a').passed && hit('a').passed);
  const blocked = hit('a');
  assert.strictEqual(blocked.passed, false);
  assert.strictEqual(blocked.r.code, 429);
  assert.strictEqual(blocked.r.body.code, 'RATE_LIMIT');
  assert.ok(Number(blocked.r.headers['Retry-After']) >= 1);
  assert.ok(hit('b').passed, 'another key is unaffected');
  c.t += 61_000;
  assert.ok(hit('a').passed, 'window passed');
});

test('daily usage rolls over at UTC midnight and persists', () => {
  const c = clock(Date.parse('2026-11-08T23:59:00Z'));
  const file = path.join(tmp(), 'usage.json');
  const u = new Usage(file, c.now);
  u.add({ spend: 0.5, reruns: 1 }); u.add({ spend: 0.25, payments: 2 });
  assert.deepStrictEqual({ ...u.snapshot() }, { day: '2026-11-08', spend_usd: 0.75, reruns: 1, payments: 2 });
  assert.strictEqual(new Usage(file, c.now).snapshot().spend_usd, 0.75, 'survives a restart on the same disk');
  c.t = Date.parse('2026-11-09T00:01:00Z');
  assert.deepStrictEqual(u.snapshot(), { day: '2026-11-09', spend_usd: 0, reruns: 0, payments: 0 });
});
