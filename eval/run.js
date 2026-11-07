#!/usr/bin/env node
// M1 evaluation: classify every row of eval/labels.csv with LLM_MODEL and LLM_MODEL_STRONG,
// then write eval/report.md (side by side).
//
//   node eval/run.js                 both models, writes eval/report.md
//   node eval/run.js --only=base     only LLM_MODEL         (writes eval/report.partial.md)
//   node eval/run.js --only=strong   only LLM_MODEL_STRONG  (writes eval/report.partial.md)
//   node eval/run.js --limit=5       first N rows only      (writes eval/report.partial.md)
//
// SYNTHETIC DATA: eval/labels.csv is invented. Results say nothing about real catalogs.
// Spend cap: LLM_MAX_SPEND_USD (default 3). Set a limit on the OpenRouter key as well.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may come from the shell */ }

const { classify, FLAG_THRESHOLD, BRAINTREE_UOM, PAYPAL_UOM } = require(path.join(ROOT, 'src', 'classify.js'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const CONCURRENCY = 5;
const SPEND_CAP = Number(process.env.LLM_MAX_SPEND_USD || 3);
const HIGH_CONF_WRONG = 0.85;

// ---------- labels ----------

function parseCsv(text) {
  const rows = [];
  let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
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

function loadLabels() {
  const text = fs.readFileSync(path.join(__dirname, 'labels.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
  const [header, ...rows] = parseCsv(text);
  return rows.map((r) => {
    const o = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
    o.alts = [...o.notes.matchAll(/alt (\d{8})/g)].map((m) => m[1]);
    o.hard = /HARD/.test(o.notes);
    return o;
  });
}

// ---------- scoring ----------

const isNone = (code) => !code || code === 'NONE';
const cls = (c) => (c ? c.slice(0, 6) : null);

function score(label, res) {
  const flaggedBase = res.confidence < FLAG_THRESHOLD || !res.unspsc; // confidence rule only
  const flagged = flaggedBase || !!res.look_alike; // production rule: + look-alike runner-up
  const exp = label.expected_unspsc;
  let exact; let accept; let classExact; let classAccept;
  if (isNone(exp)) {
    // NONE rows: correct if the classifier returns no code, or flags the row for review.
    exact = accept = classExact = classAccept = !res.unspsc || flagged;
  } else {
    const ok = [exp, ...label.alts];
    exact = res.unspsc === exp;
    accept = ok.includes(res.unspsc);
    classExact = cls(res.unspsc) === cls(exp);
    classAccept = ok.map(cls).includes(cls(res.unspsc));
  }
  return { exact, accept, classExact, classAccept, flagged, flaggedBase };
}

function summarize(label, rows) {
  const n = rows.length;
  const pct = (k, d) => (d ? (100 * k) / d : 0);
  const cnt = (f) => rows.filter(f).length;
  const high = rows.filter((r) => !r.s.flagged);
  const scoredUom = rows.filter((r) => r.label.expected_uom_braintree);
  const wrongHigh = rows.filter((r) => !r.s.accept && r.res.confidence > HIGH_CONF_WRONG);
  const withCode = rows.filter((r) => !isNone(r.label.expected_unspsc));
  const cost = rows.reduce((a, r) => a + (r.res.diagnostics.usage.cost_usd ?? 0), 0);
  const costKnown = rows.every((r) => r.res.diagnostics.usage.cost_usd != null);
  return {
    n,
    exact: pct(cnt((r) => r.s.exact), n),
    accept: pct(cnt((r) => r.s.accept), n),
    classExact: pct(cnt((r) => r.s.classExact), n),
    classAccept: pct(cnt((r) => r.s.classAccept), n),
    recall: pct(withCode.filter((r) => r.res.diagnostics.shortlist.includes(r.label.expected_unspsc)).length, withCode.length),
    recallBefore: pct(withCode.filter((r) => (r.res.diagnostics.shortlist_raw_only || []).includes(r.label.expected_unspsc)).length, withCode.length),
    recallHitsBefore: withCode.filter((r) => (r.res.diagnostics.shortlist_raw_only || []).includes(r.label.expected_unspsc)).length,
    recallHitsAfter: withCode.filter((r) => r.res.diagnostics.shortlist.includes(r.label.expected_unspsc)).length,
    normFailed: cnt((r) => r.res.diagnostics.flags.includes('normalize_failed')),
    recallN: withCode.length,
    btValid: pct(cnt((r) => r.res.diagnostics.uom_valid_as_returned.braintree && BRAINTREE_UOM.includes(r.res.uom_braintree)), n),
    ppValid: pct(cnt((r) => r.res.diagnostics.uom_valid_as_returned.paypal && PAYPAL_UOM.includes(r.res.uom_paypal)), n),
    btValidFinal: pct(cnt((r) => BRAINTREE_UOM.includes(r.res.uom_braintree)), n),
    ppValidFinal: pct(cnt((r) => PAYPAL_UOM.includes(r.res.uom_paypal)), n),
    btMatch: pct(scoredUom.filter((r) => r.res.uom_braintree === r.label.expected_uom_braintree).length, scoredUom.length),
    ppMatch: pct(scoredUom.filter((r) => r.res.uom_paypal === r.label.expected_uom_paypal).length, scoredUom.length),
    flaggedBase: pct(cnt((r) => r.s.flaggedBase), n),
    flaggedBaseN: cnt((r) => r.s.flaggedBase),
    lookOnly: rows.filter((r) => !r.s.flaggedBase && r.s.flagged),
    wrongUnflaggedBase: cnt((r) => !r.s.accept && !r.s.flaggedBase),
    wrongUnflaggedFull: cnt((r) => !r.s.accept && !r.s.flagged),
    highAcceptBase: pct(rows.filter((r) => !r.s.flaggedBase && r.s.accept).length, rows.filter((r) => !r.s.flaggedBase).length),
    flagged: pct(cnt((r) => r.s.flagged), n),
    flaggedN: cnt((r) => r.s.flagged),
    highN: high.length,
    highExact: pct(high.filter((r) => r.s.exact).length, high.length),
    highAccept: pct(high.filter((r) => r.s.accept).length, high.length),
    highClass: pct(high.filter((r) => r.s.classExact).length, high.length),
    wrongHighN: wrongHigh.length,
    easyAccept: pct(rows.filter((r) => !r.label.hard && r.s.accept).length, rows.filter((r) => !r.label.hard).length),
    hardAccept: pct(rows.filter((r) => r.label.hard && r.s.accept).length, rows.filter((r) => r.label.hard).length),
    promptTokens: rows.reduce((a, r) => a + (r.res.diagnostics.usage.prompt_tokens ?? 0), 0),
    completionTokens: rows.reduce((a, r) => a + (r.res.diagnostics.usage.completion_tokens ?? 0), 0),
    cost, costKnown,
    errors: cnt((r) => r.res.diagnostics.flags.includes('call_failed')),
    descFallbacks: cnt((r) => r.res.diagnostics.flags.some((f) => f.startsWith('description_'))),
    repairedUom: cnt((r) => r.res.diagnostics.flags.some((f) => f.endsWith('_repaired'))),
  };
}

// ---------- running ----------

const spend = { total: 0 };

async function runModel(name, model, labels) {
  const t0 = Date.now();
  const results = new Array(labels.length);
  let next = 0;
  async function worker() {
    while (next < labels.length) {
      const i = next++;
      const label = labels[i];
      if (spend.total >= SPEND_CAP) throw new Error(`Spend cap $${SPEND_CAP} reached (spent $${spend.total.toFixed(4)}). Stopping.`);
      const t = Date.now();
      let res;
      try {
        res = await classify(label.raw_name, { sku: label.sku, model });
      } catch (e) {
        if (/^HTTP 40[13]/.test(e.message)) throw e; // auth/credit problems: stop the whole run
        res = {
          sku: label.sku, raw_name: label.raw_name, unspsc: null, unspsc_title: null, confidence: 0,
          uom_braintree: 'EA', uom_paypal: 'EACH', description: label.raw_name.slice(0, 126), reason: `CALL FAILED: ${e.message}`, flagged: true,
          diagnostics: { model, flags: ['call_failed'], normalized: null, shortlist_raw_only: [], shortlist: [], usage: { prompt_tokens: null, completion_tokens: null, cost_usd: null }, uom_valid_as_returned: { braintree: false, paypal: false } },
        };
      }
      const u = res.diagnostics.usage;
      spend.total += u.cost_usd ?? 0;
      console.log(`[${name}] ${label.sku} in=${u.prompt_tokens} out=${u.completion_tokens} $${u.cost_usd ?? 'n/a'} ${((Date.now() - t) / 1000).toFixed(1)}s conf=${res.confidence} ${res.unspsc ?? 'null'}`);
      results[i] = { label, res, s: score(label, res) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, labels.length) }, worker));
  const seconds = (Date.now() - t0) / 1000;
  return { name, model, rows: results, seconds, summary: summarize(name, results) };
}

// ---------- report ----------

function gitInfo() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? ' (uncommitted changes)' : '';
    return sha + dirty;
  } catch { return 'n/a (not a git repository or no commits yet)'; }
}

const f1 = (x) => `${x.toFixed(1)}%`;
const usd = (x, known = true) => (known ? `$${x.toFixed(4)}` : `$${x.toFixed(4)} (some calls had no cost data)`);

function pass(runs, fn) { return runs.map(fn).join(' | '); }
const PF = (b) => (b ? 'PASS' : 'FAIL');

function buildReport(runs, partialNote) {
  const date = new Date().toISOString().slice(0, 10);
  const L = [];
  L.push('# LineGrade M1: AI classification accuracy');
  L.push('');
  L.push('> **SYNTHETIC DATA.** 60 invented product names (`eval/labels.csv`). Results measure this small synthetic set only; they say nothing about real catalogs.');
  if (partialNote) L.push(`> **PARTIAL RUN: ${partialNote}**`);
  L.push('');
  if (runs.length === 1 && runs[0].name === 'LLM_MODEL' && !partialNote) L.push('> Only `LLM_MODEL` was run this time. Sonnet (`LLM_MODEL_STRONG`) was not re-run after the label corrections; its run-1 results, scored against the old labels, are in `eval/report-run1.md`.');
  L.push(`- Date: ${date}`);
  L.push(`- Git commit: ${gitInfo()}`);
  L.push(`- Code list: UNSPSC UNv260801 (c) UNDP, subset of ${require(path.join(ROOT, 'src', 'classify.js')).loadIndex().entries.length} commodity codes, LLM normalisation, keyword shortlist of 40 (raw + rewritten text), then LLM choice (normalisation model: LLM_MODEL_NORMALIZE, else LLM_MODEL)`);
  L.push(`- Flag (needs_review): confidence < ${FLAG_THRESHOLD}, no code, or a look-alike runner-up (same 6-digit class, confidence gap < 0.2; classifier version ${require(path.join(ROOT, 'src', 'classify.js')).CLASSIFIER_VERSION})`);
  L.push(`- Rows: ${runs[0].summary.n}, concurrency ${CONCURRENCY}`);
  L.push('');
  L.push('## Summary (side by side)');
  L.push('');
  L.push(`| Metric | ${runs.map((r) => `${r.name}: \`${r.model}\``).join(' | ')} |`);
  L.push(`|---|${runs.map(() => '---').join('|')}|`);
  const row = (name, f) => L.push(`| ${name} | ${runs.map((r) => f(r.summary, r)).join(' | ')} |`);
  row('Exact 8-digit, primary code', (s) => f1(s.exact));
  row('Exact 8-digit, acceptable (primary or alt in notes)', (s) => f1(s.accept));
  row('Class level (first 6 digits), primary', (s) => f1(s.classExact));
  row('Class level (first 6 digits), acceptable', (s) => f1(s.classAccept));
  row('Acceptable exact: 50 normal rows / 10 hard rows', (s) => `${f1(s.easyAccept)} / ${f1(s.hardAccept)}`);
  row(`Shortlist recall@40 BEFORE normalisation (raw name only, ${runs[0].summary.recallN} coded rows)`, (s) => `${f1(s.recallBefore)} (${s.recallHitsBefore}/${s.recallN})`);
  row('Shortlist recall@40 AFTER normalisation (raw + rewritten phrase)', (s) => `${f1(s.recall)} (${s.recallHitsAfter}/${s.recallN})`);
  row('Normalisation calls that failed (fell back to raw only)', (s) => String(s.normFailed));
  row('UoM valid, Braintree (as returned by model)', (s) => f1(s.btValid));
  row('UoM valid, PayPal (as returned by model)', (s) => f1(s.ppValid));
  row('UoM valid after repair (what the app would send)', (s) => `BT ${f1(s.btValidFinal)}, PP ${f1(s.ppValidFinal)}`);
  row('UoM equals label, Braintree / PayPal (56 rows with a label)', (s) => `${f1(s.btMatch)} / ${f1(s.ppMatch)}`);
  row('Flagged share, confidence rule only (< 0.6 or no code)', (s) => `${f1(s.flaggedBase)} (${s.flaggedBaseN}/${s.n})`);
  row('Flagged share, + look-alike rule (used for targets)', (s) => `${f1(s.flagged)} (${s.flaggedN}/${s.n})`);
  row('Wrong answers left unflagged: confidence rule only / + look-alike rule', (s) => `${s.wrongUnflaggedBase} / ${s.wrongUnflaggedFull}`);
  row('Accuracy of unflagged rows (acceptable): confidence rule only / + look-alike rule', (s) => `${f1(s.highAcceptBase)} / ${f1(s.highAccept)}`);
  row('Accuracy on unflagged rows: exact primary', (s) => `${f1(s.highExact)} (n=${s.highN})`);
  row('Accuracy on unflagged rows: exact acceptable', (s) => f1(s.highAccept));
  row('Accuracy on unflagged rows: class level primary', (s) => f1(s.highClass));
  row(`Wrong answers with confidence > ${HIGH_CONF_WRONG}`, (s) => String(s.wrongHighN));
  row('Cost, 60 rows (normalise + classify calls)', (s) => usd(s.cost, s.costKnown));
  row('Cost per row', (s) => `$${(s.cost / s.n).toFixed(5)}`);
  row('Tokens in / out', (s) => `${s.promptTokens} / ${s.completionTokens}`);
  row('Time, 60 rows (wall clock)', (s, r) => `${r.seconds.toFixed(0)} s`);
  row('Failed calls / description fallbacks', (s) => `${s.errors} / ${s.descFallbacks}`);
  L.push('');
  L.push('## Targets');
  L.push('');
  L.push(`| Target | ${runs.map((r) => r.name).join(' | ')} |`);
  L.push(`|---|${runs.map(() => '---').join('|')}|`);
  const t = (name, f) => L.push(`| ${name} | ${runs.map((r) => PF(f(r.summary))).join(' | ')} |`);
  t('Class level (primary) >= 80%', (s) => s.classExact >= 80);
  t('UoM valid 100% for both processors (as returned)', (s) => s.btValid === 100 && s.ppValid === 100);
  t(`No wrong answer with confidence > ${HIGH_CONF_WRONG}`, (s) => s.wrongHighN === 0);
  t('Flagged rows <= 25%', (s) => s.flagged <= 25);
  L.push('');
  L.push('Definitions: *primary* = `expected_unspsc`; *acceptable* also counts the `alt` code written in the notes. A row labelled `NONE` counts as correct if the classifier returns no code or flags the row (confidence < 0.6). "Wrong" for the confidence check means not acceptable at 8 digits. UoM validity is checked against the allowed Braintree set (' + BRAINTREE_UOM.join(', ') + ') and the PayPal tested set (' + PAYPAL_UOM.join(', ') + ').');
  L.push('');
  const byCode = require(path.join(ROOT, 'src', 'classify.js')).loadIndex().byCode;
  const title = (c) => (byCode.get(c) ? byCode.get(c).title : '?');
  L.push('## Look-alike rule: effect on this eval');
  L.push('');
  L.push('The model also returns a runner-up code with its own confidence. A row becomes `needs_review` when the runner-up is in the same 6-digit class and the gap is under 0.2. The rule is general and was not tuned per row. Both flag counts below come from the same run, so they differ only by the rule. The prompt also changed (it now asks for the runner-up), so this run is not directly comparable with earlier ones.');
  L.push('');
  for (const r of runs) {
    const lo = r.summary.lookOnly;
    L.push(`**${r.name}**: the rule flagged ${lo.length} extra row(s) beyond the confidence rule (${f1(r.summary.flaggedBase)} -> ${f1(r.summary.flagged)} flagged); wrong answers left unflagged: ${r.summary.wrongUnflaggedBase} -> ${r.summary.wrongUnflaggedFull}.`);
    L.push('');
    if (lo.length) {
      L.push('| SKU | Raw name | Chosen (conf) | Runner-up (conf) | Chosen was right? |');
      L.push('|---|---|---|---|---|');
      for (const x of lo) L.push(`| ${x.label.sku} | ${x.label.raw_name} | ${x.res.unspsc} ${x.res.unspsc_title} (${x.res.confidence}) | ${x.res.runner_up.unspsc} ${x.res.runner_up.unspsc_title} (${x.res.runner_up.confidence}) | ${x.s.accept ? 'yes (review was not needed)' : 'no (caught)'} |`);
      L.push('');
    }
  }
  L.push('## Label corrections after run 1');
  L.push('');
  L.push('Run 1 (`eval/report-run1.md`) showed the models choosing a more specific commodity than the label for three rows. The labels were corrected; the old code stays as an alternate (`alt` in notes). No other label was changed.');
  L.push('');
  L.push('| SKU | Raw name | Old code (now alternate) | New code (primary) | Reason |');
  L.push('|---|---|---|---|---|');
  const reason = 'The label was a broader code in the same class; the official title matches the product exactly.';
  for (const [sku, name, o, n] of [
    ['SYN-022', '3-ring binder 1.5in white vw', '44122003', '44122037'],
    ['SYN-046', 'Claw hammer 16oz fiberglass hdl', '27111602', '27111618'],
    ['SYN-051', 'N95 resp mask NIOSH 20/bx', '46182002', '46182010'],
  ]) L.push(`| ${sku} | ${name} | ${o} ${title(o)} | ${n} ${title(n)} | ${reason} |`);
  L.push('');
  L.push('The correction was made after seeing run-1 results, so it favours the model on those three rows. Scores for runs 1 and 2 are not directly comparable.');
  L.push('');
  L.push('## Shortlist recall@40 history (53 coded rows)');
  L.push('');
  L.push('| Run | Matching rules | Raw name only | Raw + rewritten phrase |');
  L.push('|---|---|---|---|');
  L.push('| 1 | keyword v1 (exact, prefix, typo, abbreviation) | 94.3% (50/53) | 96.2% (51/53) |');
  const cur = runs[0].summary;
  L.push(`| 2 (this report) | keyword v2 (v1 + word-family stems, compound words) | ${f1(cur.recallBefore)} (${cur.recallHitsBefore}/${cur.recallN}) | ${f1(cur.recall)} (${cur.recallHitsAfter}/${cur.recallN}) |`);
  L.push('');
  L.push('Disclosure: the run-1 normalisation prompt contained three example rewrites taken from labelled rows (SYN-001, SYN-015, SYN-020). They were replaced with non-evaluation examples before run 2, so run-1 recall after normalisation is slightly optimistic. The v2 matching rules are general (stems, joined words); none refer to specific rows.');
  L.push('');
  for (const r of runs) {
    const wrong = r.rows.filter((x) => !x.s.accept);
    L.push(`## Wrong answers: ${r.name} (\`${r.model}\`), ${wrong.length} of ${r.summary.n}`);
    L.push('');
    if (!wrong.length) { L.push('None.'); L.push(''); continue; }
    L.push('| SKU | Raw name | Rewritten | Expected | Got | Conf | Class ok | In shortlist before / after | Reason (model) |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const x of wrong) {
      const yn = (list) => ((list || []).includes(x.label.expected_unspsc) ? 'yes' : 'NO');
      const inList = isNone(x.label.expected_unspsc) ? 'n/a' : `${yn(x.res.diagnostics.shortlist_raw_only)} / ${yn(x.res.diagnostics.shortlist)}`;
      const got = x.res.unspsc ? `${x.res.unspsc} ${x.res.unspsc_title}` : 'null';
      const exp = isNone(x.label.expected_unspsc) ? 'NONE' : x.label.expected_unspsc;
      const reason = String(x.res.reason || '').replace(/\|/g, '/').replace(/\n/g, ' ');
      L.push(`| ${x.label.sku} | ${x.label.raw_name} | ${x.res.diagnostics.normalized ?? '-'} | ${exp} | ${got} | ${x.res.confidence} | ${x.s.classAccept ? 'yes' : 'no'} | ${inList} | ${reason} |`);
    }
    L.push('');
  }
  L.push('## Rows that matched only the alternative code (acceptable but not exact)');
  L.push('');
  for (const r of runs) {
    const alt = r.rows.filter((x) => x.s.accept && !x.s.exact);
    L.push(`- ${r.name}: ${alt.length ? alt.map((x) => `${x.label.sku} (${x.res.unspsc})`).join(', ') : 'none'}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------- main ----------

async function main() {
  let labels = loadLabels();
  if (labels.length !== 60 && !args.limit) console.warn(`Warning: expected 60 label rows, found ${labels.length}`);
  if (args.limit) labels = labels.slice(0, Number(args.limit));
  if (args.skus) labels = labels.filter((l) => String(args.skus).split(',').includes(l.sku));

  const all = [
    { name: 'LLM_MODEL', model: process.env.LLM_MODEL },
    { name: 'LLM_MODEL_STRONG', model: process.env.LLM_MODEL_STRONG },
  ];
  let chosen = args.only === 'base' ? [all[0]] : args.only === 'strong' ? [all[1]] : all;
  if (!args.only && !all[1].model) { console.log('LLM_MODEL_STRONG is not set: running LLM_MODEL only.'); chosen = [all[0]]; }
  for (const m of chosen) if (!m.model) throw new Error(`${m.name} is not set in .env`);

  const runs = [];
  for (const m of chosen) {
    console.log(`\n== ${m.name} = ${m.model} (${labels.length} rows) ==`);
    runs.push(await runModel(m.name, m.model, labels));
  }
  console.log(`\nTotal spend: $${spend.total.toFixed(4)} (cap $${SPEND_CAP})`);

  const partial = (args.only || args.limit || args.skus) && !args['write-report'];
  const note = partial ? [args.only && `--only=${args.only}`, args.limit && `--limit=${args.limit}`].filter(Boolean).join(' ') : '';
  const out = path.join(__dirname, partial ? 'report.partial.md' : 'report.md');
  fs.writeFileSync(out, buildReport(runs, note));
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  for (const r of runs) {
    fs.writeFileSync(path.join(__dirname, 'results', `${r.name}.json`), JSON.stringify({ model: r.model, seconds: r.seconds, summary: r.summary, rows: r.rows.map((x) => ({ ...x.res, expected: x.label.expected_unspsc, score: x.s })) }, null, 2));
  }
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}

module.exports = { loadLabels, score, summarize, buildReport };
