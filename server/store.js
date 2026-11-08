// Which enriched catalog the API serves. The committed data/enriched-catalog.json stays frozen:
// the first change (approve, exclude, re-run AI) copies it to data/session-catalog.json (gitignored)
// and everything after works on that copy. reset() goes back to the frozen file.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_OUTPUT: FROZEN } = require('../src/enrich-catalog');

const SESSION = path.join(__dirname, '..', 'data', 'session-catalog.json');

const activePath = () => (fs.existsSync(SESSION) ? SESSION : FROZEN);
const source = () => (fs.existsSync(SESSION) ? 'session' : 'frozen');

function ensureSession() {
  if (!fs.existsSync(SESSION)) fs.copyFileSync(FROZEN, SESSION);
  return SESSION;
}

// A "session" starts when the server starts or when the demo is reset. Orders are counted from then on.
let sessionStart = new Date().toISOString();
const getSessionStart = () => sessionStart;

function reset() { fs.rmSync(SESSION, { force: true }); sessionStart = new Date().toISOString(); }

/** Charged orders in a ledger object that were started at or after `sinceIso`, oldest first. */
function sessionOrders(ledgerObj, sinceIso) {
  return Object.entries(ledgerObj)
    .filter(([, v]) => v.status === 'charged' && (v.started_at || v.updated_at || '') >= sinceIso)
    .sort((a, b) => (a[1].started_at || a[1].updated_at).localeCompare(b[1].started_at || b[1].updated_at));
}

function read() {
  const parsed = JSON.parse(fs.readFileSync(activePath(), 'utf8'));
  return { meta: parsed.meta, items: Object.values(parsed.items), source: source() };
}

function counts(items) {
  const c = { total: items.length, ok: 0, needs_review: 0, excluded: 0, approved: 0 };
  for (const it of items) { c[it.status] = (c[it.status] || 0) + 1; if (it.approved) c.approved++; }
  const denominator = c.total - c.excluded;
  c.score = denominator ? Math.round((100 * c.ok) / denominator) : 0; // share of goods rows that are Level 3 ready
  return c;
}

module.exports = { getSessionStart, sessionOrders, activePath, ensureSession, reset, read, counts, source, FROZEN, SESSION };
