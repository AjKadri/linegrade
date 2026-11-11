// PayPal Orders v2, SANDBOX only: a second payment rail carrying the same Level 2/3 data as the Braintree rail.
//
//   buildPayPalOrder(request, catalog)  pure: the Braintree-shaped request from enrichSale() -> an Orders v2 body
//   chargePayPal(request, catalog, opts)  ledger -> create order -> (capture) -> GET order -> checks
//
// Credentials (PP_CLIENT_ID, PP_CLIENT_SECRET) come from the environment and never leave the server.
// Idempotency: PayPal-Request-Id on create and capture is derived from our orderId plus an attempt number kept in the
// ledger. A retry after "no answer" reuses the same attempt (PayPal replays the original result, so it cannot charge
// twice). A retry after a definite decline takes the next attempt number (a fresh try, not a replay of the decline).
//
// Outcomes use the same vocabulary as src/pay.js: charged | already_charged | declined | paypal_unavailable | blocked.

const path = require('node:path');
const crypto = require('node:crypto');
const ledger = require('./ledger');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from the shell */ }

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const TEST_CARD = { number: '4012888888881881', expiry: '2030-12', security_code: '123', name: 'Lab Ops Purchasing' }; // public PayPal sandbox test number
const TIMEOUT_MS = 20000;

// ---------- unit of measure ----------
// Values PayPal's sandbox accepted in our dependency tests. EA, BX, Each and box returned a 500 (reported to PayPal).
const PAYPAL_UOM_ALLOWED = ['KGM', 'LTR', 'ITM', 'ACR', 'EACH', 'BOX', 'PACK', 'CASE', 'POUND', 'KILOGRAM', 'LITER', 'UNIT'];
// Short (Braintree-style) codes -> the PayPal value.
const SHORT_TO_PAYPAL = { EA: 'EACH', BX: 'BOX', PK: 'PACK', CS: 'CASE', LB: 'POUND', KG: 'KGM', LTR: 'LTR' };

/** Map a catalog unit to a PayPal-safe value. Never returns a value off the allow-list. */
function mapUom(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { value: null, reason: 'no unit in the catalog' };
  const up = raw.toUpperCase();
  const mapped = SHORT_TO_PAYPAL[up] || up;
  if (PAYPAL_UOM_ALLOWED.includes(mapped)) return { value: mapped, changed: mapped !== raw };
  return { value: null, reason: `"${raw}" is not on the list of PayPal units that work` };
}

// ---------- configuration ----------
function railStatus() {
  const hasCreds = !!process.env.PP_CLIENT_ID && !!process.env.PP_CLIENT_SECRET;
  const flag = String(process.env.PAYPAL_RAIL || '').toLowerCase();
  if (['off', '0', 'false', 'no'].includes(flag)) return { enabled: false, reason: 'rail_off' };
  if (!hasCreds) return { enabled: false, reason: 'no_credentials' };
  return { enabled: true };
}
const apiBase = () => {
  const o = process.env.PAYPAL_API_BASE; // tests only: honoured with ALLOW_CHAOS=1, never in production
  return process.env.ALLOW_CHAOS === '1' && o ? o.replace(/\/$/, '') : SANDBOX_BASE;
};
// Test-only failure injection (ALLOW_CHAOS=1):  CHAOS_PAYPAL=down (unreachable) | 5xx (server error on create)
const chaos = () => (process.env.ALLOW_CHAOS === '1' ? process.env.CHAOS_PAYPAL || '' : '');

class PayPalError extends Error {
  constructor(message, { kind, status, debugId, body, code } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.kind = kind; // 'network' (nothing reached PayPal or no reply) | 'server' (5xx) | 'client' (4xx)
    this.status = status; this.debugId = debugId; this.body = body; this.code = code;
  }
}
const NEVER_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const neverSent = (e) => NEVER_SENT.has(e && (e.code || (e.cause && e.cause.code)));

// ---------- HTTP ----------
let tokenCache = { token: null, expiresAt: 0, base: null };
async function http(method, url, { headers = {}, body } = {}) {
  if (chaos() === 'down') throw new PayPalError('connect ECONNREFUSED (simulated: PayPal unavailable)', { kind: 'network', code: 'ECONNREFUSED' });
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new PayPalError(`no answer from PayPal (${e.name === 'TimeoutError' ? 'timeout' : (e.cause && e.cause.code) || e.message})`, { kind: 'network', code: (e.cause && e.cause.code) || e.code });
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  const debugId = res.headers.get('paypal-debug-id') || (json && json.debug_id) || null;
  if (res.status >= 500) throw new PayPalError(`PayPal answered HTTP ${res.status}`, { kind: 'server', status: res.status, debugId, body: json });
  return { status: res.status, json, debugId };
}

async function accessToken() {
  const base = apiBase();
  if (tokenCache.token && tokenCache.base === base && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const { PP_CLIENT_ID, PP_CLIENT_SECRET } = process.env;
  if (!PP_CLIENT_ID || !PP_CLIENT_SECRET) throw new PayPalError('Missing PP_CLIENT_ID / PP_CLIENT_SECRET', { kind: 'client', code: 'NO_CREDENTIALS' });
  const r = await http('POST', `${base}/v1/oauth2/token`, {
    headers: { Authorization: `Basic ${Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (r.status >= 300 || !r.json || !r.json.access_token) throw new PayPalError('PayPal sign-in failed (check the sandbox credentials)', { kind: 'client', status: r.status, debugId: r.debugId, code: 'AUTH' });
  tokenCache = { token: r.json.access_token, expiresAt: Date.now() + (Number(r.json.expires_in) || 300) * 1000, base };
  return tokenCache.token;
}

async function api(method, p, { body, requestId } = {}) {
  const token = await accessToken();
  if (method === 'POST' && p === '/v2/checkout/orders' && chaos() === '5xx') throw new PayPalError('PayPal answered HTTP 503 (simulated)', { kind: 'server', status: 503 });
  return http(method, `${apiBase()}${p}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Deterministic idempotency key: same orderId + attempt + step => same key. */
function requestId(orderId, attempt, step) {
  return `lg-${step}-${crypto.createHash('sha256').update(`${orderId}|${attempt}|${step}`).digest('hex').slice(0, 40)}`;
}

// ---------- payload ----------
const usd = (v) => ({ currency_code: 'USD', value: v });
const COUNTRY2 = { USA: 'US' };

/**
 * Build an Orders v2 body from the SAME enriched request that the Braintree rail sends.
 * @param {object} request  from enrichSale()
 * @param {{items: object}} catalog  enriched catalog (for uom_paypal)
 * @returns {{ body: object, uomNotes: {sku:string, sent:string|null, note:string|null}[] }}
 */
function buildPayPalOrder(request, catalog, card = TEST_CARD) {
  const ship = request.shipping || {};
  const country = COUNTRY2[ship.countryCodeAlpha3];
  if (!country) throw Object.assign(new Error(`Ship-to country "${ship.countryCodeAlpha3}" is not supported on the PayPal rail (US only in this demo)`), { code: 'UNSUPPORTED' });
  const shipAddr = { address_line_1: ship.streetAddress, admin_area_2: ship.locality, admin_area_1: ship.region, postal_code: ship.postalCode, country_code: country };
  const lines = request.lineItems;
  const itemTotalC = lines.reduce((s, l) => s + Math.round(Number(l.totalAmount) * 100), 0);
  const uomNotes = [];
  const l3 = lines.map((l) => {
    const row = (catalog && catalog.items && catalog.items[l.productCode]) || {};
    const u = mapUom(row.uom_paypal);
    uomNotes.push({ sku: l.productCode, sent: u.value, catalog: row.uom_paypal ?? null, note: u.value ? (u.changed ? `mapped ${row.uom_paypal} -> ${u.value}` : null) : `unit_of_measure omitted: ${u.reason}` });
    const line = {
      name: l.name, description: l.description, quantity: l.quantity,
      unit_amount: usd(l.unitAmount), tax: usd(l.unitTaxAmount),
      commodity_code: l.commodityCode,
      discount_amount: usd('0.00'), total_amount: usd(l.totalAmount),
    };
    if (u.value) line.unit_of_measure = u.value; // never send a value we know returns a 500
    return line;
  });
  const body = {
    intent: 'CAPTURE',
    payment_source: { card: { ...card, billing_address: shipAddr } },
    purchase_units: [{
      reference_id: request.purchaseOrderNumber,
      invoice_id: request.orderId,
      amount: {
        currency_code: 'USD', value: request.amount,
        breakdown: { item_total: usd((itemTotalC / 100).toFixed(2)), tax_total: usd(request.taxAmount), shipping: usd(request.shippingAmount), discount: usd(request.discountAmount || '0.00') },
      },
      items: lines.map((l) => ({ name: l.name, description: l.description, sku: l.productCode, quantity: l.quantity, unit_amount: usd(l.unitAmount), tax: usd(l.unitTaxAmount), category: 'PHYSICAL_GOODS' })),
      shipping: { name: { full_name: 'Receiving Dock' }, address: shipAddr },
      supplementary_data: {
        card: {
          level_2: { invoice_id: request.orderId, tax_total: usd(request.taxAmount) },
          level_3: {
            ships_from_postal_code: request.shipsFromPostalCode,
            shipping_amount: usd(request.shippingAmount),
            duty_amount: usd('0.00'),
            discount_amount: usd(request.discountAmount || '0.00'),
            shipping_address: shipAddr,
            line_items: l3,
          },
        },
      },
    }],
  };
  return { body, uomNotes };
}

/** PayPal-rail validation (runs only on this rail): everything buildPayPalOrder needs, as readable problems. */
function validatePayPalRail(request, catalog) {
  const problems = [];
  const ship = request.shipping || {};
  if (!COUNTRY2[ship.countryCodeAlpha3]) problems.push(`ship-to country "${ship.countryCodeAlpha3 ?? ''}" is not supported (US only)`);
  if (!request.lineItems || !request.lineItems.length) problems.push('PayPal Level 3 needs at least one line item');
  for (const l of request.lineItems || []) {
    const row = (catalog && catalog.items && catalog.items[l.productCode]) || {};
    const u = mapUom(row.uom_paypal);
    if (!u.value) problems.push(`${l.productCode}: unit "${row.uom_paypal ?? ''}" is not a PayPal-safe unit (${u.reason}); the unit would be left out`);
    if (String(l.name || '').length > 127 || String(l.description || '').length > 127) problems.push(`${l.productCode}: name/description longer than 127 characters`);
  }
  return { id: 'paypal_rail', label: 'PayPal rail: units and fields accepted by Orders v2', status: problems.length ? 'fail' : 'pass', detail: problems.length ? problems.join('; ') : 'ok', issues: problems };
}

// ---------- read-back ----------
const money = (o) => (o && o.value !== undefined ? String(o.value) : undefined);
function keyPaths(obj, prefix = '', out = []) {
  if (Array.isArray(obj)) { if (obj.length) keyPaths(obj[0], `${prefix}[]`, out); else out.push(`${prefix}[]`); return out; }
  if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) keyPaths(v, prefix ? `${prefix}.${k}` : k, out); return out; }
  out.push(prefix); return out;
}

/** Compare the GET order response with what we sent. Only fields PayPal returns are checked; Level 3 is reported as returned or not. */
function readBackChecks(sent, got) {
  const checks = [];
  const add = (check, expected, actual, pass) => checks.push({ check, expected, actual: actual === undefined ? 'not returned' : actual, pass: !!pass });
  const pu = (got.purchase_units || [])[0] || {};
  const cap = ((pu.payments || {}).captures || [])[0] || {};
  const spu = sent.purchase_units[0];
  add('Order status', 'COMPLETED', got.status, got.status === 'COMPLETED');
  add('Capture status', 'COMPLETED', cap.status, cap.status === 'COMPLETED');
  add('Amount', spu.amount.value, money(pu.amount), money(pu.amount) === spu.amount.value);
  const bd = (pu.amount || {}).breakdown;
  if (bd) {
    add('Tax total', spu.amount.breakdown.tax_total.value, money(bd.tax_total), money(bd.tax_total) === spu.amount.breakdown.tax_total.value);
    add('Shipping', spu.amount.breakdown.shipping.value, money(bd.shipping), money(bd.shipping) === spu.amount.breakdown.shipping.value);
    add('Item total', spu.amount.breakdown.item_total.value, money(bd.item_total), money(bd.item_total) === spu.amount.breakdown.item_total.value);
  }
  if (pu.invoice_id !== undefined) add('Invoice id (Level 2)', spu.invoice_id, pu.invoice_id, pu.invoice_id === spu.invoice_id);
  if (pu.reference_id !== undefined) add('PO number (reference id)', spu.reference_id, pu.reference_id, pu.reference_id === spu.reference_id);
  const items = pu.items || [];
  if (items.length) {
    add('Order items returned', `${spu.items.length} of ${spu.items.length}`, `${items.length} of ${spu.items.length}`, items.length === spu.items.length);
    spu.items.forEach((w, k) => {
      const g = items.find((x) => x.sku === w.sku) || items[k] || {};
      const same = g.sku === w.sku && String(g.quantity) === w.quantity && money(g.unit_amount) === w.unit_amount.value && money(g.tax) === w.tax.value;
      add(`Item ${k + 1} ${w.sku}`, `x${w.quantity} unit ${w.unit_amount.value} tax ${w.tax.value}`, `x${g.quantity} unit ${money(g.unit_amount)} tax ${money(g.tax)}`, same);
    });
  }
  // Level 2 / Level 3: is it echoed on read-back at all? (Observed in the sandbox: yes, both. The code still handles "no".)
  const sd = pu.supplementary_data;
  const l2 = sd && sd.card && sd.card.level_2;
  if (l2) {
    add('Level 2 tax total', spu.supplementary_data.card.level_2.tax_total.value, money(l2.tax_total), money(l2.tax_total) === spu.supplementary_data.card.level_2.tax_total.value);
    if (l2.invoice_id !== undefined) add('Level 2 invoice id', spu.supplementary_data.card.level_2.invoice_id, l2.invoice_id, l2.invoice_id === spu.supplementary_data.card.level_2.invoice_id);
  }
  const l3 = sd && sd.card && sd.card.level_3;
  const wantL3 = spu.supplementary_data.card.level_3;
  const l3Lines = (l3 && l3.line_items) || [];
  const level3Echoed = l3Lines.length > 0;
  if (l3) {
    if (l3.ships_from_postal_code !== undefined) add('Level 3 ships-from ZIP', wantL3.ships_from_postal_code, l3.ships_from_postal_code, l3.ships_from_postal_code === wantL3.ships_from_postal_code);
    if (l3.shipping_amount) add('Level 3 shipping amount', wantL3.shipping_amount.value, money(l3.shipping_amount), money(l3.shipping_amount) === wantL3.shipping_amount.value);
    if (l3.shipping_address) add('Level 3 ship-to address', `${wantL3.shipping_address.address_line_1}, ${wantL3.shipping_address.postal_code}`, `${l3.shipping_address.address_line_1}, ${l3.shipping_address.postal_code}`, l3.shipping_address.address_line_1 === wantL3.shipping_address.address_line_1 && l3.shipping_address.postal_code === wantL3.shipping_address.postal_code);
  }
  if (level3Echoed) {
    const want = wantL3.line_items;
    add('Level 3 line items returned', `${want.length} of ${want.length}`, `${l3Lines.length} of ${want.length}`, l3Lines.length === want.length);
    want.forEach((w, k) => {
      const g = l3Lines.find((x) => x.commodity_code === w.commodity_code && x.name === w.name) || l3Lines[k] || {};
      const same = g.commodity_code === w.commodity_code && g.unit_of_measure === w.unit_of_measure && money(g.total_amount) === w.total_amount.value
        && String(g.quantity) === w.quantity && money(g.unit_amount) === w.unit_amount.value && money(g.tax) === w.tax.value && g.description === w.description && g.name === w.name;
      add(`Level 3 line ${k + 1}`, `${w.commodity_code} ${w.unit_of_measure ?? '(unit omitted)'} x${w.quantity} total ${w.total_amount.value}`, `${g.commodity_code} ${g.unit_of_measure ?? '(unit omitted)'} x${g.quantity} total ${money(g.total_amount)}`, same);
    });
  }
  return { checks, level3Echoed, level2Echoed: !!l2, fieldsReturned: keyPaths(got).sort() };
}

// ---------- charge ----------
const failedLike = (o) => o === 'declined' || o === 'paypal_unavailable';

/**
 * @param {object} request  from enrichSale()
 * @param {object} catalog  enriched catalog
 * @param {{ledgerFile?:string, log?:(l:string)=>void, card?:object}} [opts]
 */
async function chargePayPal(request, catalog, opts = {}) {
  const log = opts.log || (() => {});
  const ledgerFile = opts.ledgerFile || ledger.DEFAULT_LEDGER;
  const orderId = request.orderId;
  let entry = ledger.get(orderId, ledgerFile);

  if (entry && entry.status === 'charged') {
    log(`\nALREADY CHARGED: orderId ${orderId} was charged on ${entry.rail || 'braintree'} as ${entry.transactionId} (${entry.amount} USD, ${entry.updated_at}).`);
    log('No new payment was created.');
    return { outcome: 'already_charged', rail: entry.rail || 'braintree', orderId, transactionId: entry.transactionId, amount: entry.amount, at: entry.updated_at };
  }
  if (entry && entry.rail && entry.rail !== 'paypal' && ['pending', 'unknown'].includes(entry.status)) {
    return { outcome: 'blocked_other_rail', orderId, rail: entry.rail, message: `This order id has an unresolved attempt on ${entry.rail}. Resolve it there first (retry on ${entry.rail}), so the order cannot be charged twice.` };
  }

  // Attempt number: same attempt after "no answer" (idempotent replay), next attempt after a definite decline.
  let attempt = (entry && entry.rail === 'paypal' && entry.attempt) || 1;
  if (entry && entry.rail === 'paypal' && entry.status === 'failed' && entry.definitive) attempt += 1;

  const card = opts.card || TEST_CARD;
  let built;
  try { built = buildPayPalOrder(request, catalog, card); } catch (e) {
    return { outcome: 'declined', rail: 'paypal', orderId, message: e.message, details: [], notSent: true };
  }
  const { body, uomNotes } = built;
  ledger.set(orderId, { status: 'pending', rail: 'paypal', attempt, definitive: false, amount: request.amount, po: request.purchaseOrderNumber, started_at: new Date().toISOString() }, ledgerFile);
  for (const n of uomNotes) if (n.note) log(`      ${n.sku}: ${n.note}`);

  const unavailable = (e, certainNotCharged) => {
    ledger.set(orderId, certainNotCharged ? { status: 'failed', definitive: false, error: String(e.message), note: 'PayPal unreachable; request never sent' } : { status: 'unknown', error: String(e.message) }, ledgerFile);
    log(`\nNo usable answer from PayPal (${e.message}). ${certainNotCharged ? 'The request never left this machine: nothing was charged.' : 'The payment may or may not exist; a retry replays the same idempotency key and cannot charge twice.'}`);
    return { outcome: 'paypal_unavailable', rail: 'paypal', orderId, retrySafe: true, charged: certainNotCharged ? false : 'unknown', error: String(e.message), debugId: e.debugId };
  };
  const rejected = (stage, r) => {
    const issues = ((r.json && r.json.details) || []).map((d) => `${d.field || ''} [${d.issue || ''}] ${d.description || ''}`.trim());
    const msg = (r.json && (r.json.message || r.json.name)) || `HTTP ${r.status}`;
    ledger.set(orderId, { status: 'failed', definitive: true, error: `${stage}: ${msg}` }, ledgerFile);
    log(`PayPal refused the ${stage}: ${msg} (HTTP ${r.status}, debug_id ${r.debugId || 'n/a'})`);
    for (const l of issues) log(`  ${l}`);
    log('Nothing was charged. Ledger status: failed (retry with the same orderId is allowed).');
    return { outcome: 'declined', rail: 'paypal', orderId, message: `PayPal said: ${msg}`, details: issues, httpStatus: r.status, debugId: r.debugId };
  };

  let created;
  try { created = await api('POST', '/v2/checkout/orders', { body, requestId: requestId(orderId, attempt, 'create') }); } catch (e) {
    if (e instanceof PayPalError && e.kind === 'client') throw e; // credentials problem: a server error, not a payment outcome
    return unavailable(e, e instanceof PayPalError && e.kind === 'network' && (neverSent(e) || e.code === 'ECONNREFUSED'));
  }
  if (created.status >= 300) return rejected('order', created);
  let order = created.json;
  ledger.set(orderId, { paypalOrderId: order.id }, ledgerFile);

  const capturedAlready = (o) => (((o.purchase_units || [])[0] || {}).payments || {}).captures;
  if (!capturedAlready(order) && order.status !== 'COMPLETED') {
    let cap;
    try { cap = await api('POST', `/v2/checkout/orders/${order.id}/capture`, { body: {}, requestId: requestId(orderId, attempt, 'capture') }); } catch (e) {
      return unavailable(e, false);
    }
    if (cap.status >= 300) return rejected('capture', cap);
    order = cap.json;
  }
  const capture = (capturedAlready(order) || [])[0] || {};
  if (capture.status && capture.status !== 'COMPLETED') {
    ledger.set(orderId, { status: 'failed', definitive: true, error: `capture ${capture.status}` }, ledgerFile);
    log(`PayPal capture status is ${capture.status}: not charged.`);
    return { outcome: 'declined', rail: 'paypal', orderId, message: `PayPal capture status: ${capture.status}`, details: [], debugId: created.debugId };
  }
  ledger.set(orderId, { status: 'charged', transactionId: capture.id || order.id, paypalOrderId: order.id, amount: request.amount, rail: 'paypal' }, ledgerFile);
  log(`\nPayPal capture accepted: order ${order.id}, capture ${capture.id}, status ${capture.status || order.status}, amount ${request.amount} USD`);

  // Read-back: GET the order and compare what comes back with what we sent.
  let rb = null; let readBackError = null;
  try {
    const got = await api('GET', `/v2/checkout/orders/${order.id}`);
    if (got.status >= 300) readBackError = `HTTP ${got.status}`;
    else rb = { ...readBackChecks(body, got.json), card: (got.json.payment_source || {}).card || null };
  } catch (e) { readBackError = e.message; }
  const out = {
    outcome: 'charged', rail: 'paypal', orderId, transactionId: capture.id || order.id, paypalOrderId: order.id, status: capture.status || order.status, amount: request.amount,
    debugId: created.debugId, uomNotes, readBackError,
    checks: rb ? rb.checks : [], passed: rb ? rb.checks.every((c) => c.pass) : false,
    level3Echoed: rb ? rb.level3Echoed : false, level2Echoed: rb ? rb.level2Echoed : false, fieldsReturned: rb ? rb.fieldsReturned : [],
    transaction: { id: capture.id || order.id, status: capture.status || order.status, amount: request.amount, commercial: null, cardLast4: rb && rb.card ? rb.card.last_digits : undefined },
  };
  return out;
}

module.exports = {
  chargePayPal, buildPayPalOrder, validatePayPalRail, mapUom, railStatus, readBackChecks, requestId, accessToken,
  PAYPAL_UOM_ALLOWED, SHORT_TO_PAYPAL, TEST_CARD, PayPalError, failedLike,
};
