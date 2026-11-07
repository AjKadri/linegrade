// Validator for Level 2/3 card data. Pure functions, no I/O.
//
//   validateRequest(request)      a Braintree-style sale request (from enrichSale or a Level 1 payload)
//   validateCatalogRow(row)       one enriched-catalog row (code, units per processor, description)
//
// Each returns { valid, score, passed, total, checks[], issues[] }. A check is { id, label, status, detail }
// with status "pass" | "fail" | "n/a". The score is the share of applicable checks that pass, so it
// measures whether the data is COMPLETE and VALID. It does not say whether a code is the RIGHT code.
//
// Rules covered: totals reconcile to the cent; generic/placeholder descriptions ("ITEM1", "Misc");
// valid units of measure per processor (Braintree short codes, PayPal tested values); field lengths.

const { BRAINTREE_UOM, PAYPAL_UOM, BT_TO_PP } = require('./classify');

const LIMITS = { name: 35, description: 127, productCode: 12, commodityCode: 12, unitOfMeasure: 12, purchaseOrderNumber: 17, orderId: 255 };
const MIN_DESCRIPTION = 12;

// Placeholder words and patterns Visa rejects or downgrades (EVIDENCE.md: "ITEM1" for every description).
const PLACEHOLDER_WORDS = ['item', 'items', 'product', 'products', 'misc', 'miscellaneous', 'supplies', 'supply', 'goods', 'general', 'other', 'stuff', 'thing', 'things', 'n/a', 'na', 'none', 'unknown', 'tbd', 'test', 'sample', 'placeholder', 'description', 'desc', 'service', 'services', 'material', 'materials', 'line', 'sku', 'merchandise', 'various', 'assorted'];
const PLACEHOLDER_RE = new RegExp(`^(?:${PLACEHOLDER_WORDS.map((w) => w.replace('/', '\\/')).join('|')})(?:\\s*[-_#:.]?\\s*\\d*)?$`, 'i');

const isMoney = (s) => /^\d+\.\d{2}$/.test(String(s ?? ''));
const cents = (s) => Math.round(Number(s) * 100);

/** Why a description is not acceptable, or null if it is specific enough. */
function descriptionProblem(text, { productCode } = {}) {
  const d = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!d) return 'is empty';
  if (PLACEHOLDER_RE.test(d)) return `is a placeholder ("${d}")`;
  if (/^[\d\s\-_.#]+$/.test(d)) return 'has no words';
  if (/lorem ipsum/i.test(d)) return 'is filler text';
  if (productCode && d.toLowerCase() === String(productCode).toLowerCase()) return 'repeats the product code';
  if (d.length < MIN_DESCRIPTION || d.split(' ').length < 2) return `is too short to be specific (${d.length} characters)`;
  if (d.length > LIMITS.description) return `is longer than ${LIMITS.description} characters`;
  return null;
}

function summarize(checks) {
  const issues = checks.flatMap((c) => (c.status === 'fail' ? (c.issues || [c.detail]).map((m) => ({ check: c.id, message: m })) : []));
  const applicable = checks.filter((c) => c.status !== 'n/a');
  const passed = applicable.filter((c) => c.status === 'pass').length;
  return { valid: issues.length === 0, score: applicable.length ? Math.round((100 * passed) / applicable.length) : 0, passed, total: applicable.length, checks, issues };
}

const mk = (id, label, problems, { na = false, okDetail = 'ok' } = {}) => ({
  id, label, status: na ? 'n/a' : problems.length ? 'fail' : 'pass', detail: na ? 'not applicable' : problems.length ? problems.join('; ') : okDetail, issues: problems,
});

function validateRequest(req) {
  const lines = Array.isArray(req.lineItems) ? req.lineItems : [];
  const hasLines = lines.length > 0;
  const checks = [];

  // Level 2
  checks.push(mk('po_number', 'PO number present (Level 2)', !req.purchaseOrderNumber ? ['no PO number sent'] : String(req.purchaseOrderNumber).length > LIMITS.purchaseOrderNumber ? [`PO number longer than ${LIMITS.purchaseOrderNumber} characters`] : []));
  const taxProblems = [];
  if (!req.taxAmount) taxProblems.push('no tax amount sent');
  else if (!isMoney(req.taxAmount)) taxProblems.push(`tax amount "${req.taxAmount}" is not a dollar amount`);
  checks.push(mk('tax', 'Tax amount present (Level 2)', taxProblems));

  // Level 3, transaction level
  const addr = req.shipping || {};
  const shipProblems = [];
  if (!isMoney(req.shippingAmount)) shipProblems.push('no shipping amount sent');
  if (!/^\d{5}(-\d{4})?$/.test(String(req.shipsFromPostalCode || ''))) shipProblems.push('no valid ships-from ZIP');
  for (const k of ['streetAddress', 'locality', 'region', 'postalCode', 'countryCodeAlpha3']) if (!addr[k]) shipProblems.push(`ship-to ${k} missing`);
  checks.push(mk('shipping', 'Shipping amount, ships-from ZIP and ship-to address (Level 3)', shipProblems));

  // Line items
  checks.push(mk('line_items', 'Line items present (Level 3)', hasLines ? [] : ['no line items sent'], { okDetail: `${lines.length} line item(s)` }));

  const perLine = (fn, problemIfNone) => (hasLines ? lines.flatMap((li, i) => fn(li, `line ${i + 1} ${li.productCode || ''}`.trim())) : [problemIfNone]);
  checks.push(mk('commodity_codes', 'Commodity code on every line (8-digit UNSPSC)', perLine((li, w) => (/^\d{8}$/.test(String(li.commodityCode || '')) ? [] : [`${w}: commodity code "${li.commodityCode ?? ''}" is not 8 digits`]), 'no lines, so no commodity codes')));
  checks.push(mk('uom_braintree', 'Unit of measure valid for Braintree', perLine((li, w) => (BRAINTREE_UOM.includes(li.unitOfMeasure) ? [] : [`${w}: unit "${li.unitOfMeasure ?? ''}" is not one of ${BRAINTREE_UOM.join('/')}`]), 'no lines, so no units')));
  checks.push(mk('uom_paypal', 'Unit of measure maps to a tested PayPal value', perLine((li, w) => {
    const pp = BT_TO_PP[li.unitOfMeasure];
    return pp && PAYPAL_UOM.includes(pp) ? [] : [`${w}: unit "${li.unitOfMeasure ?? ''}" has no tested PayPal value (EA/BX-style codes make PayPal's sandbox return a 500)`];
  }, 'no lines, so no units')));

  // Descriptions
  const descProblems = hasLines ? lines.flatMap((li, i) => {
    const p = descriptionProblem(li.description, { productCode: li.productCode });
    return p ? [`line ${i + 1} ${li.productCode || ''}: description ${p}`] : [];
  }) : ['no lines, so no descriptions'];
  if (hasLines && lines.length > 1) {
    const seen = new Map();
    for (const li of lines) { const k = String(li.description || '').trim().toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [k, n] of seen) if (k && n > 1) descProblems.push(`the same description is used on ${n} lines ("${k}")`);
  }
  checks.push(mk('descriptions', 'Descriptions specific, not placeholders', descProblems));

  // Totals to the cent
  const totalsProblems = [];
  if (hasLines) {
    let sumLines = 0; let sumTax = 0;
    lines.forEach((li) => {
      const q = Number(li.quantity);
      if (!Number.isInteger(q) || q < 1) totalsProblems.push(`${li.productCode}: quantity "${li.quantity}" is not a whole number >= 1`);
      if (![li.unitAmount, li.totalAmount, li.unitTaxAmount, li.taxAmount].every(isMoney)) totalsProblems.push(`${li.productCode}: amounts must be dollars with 2 decimals`);
      else {
        if (cents(li.totalAmount) !== cents(li.unitAmount) * q) totalsProblems.push(`${li.productCode}: total ${li.totalAmount} != unit ${li.unitAmount} x ${q}`);
        if (cents(li.taxAmount) !== cents(li.unitTaxAmount) * q) totalsProblems.push(`${li.productCode}: tax ${li.taxAmount} != unit tax ${li.unitTaxAmount} x ${q}`);
        sumLines += cents(li.totalAmount); sumTax += cents(li.taxAmount);
      }
    });
    if (isMoney(req.taxAmount) && cents(req.taxAmount) !== sumTax) totalsProblems.push(`tax ${req.taxAmount} != sum of line tax ${(sumTax / 100).toFixed(2)}`);
    if (isMoney(req.amount) && isMoney(req.shippingAmount)) {
      const expected = sumLines + sumTax + cents(req.shippingAmount) - cents(req.discountAmount || '0.00');
      if (cents(req.amount) !== expected) totalsProblems.push(`amount ${req.amount} != items ${(sumLines / 100).toFixed(2)} + tax ${(sumTax / 100).toFixed(2)} + shipping ${req.shippingAmount} - discount ${req.discountAmount || '0.00'} = ${(expected / 100).toFixed(2)}`);
    }
  }
  checks.push(mk('totals', 'Totals reconcile to the cent', totalsProblems, { na: !hasLines, okDetail: 'lines + tax + shipping = amount' }));

  // Field lengths
  const lenProblems = [];
  if (hasLines) {
    lines.forEach((li) => {
      const w = li.productCode || '?';
      if (!String(li.name || '').trim()) lenProblems.push(`${w}: name is empty`);
      for (const k of ['name', 'description', 'productCode', 'commodityCode', 'unitOfMeasure']) if (String(li[k] ?? '').length > LIMITS[k]) lenProblems.push(`${w}: ${k} is longer than ${LIMITS[k]} characters`);
    });
    if (String(req.orderId || '').length > LIMITS.orderId) lenProblems.push(`orderId longer than ${LIMITS.orderId} characters`);
  }
  checks.push(mk('field_lengths', 'Field lengths within Braintree limits', lenProblems, { na: !hasLines }));

  return summarize(checks);
}

/** What a basic Level 1 checkout sends: the amount and an order id. Nothing else. */
function level1Payload(request) {
  return { amount: request.amount, orderId: request.orderId };
}

function validateCatalogRow(row) {
  const checks = [];
  checks.push(mk('code', 'Commodity code (8-digit UNSPSC)', /^\d{8}$/.test(String(row.unspsc || '')) ? [] : ['no commodity code']));
  checks.push(mk('uom_braintree', 'Unit valid for Braintree', BRAINTREE_UOM.includes(row.uom_braintree) ? [] : [`unit "${row.uom_braintree ?? ''}" missing or not accepted`]));
  const ppProblems = [];
  if (!PAYPAL_UOM.includes(row.uom_paypal)) ppProblems.push(`unit "${row.uom_paypal ?? ''}" missing or not a tested PayPal value`);
  else if (BRAINTREE_UOM.includes(row.uom_braintree) && BT_TO_PP[row.uom_braintree] !== row.uom_paypal && !['KILOGRAM', 'LITER', 'UNIT', 'ITM'].includes(row.uom_paypal)) ppProblems.push(`PayPal unit ${row.uom_paypal} does not match Braintree unit ${row.uom_braintree}`);
  checks.push(mk('uom_paypal', 'Unit valid for PayPal', ppProblems));
  const dp = descriptionProblem(row.description, { productCode: row.sku });
  checks.push(mk('description', 'Specific description', dp ? [`description ${dp}`] : []));
  return summarize(checks);
}

module.exports = { validateRequest, validateCatalogRow, level1Payload, descriptionProblem, LIMITS };
