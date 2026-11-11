#!/usr/bin/env node
// Builds eval/holdout/report.md (codes only, no official titles) from eval/holdout/raw/LLM_MODEL.json,
// the output of: node eval/run.js --labels eval/holdout/labels-proposed.csv --only=base
// Also reads eval/holdout/raw/run-meta.json ({ runStart, runCommit }).
const fs = require('node:fs');
const path = require('node:path');

const D = __dirname;
const raw = JSON.parse(fs.readFileSync(path.join(D, 'raw', 'LLM_MODEL.json'), 'utf8'));
const { runStart, runCommit } = JSON.parse(fs.readFileSync(path.join(D, 'raw', 'run-meta.json'), 'utf8'));
const labels = Object.fromEntries(fs.readFileSync(path.join(D, 'labels-proposed.csv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).slice(1)
  .map((l) => { const [sku, raw_name, code, bt, pp, ...notes] = l.split(','); return [sku, { raw_name, code, bt, pp, notes: notes.join(',') }]; }));
const rows = raw.rows; const s = raw.summary; const n = rows.length;
const pc = (k, d) => `${(100 * k / d).toFixed(1)}% (${k}/${d})`;
const isNone = (r) => labels[r.sku].code === 'NONE';
const alts = (r) => [...labels[r.sku].notes.matchAll(/alt (\d{8})/g)].map((m) => m[1]);
const exact = rows.filter((r) => r.score.exact).length;
const accept = rows.filter((r) => r.score.accept).length;
const cls = rows.filter((r) => r.score.classExact).length;
const clsA = rows.filter((r) => r.score.classAccept).length;
const flagged = rows.filter((r) => r.score.flagged);
const none = rows.filter(isNone); const noneOk = none.filter((r) => r.score.accept);
const coded = rows.filter((r) => !isNone(r));
const misses = rows.filter((r) => !r.score.accept);
const altOnly = rows.filter((r) => r.score.accept && !r.score.exact);
const wrongHigh = rows.filter((r) => !r.score.accept && r.confidence > 0.85);
const wrongUnflagged = rows.filter((r) => !r.score.accept && !r.score.flagged);
const btOk = rows.filter((r) => r.uom_braintree === labels[r.sku].bt).length;
const ppOk = rows.filter((r) => r.uom_paypal === labels[r.sku].pp).length;
const uomMiss = rows.filter((r) => r.uom_braintree !== labels[r.sku].bt || r.uom_paypal !== labels[r.sku].pp);
const exp = (r) => (isNone(r) ? 'NONE' : labels[r.sku].code + (alts(r).length ? ` (alt ${alts(r).join(', ')})` : ''));
const got = (r) => r.unspsc || 'null';
const ru = (r) => (r.runner_up && r.runner_up.unspsc ? `${r.runner_up.unspsc} (${r.runner_up.confidence})` : '-');

const L = [];
L.push('# LineGrade frozen holdout: result (single run)', '');
L.push('> **SYNTHETIC DATA.** 30 invented product names (`eval/holdout/catalog.csv`), written before any holdout run and never used to tune the classifier. Labels (`labels-proposed.csv`) were proposed by the assistant and verified by the user before the run. Codes only: official UNSPSC titles are UNDP copyright and are not in this file. 30 rows is a small sample: read every percentage with that in mind.', '');
L.push('| Item | Value |', '|---|---|');
L.push(`| Run timestamp (UTC) | ${runStart} |`, `| Repo commit at run | ${runCommit} |`);
L.push('| Classifier freeze | `acf8af7`; `src/classify.js` blob `5ae41f7bb202228499d601646dec904a6df05402` and the local code-list sha256 matched `FROZEN.md` immediately before the run |');
L.push(`| Model | \`${raw.model}\`, temperature 0, seed 42 (best effort), normalisation with the same model |`);
L.push('| Runs | 1 (no re-runs, no changes after seeing results) |');
L.push(`| Cost | $${s.cost.toFixed(4)} (${s.promptTokens} tokens in, ${s.completionTokens} out), ${raw.seconds.toFixed(0)} s wall clock |`, '');
L.push('## Numbers', '', '| Metric | Result |', '|---|---|');
L.push(`| n | ${n} (${coded.length} coded rows, ${none.length} NONE rows) |`);
L.push(`| Exact 8-digit, primary code | ${pc(exact, n)} |`);
L.push(`| Accepted (primary or alt code) | ${pc(accept, n)} |`);
L.push(`| Class level (first 6 digits), primary | ${pc(cls, n)} |`);
L.push(`| Class level, accepted | ${pc(clsA, n)} |`);
L.push(`| Flagged for review (confidence < 0.6, no code, or look-alike) | ${pc(flagged.length, n)} |`);
L.push(`| Confident-wrong (not accepted, confidence > 0.85) | ${wrongHigh.length} |`);
L.push(`| Wrong and NOT flagged (any confidence) | ${wrongUnflagged.length} |`);
L.push(`| NONE rows handled (no code returned or flagged) | ${noneOk.length}/${none.length} |`);
L.push(`| UoM equals label, Braintree / PayPal | ${pc(btOk, n)} / ${pc(ppOk, n)} |`);
L.push(`| UoM valid as returned, Braintree / PayPal | ${s.btValid}% / ${s.ppValid}% |`);
L.push(`| Shortlist recall@40 (coded rows): raw name only / raw + rewrite | ${s.recallHitsBefore}/${s.recallN} / ${s.recallHitsAfter}/${s.recallN} |`, '');
L.push('Scoring is the same code as the tuned-set harness (`eval/run.js`; only a `--labels` option was added). A NONE row counts as correct if the classifier returns no code or flags it.', '');

L.push(`## Misses (${misses.length}): not the expected code or an alt`, '', '| SKU | Raw name | Classifier code | Confidence | Runner-up (conf) | Expected | Flagged | Class ok |', '|---|---|---|---|---|---|---|---|');
for (const r of misses) L.push(`| ${r.sku} | ${r.raw_name} | ${got(r)} | ${r.confidence} | ${ru(r)} | ${exp(r)} | ${r.score.flagged ? 'yes' : 'no'} | ${r.score.classAccept ? 'yes' : 'no'} |`);

L.push('', `## Accepted only through an alt code (${altOnly.length})`, '');
L.push(altOnly.length ? '| SKU | Raw name | Classifier code | Confidence | Expected | Flagged |\n|---|---|---|---|---|---|' : 'None.');
for (const r of altOnly) L.push(`| ${r.sku} | ${r.raw_name} | ${got(r)} | ${r.confidence} | ${exp(r)} | ${r.score.flagged ? 'yes' : 'no'} |`);

L.push('', `## Every flagged row (${flagged.length})`, '', '| SKU | Raw name | Classifier code | Confidence | Expected | Review reasons | Verdict |', '|---|---|---|---|---|---|---|');
for (const r of flagged) L.push(`| ${r.sku} | ${r.raw_name} | ${got(r)} | ${r.confidence} | ${exp(r)} | ${(r.review_reasons || []).join(', ') || '-'} | ${isNone(r) ? 'NONE row, flag correct' : r.score.accept ? 'flag not needed (code was acceptable)' : 'flag caught a wrong code'} |`);

L.push('', '## Rows with a UoM different from the label', '');
L.push(uomMiss.length ? '| SKU | Raw name | Got BT/PP | Expected BT/PP |\n|---|---|---|---|' : 'None.');
for (const r of uomMiss) L.push(`| ${r.sku} | ${r.raw_name} | ${r.uom_braintree}/${r.uom_paypal} | ${labels[r.sku].bt}/${labels[r.sku].pp} |`);

L.push('', '## Look-alike pairs (tagged in `labels-proposed.csv` notes)', '', '| Pair | SKU: classifier code (conf), accepted? |', '|---|---|');
const pairs = {};
for (const r of rows) {
  const m = labels[r.sku].notes.match(/^(pair-[^;]*)/);
  if (m) (pairs[m[1]] = pairs[m[1]] || []).push(`${r.sku}: ${got(r)} (${r.confidence}) ${r.score.accept ? 'ok' : 'MISS'}`);
}
for (const [k, v] of Object.entries(pairs)) L.push(`| ${k} | ${v.join('; ')} |`);
L.push('', `Look-alike rule (same-class runner-up within 0.2): flagged ${s.lookOnly.length} extra row(s) in this run.`, '');
fs.writeFileSync(path.join(D, 'report.md'), L.join('\n'));
console.log('wrote eval/holdout/report.md');
