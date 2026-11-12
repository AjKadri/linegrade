// Per-session catalog store. The committed data/enriched-catalog.json stays frozen. A session's first change
// (approve, exclude, re-run AI) copies it to <session dir>/catalog.json; everything after works on that copy.
// reset() goes back to the frozen file and starts a new "order window" for the readiness counter.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_OUTPUT: FROZEN } = require('../src/enrich-catalog');

/** A store bound to one session object (see sessions.js). Nothing here is shared between sessions. */
function forSession(session) {
  const catalogFile = path.join(session.dir, 'catalog.json');
  const ledgerFile = path.join(session.dir, 'ledger.json');
  const exists = () => fs.existsSync(catalogFile);
  return {
    catalogFile, ledgerFile,
    activePath: () => (exists() ? catalogFile : FROZEN),
    source: () => (exists() ? 'session' : 'frozen'),
    ensureSession() {
      if (!exists()) { fs.mkdirSync(session.dir, { recursive: true }); fs.copyFileSync(FROZEN, catalogFile); }
      return catalogFile;
    },
    reset() { fs.rmSync(catalogFile, { force: true }); session.start = new Date().toISOString(); },
    read() {
      const parsed = JSON.parse(fs.readFileSync(exists() ? catalogFile : FROZEN, 'utf8'));
      return { meta: parsed.meta, items: Object.values(parsed.items), source: exists() ? 'session' : 'frozen' };
    },
    sessionStart: () => session.start,
  };
}

/** LineGrade (Level 3) orders in a ledger object that were charged and started at or after `sinceIso`, oldest first. Level 1 sales are not counted. */
function sessionOrders(ledgerObj, sinceIso) {
  return Object.entries(ledgerObj)
    .filter(([, v]) => v.status === 'charged' && v.level !== 1 && (v.started_at || v.updated_at || '') >= sinceIso)
    .sort((a, b) => (a[1].started_at || a[1].updated_at).localeCompare(b[1].started_at || b[1].updated_at));
}

function counts(items) {
  const c = { total: items.length, ok: 0, needs_review: 0, excluded: 0, approved: 0 };
  for (const it of items) { c[it.status] = (c[it.status] || 0) + 1; if (it.approved && it.status !== 'excluded') c.approved++; } // excluded rows are locked too but counted under excluded
  const denominator = c.total - c.excluded;
  c.score = denominator ? Math.round((100 * c.ok) / denominator) : 0; // share of goods rows that are Level 3 ready
  return c;
}

module.exports = { forSession, sessionOrders, counts, FROZEN };
