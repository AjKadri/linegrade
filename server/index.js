// LineGrade API (Express). Wraps enrich-catalog, enrichSale, the ledger and Braintree (SANDBOX).
// All credentials (LLM key, Braintree keys, the test card) stay on this server, set in the environment only.
//
//   node server/index.js        (PORT, default 8787; HOST, default 127.0.0.1, or 0.0.0.0 in production)
//
// Several browsers at once: every browser gets its own session (cookie) with its own catalog copy, approvals,
// ledger entries, order counter and caps. Idle sessions expire after SESSION_IDLE_MIN (default 120).
// SYNTHETIC demo data only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may come from the shell or the host (Render) */ }

const { enrichCatalog, approveSku, excludeSku, unapproveSku, ProviderUnavailableError, DEFAULT_INPUT } = require('../src/enrich-catalog');
const { enrichSale, loadCatalog, EnrichSaleError } = require('../src/enrich-sale');
const { level1Payload } = require('../src/validate');
const { chargeRequest } = require('../src/pay');
const paypal = require('../src/paypal');
const { shortlist, BRAINTREE_UOM, FLAG_THRESHOLD, CLASSIFIER_VERSION, codeListKind } = require('../src/classify');
const ledger = require('../src/ledger');
const { orderReadiness, catalogReadiness } = require('../src/readiness');
const { estimateFeeDifference } = require('../src/fees');
const store = require('./store');
const { config } = require('./config');
const { Usage } = require('./usage');
const { SessionManager } = require('./sessions');
const { rateLimiter } = require('./ratelimit');

const SHIP_TO = { line1: '200 Science Park Rd', city: 'Madison', state: 'WI', postal: '53711', country3: 'USA' }; // synthetic
const SHIPS_FROM = '60607';
// The demo order (SYNTHETIC): 3 SKUs, about $958 with 8% tax and $25 shipping. The UI starts from it too.
const DEMO_ORDER = { items: [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }], poNumber: 'PO-77812', shipping: '25.00', taxRatePct: 8 };
const SAMPLE_SKUS = ['NLS-002', 'NLS-007', 'NLS-017', 'NLS-024']; // real classifier output, used by the landing preview
const SKU_RE = /^[A-Za-z0-9._-]{1,12}$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const START = Date.now();

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cap = (code, message, extra = {}) => new HttpError(429, message, { code: 'CAP_REACHED', cap: code, ...extra });

function prettyModel(m) {
  if (!m) return 'UNKNOWN';
  const tail = String(m).split('/').pop().replace(/^claude-/, '');
  return tail.replace(/-/g, ' ').toUpperCase();
}

// Input validation with messages a person can act on (shown next to the field in the UI).
function parseOrder(body) {
  const bad = (m, field) => { throw new HttpError(400, m, { code: 'INVALID_INPUT', field }); };
  if (!body || typeof body !== 'object') bad('The request needs a JSON body.');
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) bad('Add at least one line to the order.', 'items');
  if (items.length > 10) bad('An order can have at most 10 lines.', 'items');
  const seen = new Set();
  const parsed = items.map((it, i) => {
    const where = `Line ${i + 1}`;
    if (!it || typeof it.sku !== 'string' || !it.sku.trim()) return bad(`${where}: choose a SKU.`, `items.${i}.sku`);
    if (!SKU_RE.test(it.sku)) return bad(`${where}: "${String(it.sku).slice(0, 20)}" is not a valid SKU.`, `items.${i}.sku`);
    if (seen.has(it.sku)) return bad(`${where}: ${it.sku} appears twice. Combine the quantities.`, `items.${i}.sku`);
    seen.add(it.sku);
    const qty = Number(it.qty);
    if (it.qty === '' || it.qty === null || it.qty === undefined || !Number.isFinite(qty)) return bad(`${where} (${it.sku}): enter a quantity.`, `items.${i}.qty`);
    if (!Number.isInteger(qty)) return bad(`${where} (${it.sku}): quantity must be a whole number.`, `items.${i}.qty`);
    if (qty < 1 || qty > 1000) return bad(`${where} (${it.sku}): quantity must be from 1 to 1000.`, `items.${i}.qty`);
    return { sku: it.sku, qty };
  });
  const poNumber = typeof body.poNumber === 'string' && body.poNumber.trim() ? body.poNumber.trim() : 'PO-77812';
  if (poNumber.length > 17) bad('PO number can be at most 17 characters (Braintree limit).', 'poNumber');
  const shipping = body.shipping === undefined ? 25 : Number(body.shipping);
  if (!Number.isFinite(shipping) || shipping < 0 || shipping > 500) bad('Shipping must be an amount from 0 to 500.', 'shipping');
  const taxPct = body.taxRatePct === undefined ? 8 : Number(body.taxRatePct);
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 15) bad('Tax rate must be from 0 to 15 percent.', 'taxRatePct');
  return { poNumber, items: parsed, shipping: shipping.toFixed(2), taxRate: taxPct / 100, shipTo: SHIP_TO, shipsFromPostalCode: SHIPS_FROM };
}

// Compact view of a validator result for the UI.
function validationView(v) {
  return { valid: v.valid, score: v.score, passed: v.passed, total: v.total, checks: v.checks.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail })) };
}

// Which payment rail the browser asked for. PayPal exists only when its credentials are set and the rail is not switched off.
function parseRail(body) {
  const rail = body && body.rail !== undefined ? String(body.rail) : 'braintree';
  if (rail === 'braintree') return 'braintree';
  if (rail !== 'paypal') throw new HttpError(400, 'Choose Braintree or PayPal.', { code: 'INVALID_INPUT', field: 'rail' });
  if (!paypal.railStatus().enabled) throw new HttpError(400, 'The PayPal rail is not available on this server.', { code: 'RAIL_UNAVAILABLE', field: 'rail' });
  return 'paypal';
}

// The validator view plus one check that exists only on the PayPal rail (units and fields Orders v2 accepts).
function withRailCheck(view, check) {
  const applicable = view.total + 1; const passed = view.passed + (check.status === 'pass' ? 1 : 0);
  return { ...view, valid: view.valid && check.status === 'pass', passed, total: applicable, score: Math.round((100 * passed) / applicable), checks: [...view.checks, { id: check.id, label: check.label, status: check.status, detail: check.detail }] };
}

function refusalPayload(e) {
  return { code: e.code, message: e.message, details: e.details || {} };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- app ----------

/**
 * @param {{sessions?: SessionManager, usage?: Usage}} [opts]  injected in tests
 */
function createApp(opts = {}) {
  const cfg0 = config();
  const sessions = opts.sessions || new SessionManager({ dir: path.join(ROOT, 'data', 'sessions'), idleMs: cfg0.sessionIdleMs, maxSessions: cfg0.maxSessions });
  const usage = opts.usage || new Usage(path.join(ROOT, 'data', 'usage.json'));
  const runtime = { liveAiOverride: null, enriching: false };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us: needed for req.secure and the client IP

  // Basic security headers. The UI is same-origin only, so the policy can be strict.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });

  // Health check for the host (Render). No session, no rate limit, no secrets.
  app.get(['/health', '/api/health'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', codeList: codeListKind(), paypalRail: paypal.railStatus().enabled ? 'on' : 'off', uptimeSeconds: Math.round((Date.now() - START) / 1000), sandbox: true, synthetic: true, sessions: sessions.count(), commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || undefined });
  });

  app.use(express.json({ limit: '50kb' }));

  // ----- limits and caps -----
  const liveAiStatus = () => {
    const c = config();
    if (codeListKind() === 'none') return { enabled: false, reason: 'no_code_list', message: 'Live AI runs locally with the licensed UNSPSC list; this demo replays a saved run.' };
    if (runtime.liveAiOverride === false || !c.liveAiFlag) return { enabled: false, reason: 'live_ai_off', message: 'Live AI is switched off on this demo. The frozen-catalog replay still works.' };
    if (runtime.liveAiOverride !== true && !c.hasLlmKey) return { enabled: false, reason: 'not_configured', message: 'Live AI is not configured on this server. The frozen-catalog replay still works.' };
    return { enabled: true };
  };
  const limitsFor = (session) => {
    const c = config(); const u = usage.snapshot();
    return {
      liveAi: liveAiStatus(),
      rerunsLeft: Math.max(0, c.maxRerunsSession - session.reruns), rerunsMax: c.maxRerunsSession,
      paymentsLeft: Math.max(0, c.maxPaymentsSession - session.payments), paymentsMax: c.maxPaymentsSession,
      dailyBudgetExhausted: u.spend_usd >= c.dailyCapUsd,
      codeList: codeListKind(),
      rails: { braintree: true, paypal: paypal.railStatus().enabled },
    };
  };
  const checkRerun = (session) => {
    const c = config(); const u = usage.snapshot(); const live = liveAiStatus();
    if (!live.enabled) return cap(live.reason, live.message);
    if (session.reruns >= c.maxRerunsSession) return cap('session_reruns', `You have used your ${c.maxRerunsSession} live AI re-runs for this session. The frozen-catalog replay still works.`);
    if (u.reruns >= c.maxRerunsDay) return cap('global_reruns', `The demo has reached today's limit of ${c.maxRerunsDay} live AI re-runs. The frozen-catalog replay still works.`);
    if (u.spend_usd >= c.dailyCapUsd) return cap('daily_spend', `Today's AI budget ($${c.dailyCapUsd.toFixed(2)}) has been used up. The frozen-catalog replay still works.`);
    return null;
  };

  // ----- API: rate limits, then session -----
  // Order matters: the per-address limit runs before a session is created, so one client cannot mint sessions in bulk.
  const ipLimit = rateLimiter({ name: 'network address', max: () => config().ratePerIpPerMin, keyFn: (r) => r.ip });
  const sessionLimit = rateLimiter({ name: 'session', max: () => config().ratePerSessionPerMin, keyFn: (r) => r.session.id });
  const sessionMw = sessions.middleware();
  app.use('/api', (req, res, next) => (req.path === '/health' ? next() : ipLimit(req, res, next)));
  app.use('/api', (req, res, next) => (req.path === '/health' ? next() : sessionMw(req, res, next)));
  app.use('/api', (req, res, next) => (req.session ? sessionLimit(req, res, next) : next()));

  const stOf = (req) => store.forSession(req.session);

  app.get('/api/state', (req, res) => {
    const { meta, items, source } = stOf(req).read();
    res.json({
      synthetic: true, sandbox: true, source,
      model: meta.model, modelLabel: prettyModel(meta.model),
      flagThreshold: FLAG_THRESHOLD, classifierVersion: CLASSIFIER_VERSION,
      counts: store.counts(items), generatedAt: meta.generated_at,
      demoOrder: DEMO_ORDER, limits: limitsFor(req.session),
      session: { idleMinutes: Math.round(config().sessionIdleMs / 60000) },
      samples: SAMPLE_SKUS.map((k) => items.find((i) => i.sku === k)).filter((i) => i && i.unspsc).map((i) => ({ rawName: i.raw_name, code: i.unspsc, title: i.unspsc_title, uom: i.uom_braintree, description: i.description })),
    });
  });

  app.get('/api/catalog', (req, res) => {
    const { meta, items, source } = stOf(req).read();
    res.json({ source, meta: { synthetic: true, model: meta.model, modelLabel: prettyModel(meta.model), generated_at: meta.generated_at }, counts: store.counts(items), items });
  });

  app.post('/api/catalog/reset', (req, res) => { const st = stOf(req); st.reset(); res.json({ ok: true, source: st.source() }); });

  // Re-run the AI (incremental: new/changed rows only; locked rows never touched; ?force=1 re-classifies all unlocked rows).
  // Server-sent events. If the provider is unavailable the run is abandoned, nothing is written, and a "fallback"
  // event tells the UI to show the frozen-catalog replay instead.
  app.get('/api/enrich/stream', (req, res, next) => {
    const session = req.session;
    const blocked = checkRerun(session);
    if (blocked) return next(blocked);
    if (runtime.enriching) return next(new HttpError(409, 'Another live AI run is in progress. Try again in a minute, or use the frozen-catalog replay.', { code: 'BUSY' }));
    runtime.enriching = true;
    session.reruns += 1; usage.add({ reruns: 1 });
    const st = stOf(req);
    st.ensureSession();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const dailyCap = config().dailyCapUsd;
    enrichCatalog({
      input: DEFAULT_INPUT, output: st.catalogFile, force: req.query.force === '1', log: () => {},
      onProgress: (ev) => send(ev.type, ev),
      onProviderError: 'abort',
      onCost: (usd) => usage.add({ spend: usd }),
      shouldStop: () => clientGone || usage.snapshot().spend_usd >= dailyCap,
    })
      .then((out) => {
        send('done', { counts: store.counts(Object.values(out.items)), last_run: out.meta.last_run, model: out.meta.model, modelLabel: prettyModel(out.meta.model) });
        if (out.meta.last_run.stopped_early && usage.snapshot().spend_usd >= dailyCap) {
          send('capped', { code: 'CAP_REACHED', cap: 'daily_spend', message: `Today's AI budget ($${dailyCap.toFixed(2)}) ran out part-way. Rows not reached keep their earlier result. The frozen-catalog replay still works.` });
        }
      })
      .catch((e) => {
        if (e instanceof ProviderUnavailableError) {
          session.reruns = Math.max(0, session.reruns - 1); // a failed attempt does not use up the session's re-runs
          send('fallback', { code: 'AI_UNAVAILABLE', message: 'The AI provider is unavailable right now, so nothing was changed. Showing the frozen-catalog replay instead.', detail: String(e.message).slice(0, 200) });
        } else {
          console.error(e);
          send('error', { message: 'The AI run failed and nothing was changed.' });
        }
      })
      .finally(() => { runtime.enriching = false; res.end(); });
  });

  // Review actions: write to this session's copy, never to the frozen file.
  const review = (fn) => wrap((req, res) => {
    const { sku } = req.body || {};
    if (typeof sku !== 'string' || !SKU_RE.test(sku)) throw new HttpError(400, 'A valid SKU is required.', { code: 'INVALID_INPUT', field: 'sku' });
    const st = stOf(req);
    const out = st.ensureSession();
    let item;
    try { item = fn(sku, req.body || {}, out); } catch (e) { throw new HttpError(400, e.message, { code: 'INVALID_INPUT' }); }
    res.json({ item, counts: store.counts(st.read().items) });
  });
  app.post('/api/review/approve', review((sku, b, out) => {
    const overrides = {};
    if (b.code !== undefined) { if (!/^\d{8}$/.test(String(b.code))) throw new Error('Code must be 8 digits.'); overrides.code = String(b.code); }
    if (b.uom !== undefined) { if (!BRAINTREE_UOM.includes(b.uom)) throw new Error(`Unit must be one of ${BRAINTREE_UOM.join(', ')}.`); overrides.uom = b.uom; }
    if (b.description !== undefined) { if (typeof b.description !== 'string' || !b.description.trim()) throw new Error('Description must not be empty.'); overrides.description = b.description.trim(); }
    return approveSku(sku, overrides, { output: out }).item;
  }));
  app.post('/api/review/exclude', review((sku, b, out) => excludeSku(sku, { output: out })));
  app.post('/api/review/unapprove', review((sku, b, out) => unapproveSku(sku, { output: out })));

  // Code search for the Edit panel (keyword shortlist over the UNSPSC list in use).
  app.get('/api/codes', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const kind = codeListKind();
    const noListNote = 'Searching only the codes already used in this demo catalog. The full UNSPSC list is not installed here.';
    if (q.length < 2) return res.json({ results: [], codeList: kind, ...(kind === 'none' ? { note: noListNote } : {}) });
    if (kind === 'full') return res.json({ results: shortlist(q, 12).map((e) => ({ code: e.code, title: e.title, classTitle: e.classTitle })), codeList: kind });
    // No licensed list on this host: search only the codes already in this session's catalog.
    const needle = q.toLowerCase(); const seen = new Map();
    for (const it of Object.values(stOf(req).read().items)) {
      for (const [code, title] of [[it.unspsc, it.unspsc_title], [it.runner_up?.unspsc, it.runner_up?.unspsc_title]]) {
        if (code && title && !seen.has(code) && (code.startsWith(needle) || title.toLowerCase().includes(needle))) seen.set(code, { code, title, classTitle: '' });
      }
    }
    res.json({ results: [...seen.values()].slice(0, 12), codeList: kind, note: noListNote });
  });

  // Order preview: exactly what Visa/Braintree would receive ("as Visa sees it"). No card, no API call.
  app.post('/api/order/preview', (req, res) => {
    const order = parseOrder(req.body);
    const rail = parseRail(req.body);
    try {
      const request = enrichSale({ ...order, orderId: 'PREVIEW-ORDER' }, { catalogPath: stOf(req).activePath() });
      const itemsTotal = request.lineItems.reduce((s, l) => s + Math.round(Number(l.totalAmount) * 100), 0) / 100;
      const rd = orderReadiness(request);
      let before = validationView(rd.before); let after = validationView(rd.after); let ppInfo;
      if (rail === 'paypal') {
        const catalog = loadCatalog(stOf(req).activePath());
        const rc = paypal.validatePayPalRail(request, catalog);
        after = withRailCheck(after, rc); // before (Level 1) is unchanged: it sends no units at all
        ppInfo = { uomNotes: paypal.buildPayPalOrder(request, catalog).uomNotes, railCheck: { status: rc.status, detail: rc.detail } };
      }
      res.json({
        ok: true, rail, request, totals: { items: itemsTotal.toFixed(2), tax: request.taxAmount, shipping: request.shippingAmount, total: request.amount },
        level1: level1Payload(request), validation: { before, after }, ...(ppInfo ? { paypal: ppInfo } : {}),
      });
    } catch (e) {
      if (e instanceof EnrichSaleError) return res.json({ ok: false, refused: refusalPayload(e) });
      throw e;
    }
  });

  // Pay: enrichSale -> ledger -> Braintree SANDBOX sale -> read-back checks. The test card never leaves the server.
  // The order id is prefixed with the session id, so two browsers can never collide or see each other's orders.
  const COUNTED = new Set(['charged', 'declined', 'charged_reply_lost', 'no_answer_not_charged', 'unknown']);
  app.post('/api/order/pay', wrap(async (req, res) => {
    const session = req.session; const st = stOf(req);
    const order = parseOrder(req.body);
    const rail = parseRail(req.body);
    const railName = rail === 'paypal' ? 'PayPal' : 'Braintree';
    // level 1 = "Without LineGrade": a basic sale (amount + order id only). level 3 (default) = full Level 2/3 data.
    if (req.body.level !== undefined && ![1, 3].includes(Number(req.body.level))) throw new HttpError(400, 'Level must be 1 or 3.', { code: 'INVALID_INPUT', field: 'level' });
    const level1 = Number(req.body.level) === 1;
    const clientId = typeof req.body.orderId === 'string' && ORDER_ID_RE.test(req.body.orderId) ? req.body.orderId : `LG-UI-${Date.now().toString(36).toUpperCase()}`;
    const orderId = `${session.id.slice(0, 6)}-${clientId}${level1 ? '-L1' : ''}`; // a Level 1 sale is its own order id
    const existing = ledger.get(orderId, st.ledgerFile) || {};
    const already = existing.status === 'charged'; // on either rail
    if (!already) {
      const c = config(); const u = usage.snapshot();
      if (session.payments >= c.maxPaymentsSession) throw cap('session_payments', `You have used your ${c.maxPaymentsSession} sandbox payments for this session. Reset the demo or open a new browser session to continue.`);
      if (u.payments >= c.maxPaymentsDay) throw cap('global_payments', `The demo has reached today's limit of ${c.maxPaymentsDay} sandbox payments. Try again tomorrow.`);
    }
    let request;
    try {
      request = enrichSale({ ...order, orderId }, { catalogPath: st.activePath() });
    } catch (e) {
      if (e instanceof EnrichSaleError) return res.json({ outcome: 'refused', rail, orderId, refused: refusalPayload(e), messages: [`No ${railName} call was made and the ledger was not touched.`] });
      throw e;
    }
    const messages = [];
    let result; const rd = orderReadiness(request); let validation = validationView(level1 ? rd.before : rd.after);
    if (rail === 'paypal') {
      const catalog = loadCatalog(st.activePath());
      if (!level1) validation = withRailCheck(validation, paypal.validatePayPalRail(request, catalog));
      result = await paypal.chargePayPal(request, catalog, { ledgerFile: st.ledgerFile, log: (l) => messages.push(l), level1 });
    } else if (existing.rail === 'paypal' && ['pending', 'unknown'].includes(existing.status)) {
      // An unresolved PayPal attempt for this order id: never charge it on Braintree as well.
      result = { outcome: 'blocked_other_rail', orderId, rail: 'paypal', message: 'This order id has an unresolved attempt on PayPal. Retry it on PayPal first, so the order cannot be charged twice.' };
    } else {
      // Level 1: only the amount and the order id go to Braintree.
      const toSend = level1 ? { amount: request.amount, orderId: request.orderId, options: { submitForSettlement: true } } : request;
      result = await chargeRequest(toSend, { ledgerFile: st.ledgerFile, log: (l) => messages.push(l), level1 });
    }
    if (COUNTED.has(result.outcome) || (result.outcome === 'paypal_unavailable' && result.charged === 'unknown')) { session.payments += 1; usage.add({ payments: 1 }); }
    res.json({ ...result, level: result.level || (level1 ? 1 : 3), rail: result.rail || (result.outcome === 'already_charged' ? existing.rail || 'braintree' : rail), request, messages, sandbox: true, validation, paymentsLeft: Math.max(0, config().maxPaymentsSession - session.payments) });
  }));

  // Readiness: validator-based scores for the demo order (Level 1 before, Level 2/3 after) and the catalog,
  // plus the fee ESTIMATE for that order from data/rates.json. The order counter is this session's only.
  app.get('/api/readiness', (req, res) => {
    const st = stOf(req);
    const { meta, items, source } = st.read();
    const orders = store.sessionOrders(ledger.read(st.ledgerFile), st.sessionStart());
    let request = null; let refusal = null;
    try {
      request = enrichSale({ ...parseOrder(DEMO_ORDER), orderId: 'READINESS-DEMO' }, { catalogPath: st.activePath() });
    } catch (e) {
      if (!(e instanceof EnrichSaleError)) throw e;
      refusal = refusalPayload(e);
    }
    const rd = request ? orderReadiness(request) : null;
    const last = orders.length ? orders[orders.length - 1] : null;
    res.json({
      synthetic: true, sandbox: true, source, counts: store.counts(items), modelLabel: prettyModel(meta.model),
      level3Orders: orders.length, sessionStart: st.sessionStart(),
      lastOrder: last ? { orderId: last[0], transactionId: last[1].transactionId, amount: last[1].amount } : null,
      demoOrder: { ok: !!request, amount: request ? request.amount : null, refusal },
      order: rd ? { before: validationView(rd.before), after: validationView(rd.after) } : null,
      catalog: catalogReadiness(items),
      fee: estimateFeeDifference(request ? request.amount : '958.05'),
    });
  });

  // ----- operator switch (only if ADMIN_TOKEN is set): turn live AI off/on without a redeploy, see usage -----
  const admin = (req, res, next) => {
    const t = config().adminToken;
    if (!t) return res.status(404).json({ error: 'Not found' });
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return safeEqual(given, t) ? next() : res.status(401).json({ error: 'Unauthorized' });
  };
  app.get('/api/admin/status', admin, (req, res) => {
    const c = config();
    res.json({ liveAi: liveAiStatus(), override: runtime.liveAiOverride, usage: usage.snapshot(), caps: { dailyCapUsd: c.dailyCapUsd, maxRerunsDay: c.maxRerunsDay, maxPaymentsDay: c.maxPaymentsDay, maxRerunsSession: c.maxRerunsSession, maxPaymentsSession: c.maxPaymentsSession }, sessions: sessions.count(), codeList: codeListKind() });
  });
  app.post('/api/admin/live-ai', admin, (req, res) => {
    if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ error: 'Send {"enabled": true|false}' });
    runtime.liveAiOverride = req.body.enabled; // until the next restart
    res.json({ liveAi: liveAiStatus(), override: runtime.liveAiOverride });
  });

  // Built UI (npm run web:build), same origin as the API.
  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { setHeaders: (res, file) => { if (file.endsWith('index.html')) res.set('Cache-Control', 'no-store'); } }));
    app.use((req, res, next) => (req.path.startsWith('/api/') ? next() : res.set('Cache-Control', 'no-store').sendFile(path.join(dist, 'index.html'))));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.type === 'entity.parse.failed') { status = 400; message = 'The request body is not valid JSON.'; }
    if (err.type === 'entity.too.large') { status = 413; message = 'The request is too large.'; }
    if (status >= 500) { console.error(err); message = 'Server error. Nothing was changed; try again.'; }
    if (res.headersSent) return res.end();
    return res.status(status).json({ error: message, ...(err.extra || {}) });
  });

  app.locals.sessions = sessions; app.locals.usage = usage; app.locals.runtime = runtime;
  return app;
}

module.exports = { createApp, parseOrder };

if (require.main === module) {
  // A dead AI provider must fail fast, not hang a judge's click for minutes.
  process.env.LLM_TIMEOUT_MS = process.env.LLM_TIMEOUT_MS || '15000';
  process.env.LLM_ATTEMPTS = process.env.LLM_ATTEMPTS || '2';
  const production = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
  const app = createApp();
  app.locals.sessions.clearAll(); // every start begins clean: no session data survives a restart
  const sweeper = setInterval(() => app.locals.sessions.sweep(), 10 * 60_000);
  sweeper.unref();
  const server = app.listen(port, host, () => {
    const c = config();
    console.log(`LineGrade listening on http://${host}:${port} (SYNTHETIC data, Braintree SANDBOX, code list: ${codeListKind()}, live AI: ${c.liveAiFlag && c.hasLlmKey ? 'on' : 'off'}, idle session expiry ${Math.round(c.sessionIdleMs / 60000)} min)`);
  });
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
