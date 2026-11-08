#!/usr/bin/env node
// Measure how long a (possibly sleeping) deployment takes to answer.
//
//   BASE=https://your-app.onrender.com node scripts/coldstart.js [--wait-minutes=16]
//
// With --wait-minutes it first sleeps that long (Render's free tier sleeps after 15 idle minutes), then times
//   1. the first /health request (the cold start) and
//   2. the first page load (HTML) and a normal /health afterwards (warm).
// Prints the numbers to paste into docs/OPERATIONS.md. Makes no payments and no AI calls.

const BASE = (process.env.BASE || '').replace(/\/$/, '');
const arg = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

async function timed(url) {
  const t0 = Date.now();
  let status = 0; let error = null;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
      status = res.status;
      if (status === 200) break;
    } catch (e) { error = e.message; }
    if (Date.now() - t0 > 300_000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { seconds: (Date.now() - t0) / 1000, status, error };
}

(async () => {
  if (!BASE) { console.error('Set BASE=https://<your-service>.onrender.com'); process.exit(2); }
  if (arg['wait-minutes']) {
    console.log(`Waiting ${arg['wait-minutes']} minutes so the free instance goes to sleep...`);
    await new Promise((r) => setTimeout(r, Number(arg['wait-minutes']) * 60_000));
  }
  const cold = await timed(`${BASE}/health`);
  console.log(`first /health after idle: ${cold.seconds.toFixed(1)} s (HTTP ${cold.status}${cold.error ? `, last error: ${cold.error}` : ''})`);
  const page = await timed(`${BASE}/`);
  console.log(`first page load (HTML):   ${page.seconds.toFixed(1)} s (HTTP ${page.status})`);
  const warm = await timed(`${BASE}/health`);
  console.log(`warm /health:             ${warm.seconds.toFixed(2)} s`);
  console.log(cold.seconds > 10 ? 'The instance was asleep: expect the "waking up" screen for about this long.' : 'The instance answered quickly: it was already awake.');
})();
