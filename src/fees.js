// Fee ESTIMATE: standard vs Visa Commercial Product 3 interchange on one order, from data/rates.json.
// Every figure is an ESTIMATE for interchange-plus merchants. It is not a claim of savings achieved.

const fs = require('node:fs');
const path = require('node:path');

const RATES_PATH = path.join(__dirname, '..', 'data', 'rates.json');

function loadRates(file = RATES_PATH) {
  const rates = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateRates(rates);
  return rates;
}

// A rate table is only usable if every rate points at a source that has a URL and a date.
function validateRates(r) {
  const sources = new Map(r.sources.map((s) => [s.id, s]));
  for (const s of r.sources) {
    if (!/^https:\/\//.test(s.url || '')) throw new Error(`rates.json: source ${s.id} has no https URL`);
    if (!(s.document_date || s.published || s.effective)) throw new Error(`rates.json: source ${s.id} has no date`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.accessed || '')) throw new Error(`rates.json: source ${s.id} has no access date`);
  }
  for (const x of r.rates) {
    if (!sources.has(x.source)) throw new Error(`rates.json: rate ${x.id} cites unknown source ${x.source}`);
    if (!(x.percent > 0 && x.percent < 10) || !(x.fixed_usd >= 0)) throw new Error(`rates.json: rate ${x.id} has implausible numbers`);
  }
  const ids = new Set(r.rates.map((x) => x.id));
  for (const s of r.scenarios) if (!ids.has(s.standard) || !ids.has(s.product3)) throw new Error(`rates.json: scenario ${s.id} references an unknown rate`);
}

const cents = (usd) => Math.round(Number(usd) * 100);
const feeCents = (amountCents, rate) => Math.round((amountCents * rate.percent) / 100) + Math.round(rate.fixed_usd * 100);
const usd = (c) => (c / 100).toFixed(2);

/** @param {number|string} amountUsd order total, e.g. "958.05" */
function estimateFeeDifference(amountUsd, rates = loadRates()) {
  const amountC = cents(amountUsd);
  const byId = Object.fromEntries(rates.rates.map((x) => [x.id, x]));
  const scenarios = rates.scenarios.map((s) => {
    const std = feeCents(amountC, byId[s.standard]);
    const p3 = feeCents(amountC, byId[s.product3]);
    return {
      id: s.id, label: s.label, edge: s.edge,
      standard: { rate: `${byId[s.standard].percent.toFixed(2)}% + $${byId[s.standard].fixed_usd.toFixed(2)}`, fee: usd(std), program: byId[s.standard].fee_program },
      product3: { rate: `${byId[s.product3].percent.toFixed(2)}% + $${byId[s.product3].fixed_usd.toFixed(2)}`, fee: usd(p3), program: byId[s.product3].fee_program },
      difference: usd(std - p3),
      differenceCents: std - p3,
    };
  });
  const diffs = scenarios.map((s) => s.differenceCents);
  const low = Math.min(...diffs); const high = Math.max(...diffs);
  const reference = scenarios.find((s) => s.edge === 'reference') || scenarios[0];
  return {
    label: 'ESTIMATE',
    amount: usd(amountC),
    range: { low: usd(low), high: usd(high) },
    isRange: low !== high,
    reference: { scenario: reference.id, difference: reference.difference },
    scenarios,
    source: rates.sources.find((s) => s.kind === 'primary'),
    sources: rates.sources,
    conflicts: rates.conflicts,
    excluded: rates.excluded,
    scope: rates.scope,
    retrievedOn: rates.retrieved_on,
  };
}

module.exports = { loadRates, validateRates, estimateFeeDifference, RATES_PATH };
