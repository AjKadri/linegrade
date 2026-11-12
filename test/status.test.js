// /api/status: the neutral-path twin of /health (some ad and privacy blockers block any URL named "health").
for (const k of ['BT_MERCHANT_ID', 'BT_PUBLIC_KEY', 'BT_PRIVATE_KEY']) process.env[k] = 'test-dummy';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/index');
const { SessionManager } = require('../server/sessions');
const { Usage } = require('../server/usage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lg-status-'));
let server; let base; let sessions;
test.before(async () => {
  sessions = new SessionManager({ dir: tmp(), idleMs: 7_200_000 });
  process.env.RATE_LIMIT_IP_PER_MIN = '3';
  const app = createApp({ sessions, usage: new Usage(path.join(tmp(), 'usage.json')) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { delete process.env.RATE_LIMIT_IP_PER_MIN; server.close(); });

test('/api/status answers like /health, creates no session and is not rate limited', async () => {
  const h = await (await fetch(`${base}/health`)).json();
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/api/status`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('set-cookie'), null);
    const j = await r.json();
    assert.strictEqual(j.status, 'ok');
    assert.deepStrictEqual(Object.keys(j).sort(), Object.keys(h).sort());
  }
  assert.strictEqual(sessions.count(), 0);
  assert.strictEqual((await fetch(`${base}/api/state`)).status, 200); // ...while real API routes still count against the limit
});

test('the browser code never requests a URL with a word that filter lists commonly block', () => {
  const src = ['api.js', 'App.jsx'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8')).join('\n');
  const paths = [...src.matchAll(/['`](\/(?:api|health)[^'`$?]*)/g)].map((m) => m[1]);
  assert.ok(paths.length >= 8, `found ${paths.length} client paths`);
  for (const p of paths) assert.doesNotMatch(p, /health|track|analytic|\bads?\b|beacon|telemetry|pixel/i, p);
});
