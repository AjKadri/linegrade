// An expired/unknown cookie is reported once: one replacement session, one "expired" answer, new cookie in that same response.
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
    assert.strictEqual(rs.filter((r) => r.headers.get('x-lg-session') === 'expired').length, 1, 'exactly one expired answer');
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
