// An unknown cookie is reported once: one replacement session, one answer flagged, new cookie in that same response.
// A cookie this server never ended for idleness (e.g. it restarted after sleeping) is reported as "restarted", not "expired".
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) process.env[k] = 'test-dummy';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-exp-'));

test('concurrent requests with a stale cookie share one new session; only one carries the expired flag; later requests are clean', async () => {
  const sessions = new SessionManager({ dir: tmp(), idleMs: 7_200_000 });
  const app = createApp({ sessions, usage: new Usage(path.join(tmp(), 'u.json')) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const stale = 'lg_sid=STALESTALESTALESTALESTALE';
    const rs = await Promise.all(['/api/state', '/api/catalog', '/api/state'].map((u) => fetch(base + u, { headers: { cookie: stale } })));
    assert.strictEqual(rs.filter((r) => r.headers.get('x-lg-session') === 'restarted').length, 1, 'exactly one restarted answer');
    assert.strictEqual(rs.filter((r) => r.headers.get('x-lg-session') === 'expired').length, 0, 'a restart is not called an idle expiry');
    const cookies = rs.map((r) => r.headers.get('set-cookie'));
    for (const c of cookies) assert.match(c, /^lg_sid=[A-Za-z0-9_-]{24}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
    assert.strictEqual(new Set(cookies.map((c) => c.split(';')[0])).size, 1, 'one replacement session for all of them');
    assert.strictEqual(sessions.count(), 1);
    const next = await fetch(base + '/api/state', { headers: { cookie: cookies[0].split(';')[0] } });
    assert.strictEqual(next.headers.get('x-lg-session'), null, 'the new cookie is accepted, no expired flag');
    // a request that still carries the stale cookie later (within a minute) joins the same session, silently
    const late = await fetch(base + '/api/state', { headers: { cookie: stale } });
    assert.strictEqual(late.headers.get('x-lg-session'), null);
    assert.strictEqual(sessions.count(), 1);
  } finally { server.close(); }
});

test('a cookie this server ended for idleness is reported as expired, once', async () => {
  let now = 1_000_000;
  const sessions = new SessionManager({ dir: tmp(), idleMs: 7_200_000, now: () => now });
  const app = createApp({ sessions, usage: new Usage(path.join(tmp(), 'u.json')) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(base + '/api/state');
    const cookie = first.headers.get('set-cookie').split(';')[0];
    now += 7_201_000;
    const r = await fetch(base + '/api/state', { headers: { cookie } });
    assert.strictEqual(r.headers.get('x-lg-session'), 'expired');
  } finally { server.close(); }
});
