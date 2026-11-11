// Charge a built Braintree request exactly once per orderId, then read it back and check it.
// Shared by scripts/m2-flow.js and the web server. Braintree SANDBOX only. Credentials come from
// the environment (.env) and never leave the server.
//
// chargeRequest(request, opts) -> { outcome, ...details }
//   outcome: charged | already_charged | declined | charged_reply_lost | no_answer_not_charged |
//            unknown | pending_resolved_not_charged
//
// Ledger protocol (src/ledger.js): pending is written BEFORE the call; charged / failed / unknown after.

const path = require('node:path');
const braintree = require('braintree');
const ledger = require('./ledger');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from the shell */ }

const COMMERCIAL_TEST_CARD = '4009040000000009'; // Braintree docs: Commercial = Yes
// Errors that prove the request never left this machine (nothing can have been charged).
const NEVER_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const neverSent = (e) => NEVER_SENT.has(e && (e.code || (e.cause && e.cause.code) || (e.errno && e.syscall && e.code)));

// Test-only failure injection, honoured only when ALLOW_CHAOS=1 (never set in production):
//   CHAOS_BRAINTREE=down  every Braintree call fails as if the network were unreachable
const chaosDown = () => process.env.ALLOW_CHAOS === '1' && process.env.CHAOS_BRAINTREE === 'down';
const chaosError = () => Object.assign(new Error('connect ECONNREFUSED (simulated: Braintree unavailable)'), { code: 'ECONNREFUSED', type: 'simulated' });

const OK_STATUSES = ['authorized', 'submitted_for_settlement', 'settling', 'settled', 'settlement_pending'];

function gateway() {
  const { BT_MERCHANT_ID, BT_PUBLIC_KEY, BT_PRIVATE_KEY } = process.env;
  if (!BT_MERCHANT_ID || !BT_PUBLIC_KEY || !BT_PRIVATE_KEY) throw new Error('Missing BT_MERCHANT_ID / BT_PUBLIC_KEY / BT_PRIVATE_KEY in .env');
  return new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox, merchantId: BT_MERCHANT_ID, publicKey: BT_PUBLIC_KEY, privateKey: BT_PRIVATE_KEY,
  });
}

// Ask Braintree whether a sale with this orderId already exists.
async function findByOrderId(gw, orderId) {
  if (chaosDown()) throw chaosError();
  const stream = gw.transaction.search((s) => { s.orderId().is(orderId); });
  const found = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (t) => found.push(t));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return found.filter((t) => !['failed', 'gateway_rejected', 'processor_declined', 'voided'].includes(t.status));
}

function braintreeErrors(result) {
  const lines = [`Braintree said: ${result.message}`];
  const t = result.transaction;
  if (t) lines.push(`  status=${t.status} processorResponse=${t.processorResponseCode} ${t.processorResponseText || ''}`.trimEnd());
  for (const e of (result.errors ? result.errors.deepErrors() : [])) lines.push(`  ${e.attribute} [${e.code}] ${e.message}`);
  return lines;
}

// transaction.find + transactionLineItem.findAll, compared with what we sent.
async function readBack(gw, id, req) {
  const tx = await gw.transaction.find(id);
  const li = await gw.transactionLineItem.findAll(id);
  const cc = tx.creditCard || {};
  const checks = [
    { check: 'Sale status', expected: 'accepted', actual: tx.status, pass: OK_STATUSES.includes(tx.status) },
    { check: 'Amount', expected: req.amount, actual: tx.amount, pass: tx.amount === req.amount },
    { check: 'PO number', expected: req.purchaseOrderNumber, actual: tx.purchaseOrderNumber, pass: tx.purchaseOrderNumber === req.purchaseOrderNumber },
    { check: 'Tax amount', expected: req.taxAmount, actual: tx.taxAmount, pass: tx.taxAmount === req.taxAmount },
    { check: 'Shipping amount', expected: req.shippingAmount, actual: tx.shippingAmount, pass: tx.shippingAmount === req.shippingAmount },
    { check: 'Ships-from postal', expected: req.shipsFromPostalCode, actual: tx.shipsFromPostalCode, pass: tx.shipsFromPostalCode === req.shipsFromPostalCode },
    { check: 'Commercial card', expected: 'Yes', actual: cc.commercial, pass: cc.commercial === 'Yes' },
    { check: 'Line items returned', expected: `${req.lineItems.length} of ${req.lineItems.length}`, actual: `${li.length} of ${req.lineItems.length}`, pass: li.length === req.lineItems.length },
  ];
  req.lineItems.forEach((want, k) => {
    const got = li.find((x) => x.productCode === want.productCode) || li[k] || {};
    const same = got.commodityCode === want.commodityCode && got.unitOfMeasure === want.unitOfMeasure
      && got.totalAmount === want.totalAmount && got.taxAmount === want.taxAmount && got.quantity === want.quantity
      && got.description === want.description && got.productCode === want.productCode;
    checks.push({
      check: `Line ${k + 1} ${want.productCode}`,
      expected: `${want.commodityCode} ${want.unitOfMeasure} x${want.quantity} total ${want.totalAmount} tax ${want.taxAmount}`,
      actual: `${got.commodityCode} ${got.unitOfMeasure} x${got.quantity} total ${got.totalAmount} tax ${got.taxAmount}`,
      pass: same,
    });
  });
  const lineItems = li.map((x) => ({
    productCode: x.productCode, commodityCode: x.commodityCode, unitOfMeasure: x.unitOfMeasure, quantity: x.quantity,
    unitAmount: x.unitAmount, totalAmount: x.totalAmount, taxAmount: x.taxAmount, description: x.description, name: x.name,
  }));
  return { checks, lineItems, tx: { id: tx.id, status: tx.status, amount: tx.amount, commercial: cc.commercial, cardLast4: cc.last4 } };
}

/**
 * @param {object} request  from enrichSale() (no payment method)
 * @param {{card?:string, ledgerFile?:string, simulateLostResponse?:boolean, log?:(line:string)=>void}} [opts]
 */
async function chargeRequest(request, opts = {}) {
  const log = opts.log || (() => {});
  const ledgerFile = opts.ledgerFile || ledger.DEFAULT_LEDGER;
  const orderId = request.orderId;
  const gw = gateway();
  let entry = ledger.get(orderId, ledgerFile);

  if (entry && entry.status === 'unknown') {
    log(`      Ledger says a previous attempt got no answer (${entry.updated_at}). Asking Braintree before doing anything else...`);
    let found;
    try { found = await findByOrderId(gw, orderId); } catch (e) {
      log(`Cannot reach Braintree to check (${e.message}). Not charging again until it can be checked.`);
      return { outcome: 'braintree_unavailable', orderId, retrySafe: true, charged: 'unknown', error: String(e.message) };
    }
    if (found.length) {
      entry = ledger.set(orderId, { status: 'charged', transactionId: found[0].id, amount: found[0].amount, reconciled: true }, ledgerFile);
      log(`      Found sale ${found[0].id} at Braintree: ledger corrected to charged.`);
    } else {
      entry = ledger.set(orderId, { status: 'failed', note: 'reconciled: no sale found at Braintree' }, ledgerFile);
      log('      No sale found at Braintree for this orderId: nothing was charged, ledger set to failed, retrying is safe.');
    }
  }

  if (entry && entry.status === 'charged') {
    log(`\nALREADY CHARGED: orderId ${orderId} was charged as transaction ${entry.transactionId} (${entry.amount} USD, ${entry.updated_at}).`);
    log('No new sale was created.');
    return { outcome: 'already_charged', orderId, transactionId: entry.transactionId, amount: entry.amount, at: entry.updated_at };
  }
  if (entry && entry.status === 'pending') {
    log(`\nBLOCKED: ledger shows orderId ${orderId} as "pending" (a previous run stopped mid-sale). Not charging again until it is resolved:`);
    let found;
    try { found = await findByOrderId(gw, orderId); } catch (e) {
      log(`Cannot reach Braintree to check (${e.message}).`);
      return { outcome: 'braintree_unavailable', orderId, retrySafe: true, charged: 'unknown', error: String(e.message) };
    }
    if (found.length) {
      ledger.set(orderId, { status: 'charged', transactionId: found[0].id, amount: found[0].amount, reconciled: true }, ledgerFile);
      log(`Braintree has sale ${found[0].id}: ledger corrected to charged. No new sale was created.`);
      return { outcome: 'already_charged', orderId, transactionId: found[0].id, amount: found[0].amount, reconciled: true };
    }
    ledger.set(orderId, { status: 'failed', note: 'reconciled: pending with no sale at Braintree' }, ledgerFile);
    log('No sale found at Braintree: ledger set to failed. Run again to retry.');
    return { outcome: 'pending_resolved_not_charged', orderId };
  }

  const sale = {
    ...request,
    creditCard: { number: opts.card || COMMERCIAL_TEST_CARD, expirationDate: '12/2030', cvv: '123', cardholderName: 'Lab Ops Purchasing' },
  };
  ledger.set(orderId, { status: 'pending', rail: 'braintree', amount: request.amount, po: request.purchaseOrderNumber, started_at: new Date().toISOString() }, ledgerFile);

  let result;
  try {
    if (chaosDown()) throw chaosError();
    result = await gw.transaction.sale(sale);
    if (opts.simulateLostResponse) throw Object.assign(new Error('Braintree reply lost'), { type: 'simulated' });
  } catch (e) {
    // No usable answer: the sale may or may not exist. Try to find out right now.
    log(`\nNo answer from Braintree (${e.type || e.name}: ${e.message}).`);
    if (neverSent(e)) {
      // The request never left this machine: certain that nothing was charged. Safe to retry at once.
      ledger.set(orderId, { status: 'failed', error: String(e.message), note: 'Braintree unreachable; request never sent' }, ledgerFile);
      log('Braintree is unreachable and the request was never sent. Nothing was charged. Ledger status: failed (retrying is safe).');
      return { outcome: 'braintree_unavailable', orderId, retrySafe: true, charged: false, error: String(e.message) };
    }
    ledger.set(orderId, { status: 'unknown', error: String(e.message) }, ledgerFile);
    try {
      const found = await findByOrderId(gw, orderId);
      if (found.length) {
        ledger.set(orderId, { status: 'charged', transactionId: found[0].id, amount: found[0].amount, reconciled: true }, ledgerFile);
        log(`Checked Braintree: the sale DID go through as ${found[0].id}. Ledger set to charged. Do not retry.`);
        return { outcome: 'charged_reply_lost', orderId, transactionId: found[0].id, amount: found[0].amount };
      }
      ledger.set(orderId, { status: 'failed', note: 'no answer, and no sale found at Braintree' }, ledgerFile);
      log('Checked Braintree: no sale exists for this orderId. Ledger set to failed; run again to retry.');
      return { outcome: 'no_answer_not_charged', orderId, error: String(e.message) };
    } catch (e2) {
      log(`Could not check Braintree either (${e2.message}). Ledger status: UNKNOWN. The next run with this orderId will reconcile before charging.`);
      return { outcome: 'unknown', orderId, retrySafe: true, charged: 'unknown', error: String(e2.message) };
    }
  }

  if (!result.success) {
    const lines = braintreeErrors(result);
    for (const l of lines) log(l);
    ledger.set(orderId, { status: 'failed', error: result.message }, ledgerFile);
    log('Nothing was charged. Ledger status: failed (retry with the same orderId is allowed).');
    return { outcome: 'declined', orderId, message: result.message, details: lines.slice(1) };
  }

  const id = result.transaction.id;
  ledger.set(orderId, { status: 'charged', transactionId: id, amount: result.transaction.amount }, ledgerFile);
  log(`\nSale accepted: transaction ID ${id}, status ${result.transaction.status}, amount ${result.transaction.amount} USD`);
  log('\nRead-back (transaction.find + transactionLineItem.findAll):');
  const rb = await readBack(gw, id, request);
  return {
    outcome: 'charged', orderId, transactionId: id, status: result.transaction.status, amount: result.transaction.amount,
    checks: rb.checks, passed: rb.checks.every((c) => c.pass), lineItemsReturned: rb.lineItems, transaction: rb.tx,
  };
}

module.exports = { chargeRequest, gateway, findByOrderId, readBack, COMMERCIAL_TEST_CARD };
