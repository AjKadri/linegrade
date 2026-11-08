#!/usr/bin/env node
// Build data/unspsc-demo-subset.csv: ONLY the UNSPSC codes this demo uses (UNSPSC UNv260801, (c) UNDP).
// LOCAL USE ONLY: the output is gitignored and the server no longer reads it (UNSPSC is (c) UNDP and must not be
// committed or deployed). Kept for local rebuilds. Codes come from: the enriched demo catalog (chosen codes and runner-ups)
// and the labelled eval set (expected and alternate codes). Every row is copied from the full subset.
//
//   node scripts/build-demo-subset.js        (needs data/unspsc-subset.csv; run scripts/build-subset.js first)

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function main() {
  const full = path.join(ROOT, 'data', 'unspsc-subset.csv');
  if (!fs.existsSync(full)) throw new Error('data/unspsc-subset.csv is missing. Run: node scripts/build-subset.js');
  const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
  const header = lines[0];
  const byCode = new Map(lines.slice(1).map((l) => [l.split(',')[0], l]));

  const want = new Set();
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'enriched-catalog.json'), 'utf8'));
  for (const it of Object.values(catalog.items)) {
    if (it.unspsc) want.add(it.unspsc);
    if (it.runner_up && it.runner_up.unspsc) want.add(it.runner_up.unspsc);
  }
  for (const l of fs.readFileSync(path.join(ROOT, 'eval', 'labels.csv'), 'utf8').split('\n')) {
    if (l.startsWith('#') || l.startsWith('sku,')) continue;
    for (const m of l.matchAll(/\b\d{8}\b/g)) want.add(m[0]);
  }
  const rows = [...want].filter((c) => byCode.has(c)).sort().map((c) => byCode.get(c));
  const missing = [...want].filter((c) => !byCode.has(c));
  if (missing.length) throw new Error(`Codes not in the full subset: ${missing.join(', ')}`);
  const out = ['# UNSPSC UNv260801 (c) United Nations Development Programme (UNDP). Only the codes used by this demo. Source: https://www.unspsc.org', header, ...rows];
  fs.writeFileSync(path.join(ROOT, 'data', 'unspsc-demo-subset.csv'), `${out.join('\n')}\n`);
  console.log(`Wrote ${rows.length} codes to data/unspsc-demo-subset.csv`);
}

if (require.main === module) { try { main(); } catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); } }
