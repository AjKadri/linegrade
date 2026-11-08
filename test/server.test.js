const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');
const store = require('../server/store');

// Dummy Braintree keys so the gateway object can be built; no test below reaches the network.
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) if (!process.env[k]) process.env[k] = 'test-dummy';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-srv-'));
const withEnv = async (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

let server; let base; let sessions; let clockNow = Date.now();
test.before(async () => {
  sessions = new SessionManager({ dir: tmp(), idleMs: 7_200_000, now: () => clockNow });
  const app = createApp({ sessions, usage: new Usage(path.join(tmp(), 'usage.json')) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// A browser: keeps its own cookie jar.
function browser() {
  let cookie = '';
  const b = {
    get cookie() { return cookie; },
    async call(method, url, body) {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* sse or html */ }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    get: (u) => b.call('GET', u),
    post: (u, body) => b.call('POST', u, body),
  };
  return b;
}
const demoLines = [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }];

test('/health works without a session and without a cookie', async () => {
  const r = await browser().get('/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
  assert.strictEqual(r.headers.get('set-cookie'), null);
  assert.strictEqual(sessions.count(), 0);
});

test('security headers and an HttpOnly, SameSite session cookie', async () => {
  const r = await browser().get('/api/state');
  assert.match(r.headers.get('set-cookie'), /^lg_sid=[A-Za-z0-9_-]{24}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax/);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

test('two browsers never see each other\'s approvals, resets or order counter', async () => {
  const a = browser(); const b = browser();
  await a.get('/api/state'); await b.get('/api/state');
  assert.notStrictEqual(a.cookie, b.cookie);
  const find = (r, sku) => r.body.items.find((i) => i.sku === sku);

  assert.strictEqual((await a.post('/api/review/exclude', { sku: 'NLS-038' })).status, 200);
  assert.strictEqual((await a.post('/api/review/approve', { sku: 'NLS-004' })).status, 200);
  const aCat = await a.get('/api/catalog'); const bCat = await b.get('/api/catalog');
  assert.strictEqual(find(aCat, 'NLS-038').status, 'excluded');
  assert.strictEqual(find(bCat, 'NLS-038').status, 'needs_review');
  assert.strictEqual(find(bCat, 'NLS-004').approved, false);
  assert.strictEqual(bCat.body.source, 'frozen');

  // B's preview of an order with NLS-038 is refused as needs_review; A's is refused as excluded.
  const pa = await a.post('/api/order/preview', { items: [{ sku: 'NLS-038', qty: 1 }] });
  const pb = await b.post('/api/order/preview', { items: [{ sku: 'NLS-038', qty: 1 }] });
  assert.deepStrictEqual(pa.body.refused.details.excluded, ['NLS-038']);
  assert.deepStrictEqual(pb.body.refused.details.needsReview, ['NLS-038']);

  // A's order counter: seed a charged entry in A's own ledger only.
  const aSession = [...sessions.sessions.values()].find((s) => `lg_sid=${s.id}` === a.cookie);
  fs.mkdirSync(aSession.dir, { recursive: true });
  fs.writeFileSync(path.join(aSession.dir, 'ledger.json'), JSON.stringify({ 'X-1': { status: 'charged', transactionId: 't1', amount: '958.05', started_at: new Date(Date.now() + 1000).toISOString() } }));
  assert.strictEqual((await a.get('/api/readiness')).body.level3Orders, 1);
  assert.strictEqual((await b.get('/api/readiness')).body.level3Orders, 0);

  // A resets: B is untouched, and A is back to the frozen catalog.
  await a.post('/api/catalog/reset');
  assert.strictEqual(find(await a.get('/api/catalog'), 'NLS-038').status, 'needs_review');
});

test('a session idle for more than 2 hours expires: the cookie is replaced and the work is gone', async () => {
  const a = browser();
  await a.post('/api/review/exclude', { sku: 'NLS-039' });
  const old = a.cookie;
  clockNow += 7_201_000;
  const r = await a.get('/api/catalog');
  assert.strictEqual(r.headers.get('x-lg-session'), 'expired');
  assert.notStrictEqual(a.cookie, old);
  assert.strictEqual(r.body.items.find((i) => i.sku === 'NLS-039').status, 'needs_review');
});

test('caps: each cap gives a clear 429 message, and the frozen-catalog replay keeps working', async () => {
  const cases = [
    [{ LIVE_AI: 'off' }, 'live_ai_off', /switched off/],
    [{ MAX_RERUNS_PER_SESSION: '0', LLM_API_KEY: 'x', LLM_MODEL: 'm' }, 'session_reruns', /used your 0 live AI re-runs/],
    [{ MAX_RERUNS_PER_DAY: '0', LLM_API_KEY: 'x', LLM_MODEL: 'm' }, 'global_reruns', /today's limit/],
    [{ LLM_DAILY_CAP_USD: '0', LLM_API_KEY: 'x', LLM_MODEL: 'm' }, 'daily_spend', /AI budget .* used up/],
  ];
  for (const [env, capName, re] of cases) {
    await withEnv(env, async () => {
      const b = browser();
      const r = await b.get('/api/enrich/stream');
      assert.strictEqual(r.status, 429, capName);
      assert.strictEqual(r.body.code, 'CAP_REACHED');
      assert.strictEqual(r.body.cap, capName);
      assert.match(r.body.error, re);
      assert.match(r.body.error, /frozen-catalog replay still works/);
      const replay = await b.get('/api/catalog'); // what the replay plays from
      assert.strictEqual(replay.status, 200);
      assert.strictEqual(replay.body.items.length, 40);
    });
  }
});

test('payment caps: per session and per day, before any Braintree call', async () => {
  await withEnv({ MAX_PAYMENTS_PER_SESSION: '0' }, async () => {
    const r = await browser().post('/api/order/pay', { items: demoLines });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.cap, 'session_payments');
    assert.match(r.body.error, /used your 0 sandbox payments/);
  });
  await withEnv({ MAX_PAYMENTS_PER_DAY: '0' }, async () => {
    const r = await browser().post('/api/order/pay', { items: demoLines });
    assert.strictEqual(r.body.cap, 'global_payments');
  });
});

test('rate limit on API routes: 429 with Retry-After; /health is exempt', async () => {
  await withEnv({ RATE_LIMIT_SESSION_PER_MIN: '4' }, async () => {
    const b = browser();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await b.get('/api/state')).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 429, 429]);
    const blocked = await b.get('/api/state');
    assert.strictEqual(blocked.body.code, 'RATE_LIMIT');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.strictEqual((await b.get('/health')).status, 200);
  });
});

test('AI provider unavailable: the run is abandoned, nothing changes, and the UI is told to show the replay', async () => {
  await withEnv({ LLM_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'x', LLM_MODEL: 'm', LLM_ATTEMPTS: '1', LLM_TIMEOUT_MS: '2000' }, async () => {
    const b = browser();
    const before = await b.get('/api/catalog');
    const r = await b.get('/api/enrich/stream?force=1');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /event: fallback/);
    assert.match(r.text, /AI_UNAVAILABLE/);
    assert.match(r.text, /Showing the frozen-catalog replay/);
    assert.doesNotMatch(r.text, /event: done/);
    const after = await b.get('/api/catalog');
    assert.deepStrictEqual(after.body.items, before.body.items, 'no row was damaged by the failed run');
    const state = await b.get('/api/state');
    assert.strictEqual(state.body.limits.rerunsLeft, state.body.limits.rerunsMax, 'a failed attempt does not use up a re-run');
  });
});

test('Braintree unavailable: clear outcome, nothing charged, ledger failed, retry is safe and repeatable', async () => {
  await withEnv({ ALLOW_CHAOS: '1', CHAOS_BRAINTREE: 'down' }, async () => {
    const b = browser();
    const body = { items: demoLines, orderId: 'CHAOS-ORDER-1' };
    const r1 = await b.post('/api/order/pay', body);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.outcome, 'braintree_unavailable');
    assert.strictEqual(r1.body.charged, false);
    assert.strictEqual(r1.body.retrySafe, true);
    const session = [...sessions.sessions.values()].find((s) => `lg_sid=${s.id}` === b.cookie);
    const led = JSON.parse(fs.readFileSync(path.join(session.dir, 'ledger.json'), 'utf8'));
    assert.strictEqual(Object.values(led)[0].status, 'failed'); // not pending, not unknown
    const r2 = await b.post('/api/order/pay', body); // retry with the same order: not blocked, same clear answer
    assert.strictEqual(r2.body.outcome, 'braintree_unavailable');
    assert.strictEqual((await b.get('/api/state')).body.limits.paymentsLeft, 5, 'unavailable attempts do not use up payments');
  });
});

test('Braintree unavailable while an earlier attempt is unresolved: refuses to charge again and says it cannot check', async () => {
  await withEnv({ ALLOW_CHAOS: '1', CHAOS_BRAINTREE: 'down' }, async () => {
    const b = browser();
    await b.get('/api/state');
    const session = [...sessions.sessions.values()].find((s) => `lg_sid=${s.id}` === b.cookie);
    fs.mkdirSync(session.dir, { recursive: true });
    const orderId = `${session.id.slice(0, 6)}-CHAOS-ORDER-2`;
    fs.writeFileSync(path.join(session.dir, 'ledger.json'), JSON.stringify({ [orderId]: { status: 'unknown', error: 'reply lost' } }));
    const r = await b.post('/api/order/pay', { items: demoLines, orderId: 'CHAOS-ORDER-2' });
    assert.strictEqual(r.body.outcome, 'braintree_unavailable');
    assert.strictEqual(r.body.charged, 'unknown');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(session.dir, 'ledger.json'), 'utf8'))[orderId].status, 'unknown', 'left for the next attempt to reconcile');
  });
});

test('input validation: messages name the line and the problem', async () => {
  const b = browser();
  const bad = async (items, re, extra = {}) => {
    const r = await b.post('/api/order/preview', { items, ...extra });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'INVALID_INPUT');
    assert.match(r.body.error, re);
    return r.body;
  };
  await bad([], /Add at least one line/);
  await bad([{ sku: 'NLS-002', qty: 0 }], /Line 1 \(NLS-002\): quantity must be from 1 to 1000/);
  await bad([{ sku: 'NLS-002', qty: 1001 }], /from 1 to 1000/);
  await bad([{ sku: 'NLS-002', qty: 2.5 }], /whole number/);
  await bad([{ sku: 'NLS-002', qty: 'abc' }], /enter a quantity/);
  await bad([{ sku: 'NLS-002', qty: '' }], /enter a quantity/);
  await bad([{ sku: '', qty: 1 }], /choose a SKU/);
  await bad([{ sku: 'NLS-002', qty: 1 }, { sku: 'NLS-002', qty: 2 }], /appears twice/);
  await bad([{ sku: "x'; drop", qty: 1 }], /not a valid SKU/);
  const e = await bad([{ sku: 'NLS-002', qty: 1 }, { sku: 'NLS-007', qty: -3 }], /Line 2 \(NLS-007\)/);
  assert.strictEqual(e.field, 'items.1.qty');
  await bad([{ sku: 'NLS-002', qty: 1 }], /PO number can be at most 17/, { poNumber: 'P'.repeat(18) });
  const garbage = await fetch(`${base}/api/order/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.strictEqual(garbage.status, 400);
  assert.match((await garbage.json()).error, /not valid JSON/);
});

test('unknown SKU and needs-review SKU: refused with the SKUs named, before any payment call', async () => {
  const b = browser();
  const unknown = await b.post('/api/order/pay', { items: [{ sku: 'NLS-999', qty: 1 }] });
  assert.strictEqual(unknown.body.outcome, 'refused');
  assert.deepStrictEqual(unknown.body.refused.details.missing, ['NLS-999']);
  assert.match(unknown.body.refused.message, /not in catalog: NLS-999/);
  const review = await b.post('/api/order/pay', { items: [{ sku: 'NLS-028', qty: 1 }] });
  assert.deepStrictEqual(review.body.refused.details.needsReview, ['NLS-028']);
  assert.match(review.body.messages.join(' '), /No Braintree call was made/);
  assert.strictEqual((await b.get('/api/state')).body.limits.paymentsLeft, 5);
});

test('the demo order previews at $958.05 and carries no card data', async () => {
  const r = await browser().post('/api/order/preview', { items: demoLines });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.totals.total, '958.05');
  assert.ok(!JSON.stringify(r.body).includes('4009040000000009'));
});

test('admin switch: hidden without a token, protected with one, turns live AI off', async () => {
  assert.strictEqual((await browser().get('/api/admin/status')).status, 404);
  await withEnv({ ADMIN_TOKEN: 'secret-token', LLM_API_KEY: 'x', LLM_MODEL: 'm' }, async () => {
    const b = browser();
    assert.strictEqual((await b.get('/api/admin/status')).status, 401);
    const call = (method, url, body, token = 'secret-token') => fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    assert.strictEqual((await call('GET', '/api/admin/status', null, 'wrong')).status, 401);
    const off = await (await call('POST', '/api/admin/live-ai', { enabled: false })).json();
    assert.strictEqual(off.liveAi.enabled, false);
    assert.strictEqual((await b.get('/api/enrich/stream')).body.cap, 'live_ai_off');
    await call('POST', '/api/admin/live-ai', { enabled: true });
  });
});

test('the same client order id in two sessions never collides: A sees "already charged", B does not', async () => {
  await withEnv({ ALLOW_CHAOS: '1', CHAOS_BRAINTREE: 'down' }, async () => {
    const a = browser(); const b = browser();
    await a.get('/api/state'); await b.get('/api/state');
    const sA = [...sessions.sessions.values()].find((s) => `lg_sid=${s.id}` === a.cookie);
    fs.mkdirSync(sA.dir, { recursive: true });
    fs.writeFileSync(path.join(sA.dir, 'ledger.json'), JSON.stringify({ [`${sA.id.slice(0, 6)}-SAME-ID-1`]: { status: 'charged', transactionId: 'tA', amount: '958.05', started_at: new Date().toISOString() } }));
    const body = { items: demoLines, orderId: 'SAME-ID-1' };
    assert.strictEqual((await a.post('/api/order/pay', body)).body.outcome, 'already_charged');
    assert.strictEqual((await b.post('/api/order/pay', body)).body.outcome, 'braintree_unavailable'); // B has no such order
  });
});
