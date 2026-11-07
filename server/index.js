// LineGrade API (Express). Wraps enrich-catalog, enrichSale, the ledger and Braintree (SANDBOX).
// All credentials (LLM key, Braintree keys, the test card) stay on this server.
//
//   node server/index.js        (PORT, default 8787; HOST, default 127.0.0.1)
//
// SYNTHETIC demo data only.

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may come from the shell */ }

const { enrichCatalog, approveSku, excludeSku, unapproveSku, DEFAULT_INPUT } = require('../src/enrich-catalog');
const { enrichSale, EnrichSaleError } = require('../src/enrich-sale');
const { level1Payload } = require('../src/validate');
const { chargeRequest } = require('../src/pay');
const { shortlist, BRAINTREE_UOM, FLAG_THRESHOLD, CLASSIFIER_VERSION } = require('../src/classify');
const ledger = require('../src/ledger');
const { orderReadiness, catalogReadiness } = require('../src/readiness');
const { estimateFeeDifference } = require('../src/fees');
const store = require('./store');

const SHIP_TO = { line1: '200 Science Park Rd', city: 'Madison', state: 'WI', postal: '53711', country3: 'USA' }; // synthetic
const SHIPS_FROM = '60607';
// The demo order (SYNTHETIC): 3 SKUs, about $958 with 8% tax and $25 shipping. The UI starts from it too.
const DEMO_ORDER = { items: [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }], poNumber: 'PO-77812', shipping: '25.00', taxRatePct: 8 };
const SAMPLE_SKUS = ['NLS-002', 'NLS-007', 'NLS-017', 'NLS-024']; // real classifier output, used by the landing preview
const SKU_RE = /^[A-Za-z0-9._-]{1,12}$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// In-memory rate limit (judging operations: cap AI re-runs and payments).
function limiter(name, max, windowMs) {
  const hits = [];
  return (req, res, next) => {
    const now = Date.now();
    while (hits.length && now - hits[0] > windowMs) hits.shift();
    if (hits.length >= max) return next(new HttpError(429, `Rate limit: at most ${max} ${name} per hour. Try again later.`));
    hits.push(now);
    return next();
  };
}

function prettyModel(m) {
  if (!m) return 'UNKNOWN';
  const tail = String(m).split('/').pop().replace(/^claude-/, '');
  return tail.replace(/-/g, ' ').toUpperCase();
}

function parseOrder(body) {
  const bad = (m) => { throw new HttpError(400, m); };
  if (!body || typeof body !== 'object') bad('JSON body required');
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > 10) bad('items: 1 to 10 lines required');
  const parsed = items.map((it) => {
    if (!it || typeof it.sku !== 'string' || !SKU_RE.test(it.sku)) bad('each item needs a valid sku');
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) bad(`item ${it.sku}: qty must be a whole number from 1 to 1000`);
    return { sku: it.sku, qty };
  });
  const poNumber = typeof body.poNumber === 'string' && body.poNumber.trim() ? body.poNumber.trim() : 'PO-77812';
  const shipping = body.shipping === undefined ? 25 : Number(body.shipping);
  if (!Number.isFinite(shipping) || shipping < 0 || shipping > 500) bad('shipping must be an amount from 0 to 500');
  const taxPct = body.taxRatePct === undefined ? 8 : Number(body.taxRatePct);
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 15) bad('taxRatePct must be from 0 to 15');
  return { poNumber, items: parsed, shipping: shipping.toFixed(2), taxRate: taxPct / 100, shipTo: SHIP_TO, shipsFromPostalCode: SHIPS_FROM };
}

// Compact view of a validator result for the UI.
function validationView(v) {
  return { valid: v.valid, score: v.score, passed: v.passed, total: v.total, checks: v.checks.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail })) };
}

function refusalPayload(e) {
  return { code: e.code, message: e.message, details: e.details || {} };
}

// ---------- app ----------

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, sandbox: true, synthetic: true }));

  app.get('/api/state', (req, res) => {
    const { meta, items, source } = store.read();
    res.json({
      synthetic: true, sandbox: true, source,
      model: meta.model, modelLabel: prettyModel(meta.model),
      flagThreshold: FLAG_THRESHOLD, classifierVersion: CLASSIFIER_VERSION,
      counts: store.counts(items), generatedAt: meta.generated_at,
      demoOrder: DEMO_ORDER,
      samples: SAMPLE_SKUS.map((k) => items.find((i) => i.sku === k)).filter((i) => i && i.unspsc).map((i) => ({ rawName: i.raw_name, code: i.unspsc, title: i.unspsc_title, uom: i.uom_braintree, description: i.description })),
    });
  });

  app.get('/api/catalog', (req, res) => {
    const { meta, items, source } = store.read();
    res.json({ source, meta: { synthetic: true, model: meta.model, modelLabel: prettyModel(meta.model), generated_at: meta.generated_at }, counts: store.counts(items), items });
  });

  app.post('/api/catalog/reset', (req, res) => { store.reset(); res.json({ ok: true, source: store.source() }); });

  // Re-run the AI (incremental: new/changed rows only; locked rows never touched; ?force=1 re-classifies all unlocked rows).
  let enriching = false;
  app.get('/api/enrich/stream', limiter('AI re-runs', 6, 3600_000), (req, res, next) => {
    if (enriching) return next(new HttpError(409, 'An AI run is already in progress'));
    enriching = true;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    store.ensureSession();
    enrichCatalog({ input: DEFAULT_INPUT, output: store.SESSION, force: req.query.force === '1', log: () => {}, onProgress: (ev) => send(ev.type, ev) })
      .then((out) => send('done', { counts: store.counts(Object.values(out.items)), last_run: out.meta.last_run, model: out.meta.model, modelLabel: prettyModel(out.meta.model) }))
      .catch((e) => send('error', { message: e.message }))
      .finally(() => { enriching = false; res.end(); });
  });

  // Review actions: write to the session copy, never to the frozen file.
  const review = (fn) => wrap((req, res) => {
    const { sku } = req.body || {};
    if (typeof sku !== 'string' || !SKU_RE.test(sku)) throw new HttpError(400, 'valid sku required');
    const out = store.ensureSession();
    let item;
    try { item = fn(sku, req.body || {}, out); } catch (e) { throw new HttpError(400, e.message); }
    res.json({ item, counts: store.counts(store.read().items) });
  });
  app.post('/api/review/approve', review((sku, b, out) => {
    const overrides = {};
    if (b.code !== undefined) { if (!/^\d{8}$/.test(String(b.code))) throw new Error('code must be 8 digits'); overrides.code = String(b.code); }
    if (b.uom !== undefined) { if (!BRAINTREE_UOM.includes(b.uom)) throw new Error(`uom must be one of ${BRAINTREE_UOM.join(', ')}`); overrides.uom = b.uom; }
    if (b.description !== undefined) { if (typeof b.description !== 'string' || !b.description.trim()) throw new Error('description must not be empty'); overrides.description = b.description.trim(); }
    return approveSku(sku, overrides, { output: out }).item;
  }));
  app.post('/api/review/exclude', review((sku, b, out) => excludeSku(sku, { output: out })));
  app.post('/api/review/unapprove', review((sku, b, out) => unapproveSku(sku, { output: out })));

  // Code search for the Edit panel (keyword shortlist over the UNSPSC subset).
  app.get('/api/codes', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ results: [] });
    res.json({ results: shortlist(q, 12).map((e) => ({ code: e.code, title: e.title, classTitle: e.classTitle })) });
  });

  // Order preview: exactly what Visa/Braintree would receive ("as Visa sees it"). No card, no API call.
  app.post('/api/order/preview', (req, res) => {
    const order = parseOrder(req.body);
    try {
      const request = enrichSale({ ...order, orderId: 'PREVIEW-ORDER' }, { catalogPath: store.activePath() });
      const itemsTotal = request.lineItems.reduce((s, l) => s + Math.round(Number(l.totalAmount) * 100), 0) / 100;
      const rd = orderReadiness(request);
      res.json({
        ok: true, request, totals: { items: itemsTotal.toFixed(2), tax: request.taxAmount, shipping: request.shippingAmount, total: request.amount },
        level1: level1Payload(request), validation: { before: validationView(rd.before), after: validationView(rd.after) },
      });
    } catch (e) {
      if (e instanceof EnrichSaleError) return res.json({ ok: false, refused: refusalPayload(e) });
      throw e;
    }
  });

  // Pay: enrichSale -> ledger -> Braintree SANDBOX sale -> read-back checks. The test card never leaves the server.
  app.post('/api/order/pay', limiter('payments', 20, 3600_000), wrap(async (req, res) => {
    const order = parseOrder(req.body);
    const orderId = typeof req.body.orderId === 'string' && ORDER_ID_RE.test(req.body.orderId)
      ? req.body.orderId : `LG-UI-${Date.now().toString(36).toUpperCase()}`;
    let request;
    try {
      request = enrichSale({ ...order, orderId }, { catalogPath: store.activePath() });
    } catch (e) {
      if (e instanceof EnrichSaleError) return res.json({ outcome: 'refused', orderId, refused: refusalPayload(e), messages: ['No Braintree call was made and the ledger was not touched.'] });
      throw e;
    }
    const messages = [];
    const result = await chargeRequest(request, { log: (l) => messages.push(l) });
    res.json({ ...result, request, messages, sandbox: true, validation: validationView(orderReadiness(request).after) });
  }));

  // Readiness: validator-based scores for the demo order (Level 1 before, Level 2/3 after) and the catalog,
  // plus the fee ESTIMATE for that order from data/rates.json.
  app.get('/api/readiness', (req, res) => {
    const { meta, items, source } = store.read();
    const orders = Object.entries(ledger.read()).filter(([, v]) => v.status === 'charged');
    let request = null; let refusal = null;
    try {
      request = enrichSale({ ...parseOrder(DEMO_ORDER), orderId: 'READINESS-DEMO' }, { catalogPath: store.activePath() });
    } catch (e) {
      if (!(e instanceof EnrichSaleError)) throw e;
      refusal = refusalPayload(e);
    }
    const rd = request ? orderReadiness(request) : null;
    res.json({
      synthetic: true, sandbox: true, source, counts: store.counts(items), modelLabel: prettyModel(meta.model),
      level3Orders: orders.length,
      lastOrder: orders.length ? { orderId: orders[orders.length - 1][0], transactionId: orders[orders.length - 1][1].transactionId, amount: orders[orders.length - 1][1].amount } : null,
      demoOrder: { ok: !!request, amount: request ? request.amount : null, refusal },
      order: rd ? { before: validationView(rd.before), after: validationView(rd.after) } : null,
      catalog: catalogReadiness(items),
      fee: estimateFeeDifference(request ? request.amount : '958.05'),
    });
  });

  // Built UI (npm run web:build), same origin as the API.
  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => (req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html'))));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message, ...(err.extra || {}) });
  });
  return app;
}

module.exports = { createApp, parseOrder };

if (require.main === module) {
  if (process.env.KEEP_SESSION !== '1') store.reset(); // every server start begins from the frozen demo catalog
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => console.log(`LineGrade API on http://${host}:${port}  (SYNTHETIC data, Braintree SANDBOX, catalog: ${store.source()})`));
}
