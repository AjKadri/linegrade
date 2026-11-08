// LineGrade classifier: raw product name -> UNSPSC code + units + specific description.
//
//   node src/classify.js "Nitrile glv M 100ct"
//
// 1. Keyword shortlist (typo/abbreviation tolerant) over data/unspsc-subset.csv (local only, not in git).
// 2. LLM (OpenRouter, OpenAI-compatible) picks from the shortlist.
// 3. Output is validated: codes must exist in the subset, units must be in the allowed sets.
//
// Env (.env, server-side only): LLM_BASE_URL, LLM_API_KEY, LLM_MODEL.

const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from the shell */ }

// The UNSPSC list is (c) UNDP and is NOT part of this repo: build it locally (see NOTICE, scripts/build-subset.js).
// UNSPSC_LIST_PATH only exists so tests can point at a missing file.
const SUBSET_PATH = process.env.UNSPSC_LIST_PATH || path.join(__dirname, '..', 'data', 'unspsc-subset.csv');
const codeListKind = () => (fs.existsSync(SUBSET_PATH) ? 'full' : 'none');
const SHORTLIST_SIZE = 40;
const FLAG_THRESHOLD = 0.6;
const MAX_DESCRIPTION = 126; // "under 127 characters"
const CLASSIFIER_VERSION = 2; // bump when prompt/rules change; enrich-catalog reclassifies unapproved rows on a change
const LOOKALIKE_GAP = 0.2; // runner-up in the same class within this confidence gap => needs review

// Braintree short codes we allow, and the PayPal values that were tested against the sandbox.
// EA/BX etc. make PayPal's sandbox return a 500, so PayPal never gets the short codes.
const BRAINTREE_UOM = ['EA', 'BX', 'PK', 'CS', 'LB', 'KG', 'LTR'];
const PAYPAL_UOM = ['EACH', 'BOX', 'PACK', 'CASE', 'UNIT', 'POUND', 'KILOGRAM', 'LITER', 'KGM', 'LTR', 'ITM'];
const BT_TO_PP = { EA: 'EACH', BX: 'BOX', PK: 'PACK', CS: 'CASE', LB: 'POUND', KG: 'KGM', LTR: 'LTR' };

// General look-alike rule: the runner-up sits in the same 6-digit class and is within LOOKALIKE_GAP.
function isLookAlike(code, confidence, runnerUp) {
  if (!code || !runnerUp || !runnerUp.unspsc) return false;
  if (code.slice(0, 6) !== runnerUp.unspsc.slice(0, 6)) return false;
  return Math.round((confidence - runnerUp.confidence) * 100) < Math.round(LOOKALIKE_GAP * 100);
}

const GENERIC_DESCRIPTIONS = /^(item|items|product|products|misc|miscellaneous|supplies|goods|general|other|stuff|thing|n\/a|none|unknown)(\s*\d*)?$/i;

// ---------- CSV + index ----------

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const STOP = new Set(['and', 'or', 'for', 'with', 'the', 'of', 'to', 'in', 'a', 'an', 'on', 'by', 'non', 'other', 'related', 'accessories', 'products', 'supplies', 'equipment']);

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// General word-family key so related word forms meet: copier -> copy, cleaning/cleaner -> clean,
// stapler/staple -> stapl. Applied to both query and title words; used as an extra exact-match channel.
const keyCache = new Map();
function undouble(s) {
  const n = s.length;
  return n > 3 && s[n - 1] === s[n - 2] && !'lsz'.includes(s[n - 1]) ? s.slice(0, -1) : s;
}
function stemKey(w) {
  let k = keyCache.get(w);
  if (k !== undefined) return k;
  k = w;
  if (k.length > 5 && k.endsWith('ier')) k = `${k.slice(0, -3)}y`;
  else if (k.length > 5 && k.endsWith('ing')) k = undouble(k.slice(0, -3));
  else if (k.length > 5 && k.endsWith('er')) k = undouble(k.slice(0, -2));
  else if (k.length > 4 && k.endsWith('ed')) k = undouble(k.slice(0, -2));
  if (k.length > 4 && k.endsWith('e')) k = k.slice(0, -1);
  keyCache.set(w, k);
  return k;
}

// Adjacent word pairs joined into one token, so "ball point" and "ballpoint" can meet.
function compounds(seq) {
  return seq.slice(0, -1).map((a, i) => ({ text: a + seq[i + 1], i }));
}

function tokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((t) => t.length >= 2 && !/\d/.test(t) && !STOP.has(t)).map(stem);
}

function isSubsequence(small, big) {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

function editDistanceLE1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

let INDEX = null;
function loadIndex() {
  if (INDEX) return INDEX;
  if (!fs.existsSync(SUBSET_PATH)) throw Object.assign(new Error('The UNSPSC code list is not installed on this machine, so live classification and code search are unavailable. Build it locally: node scripts/build-subset.js (see NOTICE).'), { code: 'NO_CODE_LIST' });
  const lines = fs.readFileSync(SUBSET_PATH, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const entries = lines.slice(1).map((l) => {
    const [code, title, classCode, classTitle] = parseCsvLine(l);
    const ctSeq = tokens(title);
    return { code, title, classCode, classTitle, ctSeq, cc: compounds(ctSeq), ct: [...new Set(ctSeq)], cl: [...new Set(tokens(classTitle))] };
  });
  const df = new Map();
  for (const e of entries) for (const t of new Set([...e.ct, ...e.cl])) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + entries.length / (df.get(t) || 1));
  INDEX = { entries, byCode: new Map(entries.map((e) => [e.code, e])), idf, df };
  return INDEX;
}

// How well does query token q match title token t? 0 if not at all.
function tokenMatch(q, t) {
  if (q === t) return 1;
  if (q.length >= 3 && t.length >= 3 && stemKey(q) === stemKey(t)) return 0.95; // copy ~ copier
  if (q.length >= 3 && t.startsWith(q)) return 0.75; // pipet -> pipette
  if (q.length >= 5 && editDistanceLE1(q, t)) return 0.8; // typos
  if (q.length >= 3 && q.length <= 6 && q[0] === t[0] && t.length >= q.length + 1 && isSubsequence(q, t)) return 0.55; // glv -> glove
  return 0;
}

// Shortlist over one or more query texts (raw name, normalised phrase): an entry's score is its best
// score across the texts, so the raw name keeps its hits and the rewrite can only add candidates.
function shortlist(texts, k = SHORTLIST_SIZE) {
  const list = Array.isArray(texts) ? texts : [texts];
  const best = new Map();
  for (const text of list) {
    for (const s of scoreEntries(text)) {
      const prev = best.get(s.e.code);
      if (!prev || s.score > prev.score) best.set(s.e.code, s);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.e.code.localeCompare(b.e.code))
    .slice(0, k).map((s) => s.e);
}

function scoreEntries(rawName) {
  const { entries, idf } = loadIndex();
  const qa = tokens(rawName);
  const q = [...new Set(qa)];
  if (!q.length) return [];
  const qc = [...new Set(compounds(qa).map((c) => c.text))];
  const scored = [];
  for (const e of entries) {
    let score = 0;
    const matched = new Set(); // indices of title words explained by the query
    for (const qt of q) {
      let best = 0; let bestIdx = -1;
      e.ctSeq.forEach((t, i) => { const m = tokenMatch(qt, t); if (m > best) { best = m; bestIdx = i; } });
      let bestCl = 0;
      for (const t of e.cl) { const m = tokenMatch(qt, t); if (m > bestCl) bestCl = m; }
      // Query word equals two joined title words ("ballpoint" ~ "ball point").
      let compScore = 0; let compAt = null;
      for (const c of e.cc) {
        if (tokenMatch(qt, c.text) >= 0.95) {
          const s = idf(e.ctSeq[c.i]) + idf(e.ctSeq[c.i + 1]);
          if (s > compScore) { compScore = s; compAt = c.i; }
        }
      }
      const wordScore = Math.max(best, bestCl * 0.4) * idf(qt);
      if (compScore > wordScore) { score += compScore; matched.add(compAt); matched.add(compAt + 1); }
      else if (wordScore > 0) { score += wordScore; if (best > 0) matched.add(bestIdx); }
    }
    // Two joined query words equal one title word ("ball point" ~ "ballpoint").
    for (const c of qc) {
      e.ctSeq.forEach((t, i) => { if (tokenMatch(c, t) >= 0.95) { score += idf(t); matched.add(i); } });
    }
    if (score === 0) continue;
    const coverage = e.ctSeq.length ? matched.size / e.ctSeq.length : 0;
    scored.push({ e, score: (score * (0.5 + 0.5 * coverage)) / Math.sqrt(Math.max(1, e.ct.length)) });
  }
  return scored;
}

// ---------- LLM ----------

const SYSTEM_PROMPT = `You classify messy B2B product names from seller catalogs for invoice Level 3 data.

For each product name you get a numbered shortlist of UNSPSC commodity codes. Choose ONE code from the shortlist, or null.

Rules:
- Pick only a code that appears in the shortlist. Never invent a code.
- Use null (and confidence <= 0.3) when nothing in the shortlist truly fits: fees, surcharges, freight, services, vague names ("misc supplies"), mixed kits of several different items, or goods whose proper code is not in the shortlist. A near-miss code is worse than null.
- confidence is a calibrated probability (0 to 1) that your code is exactly right. Use 0.9+ only when the name clearly matches a code. Lower it when two codes are plausible or the name is ambiguous.
- uom_braintree: the unit the line is SOLD in, from the pack size in the name. One of: EA (each/single item, set, roll, pail), BX (box), PK (pack, bag, sleeve, set of small items sold together), CS (case or carton), LB (sold by weight in pounds), KG (kilograms), LTR (litres).
  Examples of pack wording: "250/box" => BX. "cs/6" => CS. "4/pk" => PK. A single tool or instrument => EA.
- uom_paypal: the matching PayPal value, from ONLY: EACH, BOX, PACK, CASE, UNIT, POUND, KILOGRAM, LITER, KGM, LTR, ITM. (EA=>EACH, BX=>BOX, PK=>PACK, CS=>CASE, LB=>POUND, KG=>KGM, LTR=>LTR.) Never use abbreviations like EA or BX for PayPal.
- description: a specific, plain-English line item description, under 127 characters, built only from facts in the name (product, size, material, count). Expand abbreviations and fix typos. Never generic ("item", "misc", "supplies"). Do not invent specs that are not in the name. For null rows still describe what the line says.
- runner_up: the second most plausible shortlist code (never the same as unspsc) with its own confidence on the same 0-1 scale, or null if no other code is plausible. Be honest: when two codes are close (for example two near-identical products), give the runner-up a confidence close to your main one.
- reason: one short sentence (max 25 words) on why you chose this code (or null).

Reply with a single JSON object and nothing else:
{"unspsc": "<8 digits or null>", "confidence": <0-1>, "uom_braintree": "...", "uom_paypal": "...", "description": "...", "runner_up": {"unspsc": "<8 digits>", "confidence": <0-1>} or null, "reason": "..."}`;

const NORMALIZE_PROMPT = `You rewrite messy B2B catalog product names into a plain product phrase used to search a commodity code list.

- Expand abbreviations and fix typos (examples, none from the evaluation set: "Elec tape blk 3/4in 10rl" -> "electrical insulating tape", "Stnls stl wing nut 1/4-20" -> "stainless steel wing nuts", "Dry-ers mrkr chisel 4pk" -> "dry erase markers").
- Keep the product type, material and kind. Drop sizes, pack counts, colours and brand/part numbers.
- Use the common product noun a catalog would use, in singular or plural, in at most 8 words.
- If the line is not a product (a fee, surcharge, freight, service) or is too vague, restate it as written; do not guess a product.

Reply with one JSON object only: {"phrase": "<plain product phrase>"}`;

// Cheap first step: raw name -> plain phrase. Uses LLM_MODEL_NORMALIZE, else LLM_MODEL.
async function normalizeName(rawName, opts = {}) {
  const model = opts.normModel || process.env.LLM_MODEL_NORMALIZE || process.env.LLM_MODEL;
  const { text, usage } = await callLLM({
    model, maxTokens: 250, signal: opts.signal,
    messages: [{ role: 'system', content: NORMALIZE_PROMPT }, { role: 'user', content: JSON.stringify(rawName) }],
  });
  const phrase = String(parseJson(text).phrase || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { phrase, usage, model };
}

async function callLLM({ model, messages, signal, maxTokens = 800 }) {
  const base = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error('LLM_API_KEY is not set');
  if (!model) throw new Error('LLM model is not set (LLM_MODEL)');
  const attempts = Number(process.env.LLM_ATTEMPTS) || 4; // the server lowers these so a dead provider fails fast
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 60000;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages, temperature: 0, seed: 42, max_tokens: maxTokens, // temperature 0 + fixed seed (best effort)
          response_format: { type: 'json_object' },
          usage: { include: true }, // OpenRouter: returns cost in usage.cost
        }),
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`), { fatal: true });
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error('empty completion');
      return { text, usage: body.usage || {} };
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('no JSON in completion');
}

function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function cutDescription(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_DESCRIPTION) return s;
  const cut = s.slice(0, MAX_DESCRIPTION - 1);
  return cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:-]+$/, '') + '…';
}

/**
 * Classify one raw product name.
 * @returns {Promise<object>} sku, unspsc, unspsc_title, confidence, uom_braintree, uom_paypal,
 *   description, reason  (+ diagnostics: flags, shortlist, usage, model)
 */
async function classify(rawName, opts = {}) {
  const model = opts.model || process.env.LLM_MODEL;
  const { byCode } = loadIndex();
  const flags = [];
  const rawOnly = shortlist(rawName);
  let normalized = null;
  let normUsage = {};
  let normError = null;
  if (opts.normalize !== false) {
    try {
      const n = await normalizeName(rawName, opts);
      normalized = n.phrase || null;
      normUsage = n.usage;
    } catch (e) { flags.push('normalize_failed'); normError = String(e.message).slice(0, 300); }
  }
  const candidates = normalized ? shortlist([rawName, normalized]) : rawOnly;
  const list = candidates.map((c, i) => `${i + 1}. ${c.code} | ${c.title} | class: ${c.classTitle}`).join('\n') || '(no candidates matched)';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Product name: ${JSON.stringify(rawName)}\n\nShortlist:\n${list}` },
  ];

  let { text, usage } = await callLLM({ model, messages, signal: opts.signal });
  let raw;
  let rawText = null;
  try { raw = parseJson(text); } catch (e) {
    // Most often a reply cut off at the token limit: retry once with a much larger limit.
    flags.push('retried_after_bad_json');
    const again = await callLLM({ model, messages, signal: opts.signal, maxTokens: 2000 });
    usage = { ...usage, prompt_tokens: (usage.prompt_tokens ?? 0) + (again.usage.prompt_tokens ?? 0), completion_tokens: (usage.completion_tokens ?? 0) + (again.usage.completion_tokens ?? 0), cost: typeof usage.cost === 'number' && typeof again.usage.cost === 'number' ? usage.cost + again.usage.cost : undefined };
    text = again.text;
    try { raw = parseJson(text); } catch (e2) { raw = {}; flags.push('unparseable_json'); rawText = String(text).slice(0, 500); }
  }

  // Code: must exist in the subset.
  let code = raw.unspsc == null || raw.unspsc === 'null' ? null : String(raw.unspsc).trim();
  let confidence = clamp01(raw.confidence);
  let reason = raw.reason ? String(raw.reason).slice(0, 300) : null;
  if (code && !byCode.has(code)) {
    flags.push('rejected_code_not_in_list');
    reason = `REJECTED code ${code} (not in code list). ${reason || ''}`.trim();
    code = null;
    confidence = 0;
  }
  if (code && !candidates.some((c) => c.code === code)) flags.push('off_shortlist');
  if (!code && confidence > 0.3) confidence = 0.3;

  // Runner-up: second-best shortlist code. Must exist in the subset and differ from the chosen code.
  let runnerUp = null;
  const ru = raw.runner_up;
  if (ru && ru.unspsc != null) {
    const rc = String(ru.unspsc).trim();
    if (byCode.has(rc) && rc !== code) runnerUp = { unspsc: rc, unspsc_title: byCode.get(rc).title, confidence: clamp01(ru.confidence) };
  }
  const lookAlike = isLookAlike(code, confidence, runnerUp);
  const reviewReasons = [];
  if (!code) reviewReasons.push('no_code');
  else if (confidence < FLAG_THRESHOLD) reviewReasons.push('low_confidence');
  if (lookAlike) reviewReasons.push('look_alike');

  // Units: validate as returned, then repair so downstream never sees an invalid unit.
  let bt = String(raw.uom_braintree || '').trim().toUpperCase();
  let pp = String(raw.uom_paypal || '').trim().toUpperCase();
  const btValid = BRAINTREE_UOM.includes(bt);
  const ppValid = PAYPAL_UOM.includes(pp);
  if (!btValid) { bt = 'EA'; flags.push('uom_braintree_repaired'); }
  if (!ppValid) { pp = BT_TO_PP[bt]; flags.push('uom_paypal_repaired'); }

  // Description: specific, < 127 chars.
  let description = String(raw.description || '').replace(/\s+/g, ' ').trim();
  if (!description || GENERIC_DESCRIPTIONS.test(description)) { description = cutDescription(rawName); flags.push('description_fallback'); }
  if (description.length > MAX_DESCRIPTION) { description = cutDescription(description); flags.push('description_truncated'); }

  const entry = code ? byCode.get(code) : null;
  return {
    sku: opts.sku ?? null,
    raw_name: rawName,
    unspsc: code,
    unspsc_title: entry ? entry.title : null,
    confidence,
    uom_braintree: bt,
    uom_paypal: pp,
    description,
    reason,
    runner_up: runnerUp,
    look_alike: lookAlike,
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    flagged: reviewReasons.length > 0, // same as needs_review (kept for older callers)
    diagnostics: {
      model,
      flags,
      normalized,
      normalize_error: normError,
      raw_completion_on_parse_failure: rawText,
      shortlist_raw_only: rawOnly.map((c) => c.code), // before the normalisation step
      shortlist: candidates.map((c) => c.code), // after (raw + rewritten text)
      // usage covers both calls (normalise + classify)
      usage: {
        prompt_tokens: (usage.prompt_tokens ?? 0) + (normUsage.prompt_tokens ?? 0),
        completion_tokens: (usage.completion_tokens ?? 0) + (normUsage.completion_tokens ?? 0),
        cost_usd: typeof usage.cost === 'number' && (typeof normUsage.cost === 'number' || flags.includes('normalize_failed') || opts.normalize === false)
          ? usage.cost + (normUsage.cost ?? 0) : null,
      },
      uom_valid_as_returned: { braintree: btValid, paypal: ppValid },
    },
  };
}

module.exports = { classify, normalizeName, shortlist, loadIndex, isLookAlike, codeListKind, BRAINTREE_UOM, PAYPAL_UOM, BT_TO_PP, FLAG_THRESHOLD, LOOKALIKE_GAP, CLASSIFIER_VERSION };

if (require.main === module) {
  const name = process.argv.slice(2).join(' ');
  if (!name) { console.error('usage: node src/classify.js "<raw product name>"'); process.exit(2); }
  classify(name).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    const u = r.diagnostics.usage;
    console.error(`[cost] ${r.diagnostics.model} in=${u.prompt_tokens} out=${u.completion_tokens} $${u.cost_usd ?? 'n/a'}`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
