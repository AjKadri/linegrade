// Classify a seller catalog CSV and save the result keyed by SKU. Incremental by design:
// a seller reviews each row once, and the work is never redone behind their back.
//
//   node src/enrich-catalog.js [input.csv] [output.json] [--force]
//   node src/enrich-catalog.js approve SKU [--code=8DIGITS] [--uom=BX] [--description="..."] [--output=file.json]
//   node src/enrich-catalog.js unapprove SKU [--output=file.json]
//
// Defaults: data/demo-catalog.csv -> data/enriched-catalog.json
//
// Which rows are classified:
//   new SKU, changed raw_name, a failed earlier call, or a classifier version change -> classified
//   unchanged rows -> reused as they are (only unit_price is refreshed from the CSV)
//   approved rows  -> LOCKED: never re-classified, not even with --force (unapprove first)
//   --force        -> re-classify every row that is not approved
// Every row gets status "ok" or "needs_review" (confidence < 0.6, no code, or a look-alike runner-up).
// SYNTHETIC: the demo catalog is invented; the output says so in meta.synthetic.

const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from the shell */ }

const { classify, loadIndex, BRAINTREE_UOM, BT_TO_PP, CLASSIFIER_VERSION } = require('./classify');

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

function readExisting(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.items !== 'object') throw new Error('no "items" object');
    return parsed.items;
  } catch (e) {
    throw new Error(`Cannot read existing ${path.relative(process.cwd(), file)} (${e.message}). Fix or move it; refusing to overwrite approved work blindly.`);
  }
}

/**
 * Decide, per CSV row, whether to classify, reuse or leave locked. Pure function (no I/O, no LLM).
 * @returns {{actions: Record<string, {action: 'classify'|'reuse'|'locked', reason: string}>, removed: string[], dropped: string[], warnings: string[]}}
 */
function planEnrichment(rows, existing, { force = false, version = CLASSIFIER_VERSION } = {}) {
  const actions = {};
  const warnings = [];
  for (const row of rows) {
    const old = existing[row.sku];
    if (old && old.approved) {
      actions[row.sku] = { action: 'locked', reason: 'approved' };
      if (old.raw_name !== row.raw_name) warnings.push(`${row.sku}: approved row, but the catalog name changed ("${old.raw_name}" -> "${row.raw_name}"). Keeping the approved classification; run "unapprove ${row.sku}" to re-classify.`);
    } else if (!old) actions[row.sku] = { action: 'classify', reason: 'new' };
    else if (force) actions[row.sku] = { action: 'classify', reason: 'force' };
    else if (old.raw_name !== row.raw_name) actions[row.sku] = { action: 'classify', reason: 'changed' };
    else if ((old.classifier_version || 1) !== version) actions[row.sku] = { action: 'classify', reason: 'classifier_version' };
    else if ((old.flags || []).includes('call_failed')) actions[row.sku] = { action: 'classify', reason: 'retry_failed' };
    else actions[row.sku] = { action: 'reuse', reason: 'unchanged' };
  }
  const inCsv = new Set(rows.map((r) => r.sku));
  const gone = Object.keys(existing).filter((sku) => !inCsv.has(sku));
  const dropped = gone.filter((sku) => !existing[sku].approved);
  const removed = gone.filter((sku) => existing[sku].approved); // approved work is kept
  for (const sku of removed) warnings.push(`${sku}: approved row is no longer in the catalog CSV; keeping it.`);
  return { actions, removed, dropped, warnings };
}

function itemFromResult(row, res, error) {
  const needsReview = !res || res.needs_review;
  return {
    sku: row.sku,
    raw_name: row.raw_name,
    unit_price: row.unit_price,
    unspsc: res ? res.unspsc : null,
    unspsc_title: res ? res.unspsc_title : null,
    confidence: res ? res.confidence : 0,
    runner_up: res ? res.runner_up : null,
    uom_braintree: res ? res.uom_braintree : null,
    uom_paypal: res ? res.uom_paypal : null,
    description: res ? res.description : null,
    reason: res ? res.reason : `CLASSIFICATION FAILED: ${error}`,
    status: needsReview ? 'needs_review' : 'ok',
    review_reasons: res ? res.review_reasons : ['classification_failed'],
    approved: false,
    flags: res ? res.diagnostics.flags : ['call_failed'],
    classifier_version: CLASSIFIER_VERSION,
    model: res ? res.diagnostics.model : null,
    classified_at: new Date().toISOString(),
  };
}

async function enrichCatalog({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT, force = false, log = console.log } = {}) {
  const rows = readCatalog(input);
  const existing = readExisting(output);
  const plan = planEnrichment(rows, existing, { force });
  const items = {};
  const todo = [];
  for (const row of rows) {
    const { action } = plan.actions[row.sku];
    if (action === 'classify') todo.push(row);
    else items[row.sku] = { ...existing[row.sku], unit_price: row.unit_price }; // price is not a classification input
  }
  for (const sku of plan.removed) items[sku] = existing[sku];

  let next = 0; let cost = 0; let costKnown = true; let model = process.env.LLM_MODEL;
  async function worker() {
    while (next < todo.length) {
      const row = todo[next++];
      let res; let error = null;
      try { res = await classify(row.raw_name, { sku: row.sku }); } catch (e) {
        if (/^HTTP 40[13]/.test(e.message)) throw e; // credentials/credit problem: stop everything
        error = e.message;
      }
      if (res) {
        const u = res.diagnostics.usage;
        if (u.cost_usd == null) costKnown = false; else cost += u.cost_usd;
        model = res.diagnostics.model;
      }
      items[row.sku] = itemFromResult(row, res, error);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  const ordered = Object.fromEntries([...rows.map((r) => r.sku), ...plan.removed].map((sku) => [sku, items[sku]]));
  const counts = { ok: 0, needs_review: 0, approved: 0 };
  for (const it of Object.values(ordered)) { counts[it.status]++; if (it.approved) counts.approved++; }
  const byReason = {};
  for (const r of rows) { const a = plan.actions[r.sku]; const k = `${a.action}:${a.reason}`; byReason[k] = (byReason[k] || 0) + 1; }
  const out = {
    meta: {
      synthetic: true,
      note: 'SYNTHETIC: invented demo catalog (fictional Northfield Lab Supply).',
      source: path.relative(ROOT, input),
      model,
      classifier_version: CLASSIFIER_VERSION,
      generated_at: new Date().toISOString(),
      rows: rows.length,
      counts,
      last_run: { classified: todo.length, reused: rows.length - todo.length - Object.values(plan.actions).filter((a) => a.action === 'locked').length, locked: Object.values(plan.actions).filter((a) => a.action === 'locked').length, cost_usd: costKnown ? Number(cost.toFixed(6)) : null },
    },
    items: ordered,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(out, null, 2)}\n`);

  const lr = out.meta.last_run;
  log(`Catalog ${rows.length} rows: classified ${lr.classified} (${Object.entries(byReason).filter(([k]) => k.startsWith('classify')).map(([k, n]) => `${k.split(':')[1]} ${n}`).join(', ') || 'none'}), reused ${lr.reused}, locked ${lr.locked} (approved). Now ${counts.ok} ok, ${counts.needs_review} needs_review. Cost $${costKnown ? cost.toFixed(4) : 'n/a'}.`);
  if (plan.dropped.length) log(`Dropped ${plan.dropped.length} SKU(s) no longer in the CSV: ${plan.dropped.join(', ')}`);
  for (const w of plan.warnings) log(`WARNING: ${w}`);
  log(`Wrote ${path.relative(process.cwd(), output)}`);
  return out;
}

/** Seller approval: locks the row. Optional overrides: code, uom (Braintree short code), description. */
function approveSku(sku, overrides = {}, { output = DEFAULT_OUTPUT } = {}) {
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  const item = parsed.items[sku];
  if (!item) throw new Error(`SKU ${sku} is not in ${path.relative(process.cwd(), output)}`);
  const changes = [];
  if (overrides.code) {
    const entry = loadIndex().byCode.get(overrides.code);
    if (!entry) throw new Error(`Code ${overrides.code} is not in the code list (data/unspsc-subset.csv)`);
    if (item.unspsc !== overrides.code) changes.push(`code ${item.unspsc || 'none'} -> ${overrides.code}`);
    item.model_unspsc = item.model_unspsc || item.unspsc;
    item.unspsc = overrides.code; item.unspsc_title = entry.title;
  }
  if (overrides.uom) {
    if (!BRAINTREE_UOM.includes(overrides.uom)) throw new Error(`UoM must be one of ${BRAINTREE_UOM.join(', ')}`);
    if (item.uom_braintree !== overrides.uom) changes.push(`uom ${item.uom_braintree} -> ${overrides.uom}`);
    item.uom_braintree = overrides.uom; item.uom_paypal = BT_TO_PP[overrides.uom];
  }
  if (overrides.description) {
    if (overrides.description.length > 126) throw new Error('Description must be under 127 characters');
    changes.push('description edited');
    item.description = overrides.description;
  }
  if (!item.unspsc) throw new Error(`${sku} has no code yet: pass --code=<8 digits> to approve it`);
  if (!item.description || !item.uom_braintree) throw new Error(`${sku} is missing a description or unit: pass --description / --uom`);
  Object.assign(item, { status: 'ok', approved: true, approved_at: new Date().toISOString(), approval_changes: changes });
  fs.writeFileSync(output, `${JSON.stringify(parsed, null, 2)}\n`);
  return { sku, changes, item };
}

function unapproveSku(sku, { output = DEFAULT_OUTPUT } = {}) {
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  const item = parsed.items[sku];
  if (!item) throw new Error(`SKU ${sku} is not in ${path.relative(process.cwd(), output)}`);
  item.approved = false; delete item.approved_at; delete item.approval_changes;
  if (item.review_reasons && item.review_reasons.length) item.status = 'needs_review'; // back to what the model said
  fs.writeFileSync(output, `${JSON.stringify(parsed, null, 2)}\n`);
  return item;
}

module.exports = { enrichCatalog, planEnrichment, approveSku, unapproveSku, readCatalog, DEFAULT_OUTPUT, DEFAULT_INPUT };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const pos = argv.filter((a) => !a.startsWith('--'));
  const output = flags.output ? path.resolve(flags.output) : undefined;
  (async () => {
    if (pos[0] === 'approve' || pos[0] === 'unapprove') {
      if (!pos[1]) throw new Error(`usage: node src/enrich-catalog.js ${pos[0]} SKU [...]`);
      if (pos[0] === 'approve') {
        const r = approveSku(pos[1], { code: flags.code, uom: flags.uom, description: typeof flags.description === 'string' ? flags.description : undefined }, { output });
        console.log(`Approved and locked ${r.sku}: ${r.item.unspsc} ${r.item.unspsc_title}, ${r.item.uom_braintree}/${r.item.uom_paypal}${r.changes.length ? ` (changes: ${r.changes.join('; ')})` : ' (accepted as classified)'}`);
      } else {
        const it = unapproveSku(pos[1], { output });
        console.log(`Unlocked ${pos[1]} (status ${it.status}). The next enrich run with --force or a changed name will re-classify it.`);
      }
      return;
    }
    const out = await enrichCatalog({ input: pos[0] ? path.resolve(pos[0]) : undefined, output: pos[1] ? path.resolve(pos[1]) : output, force: !!flags.force });
    console.log('\nsku       status        conf  code      reasons             name');
    for (const it of Object.values(out.items)) {
      console.log(`${it.sku.padEnd(9)} ${(it.approved ? 'ok (approved)' : it.status).padEnd(13)} ${String(it.confidence).padEnd(5)} ${(it.unspsc || '-').padEnd(9)} ${(it.review_reasons || []).join(',').padEnd(19)} ${it.raw_name}`);
    }
  })().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
