// Classify a seller catalog CSV and save the result keyed by SKU.
//
//   node src/enrich-catalog.js [input.csv] [output.json]
//
// Defaults: data/demo-catalog.csv -> data/enriched-catalog.json
// Every row gets status "ok" or "needs_review" (confidence < 0.6, or no code).
// SYNTHETIC: the demo catalog is invented; the output says so in meta.synthetic.

const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from the shell */ }

const { classify, FLAG_THRESHOLD } = require('./classify');

const ROOT = path.join(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'data', 'demo-catalog.csv');
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'enriched-catalog.json');
const CONCURRENCY = 5;

function parseCsv(text) {
  const rows = [];
  let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function readCatalog(file) {
  const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
  const [header, ...rows] = parseCsv(text);
  const need = ['sku', 'raw_name', 'unit_price'];
  const missing = need.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`Catalog is missing columns: ${missing.join(', ')}`);
  const seen = new Set();
  return rows.map((r, n) => {
    const o = Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]));
    const where = `row ${n + 1}${o.sku ? ` (${o.sku})` : ''}`;
    if (!o.sku) throw new Error(`Catalog ${where}: empty sku`);
    if (o.sku.length > 12) throw new Error(`Catalog ${where}: sku longer than 12 characters (Braintree productCode limit)`);
    if (seen.has(o.sku)) throw new Error(`Catalog ${where}: duplicate sku`);
    seen.add(o.sku);
    if (!o.raw_name) throw new Error(`Catalog ${where}: empty raw_name`);
    if (!/^\d+(\.\d{1,2})?$/.test(o.unit_price)) throw new Error(`Catalog ${where}: unit_price must be a plain amount like 12.50`);
    return o;
  });
}

async function enrichCatalog({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT, log = console.log } = {}) {
  const rows = readCatalog(input);
  const items = {};
  const order = rows.map((r) => r.sku);
  let next = 0;
  let cost = 0;
  let costKnown = true;
  let model = process.env.LLM_MODEL;

  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      let res; let error = null;
      try {
        res = await classify(row.raw_name, { sku: row.sku });
      } catch (e) {
        if (/^HTTP 40[13]/.test(e.message)) throw e; // credentials/credit problem: stop everything
        error = e.message;
      }
      if (res) {
        const u = res.diagnostics.usage;
        if (u.cost_usd == null) costKnown = false; else cost += u.cost_usd;
        model = res.diagnostics.model;
      }
      const needsReview = !res || !res.unspsc || res.confidence < FLAG_THRESHOLD;
      items[row.sku] = {
        sku: row.sku,
        raw_name: row.raw_name,
        unit_price: row.unit_price,
        unspsc: res ? res.unspsc : null,
        unspsc_title: res ? res.unspsc_title : null,
        confidence: res ? res.confidence : 0,
        uom_braintree: res ? res.uom_braintree : null,
        uom_paypal: res ? res.uom_paypal : null,
        description: res ? res.description : null,
        reason: res ? res.reason : `CLASSIFICATION FAILED: ${error}`,
        status: needsReview ? 'needs_review' : 'ok',
        flags: res ? res.diagnostics.flags : ['call_failed'],
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  const ordered = Object.fromEntries(order.map((sku) => [sku, items[sku]]));
  const counts = { ok: 0, needs_review: 0 };
  for (const it of Object.values(ordered)) counts[it.status]++;
  const out = {
    meta: {
      synthetic: true,
      note: 'SYNTHETIC: invented demo catalog (fictional Northfield Lab Supply).',
      source: path.relative(ROOT, input),
      model,
      generated_at: new Date().toISOString(),
      flag_threshold: FLAG_THRESHOLD,
      rows: rows.length,
      counts,
      cost_usd: costKnown ? Number(cost.toFixed(6)) : null,
    },
    items: ordered,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(out, null, 2)}\n`);
  log(`Enriched ${rows.length} rows with ${model}: ${counts.ok} ok, ${counts.needs_review} needs_review (confidence < ${FLAG_THRESHOLD} or no code). Cost $${costKnown ? cost.toFixed(4) : 'n/a'}. Wrote ${path.relative(process.cwd(), output)}`);
  return out;
}

module.exports = { enrichCatalog, readCatalog, DEFAULT_OUTPUT, DEFAULT_INPUT };

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  enrichCatalog({ input: input ? path.resolve(input) : undefined, output: output ? path.resolve(output) : undefined })
    .then((out) => {
      console.log('\nsku       status        conf  code      name');
      for (const it of Object.values(out.items)) {
        console.log(`${it.sku.padEnd(9)} ${it.status.padEnd(13)} ${String(it.confidence).padEnd(5)} ${(it.unspsc || '-').padEnd(9)} ${it.raw_name}`);
      }
    })
    .catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
