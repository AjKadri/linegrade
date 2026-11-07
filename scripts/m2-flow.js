#!/usr/bin/env node
// M2: full flow, locally, end to end (Braintree SANDBOX, SYNTHETIC catalog).
//
//   node scripts/m2-flow.js                      enrich catalog, build the $958 order, charge, read back
//   node scripts/m2-flow.js --order-id=X         reuse an orderId (a second run says "already charged")
//   node scripts/m2-flow.js --items=SKU:qty,...  different order (unknown / needs_review SKUs are refused)
//   node scripts/m2-flow.js --skip-enrich        reuse data/enriched-catalog.json (no LLM calls)
//   node scripts/m2-flow.js --card=NUMBER        other sandbox test card (e.g. a declining one)
//   node scripts/m2-flow.js --simulate-lost-response   test only: pretend Braintree's reply was lost
//
// Output is appended to eval/results/m2-run.log.

const fs = require('node:fs');
const path = require('node:path');
const braintree = require('braintree');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may come from the shell */ }

const { enrichCatalog } = require(path.join(ROOT, 'src', 'enrich-catalog.js'));
const { enrichSale, EnrichSaleError } = require(path.join(ROOT, 'src', 'enrich-sale.js'));
const ledger = require(path.join(ROOT, 'src', 'ledger.js'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));

const LOG = path.resolve(ROOT, args.log || 'eval/results/m2-run.log');
const COMMERCIAL_TEST_CARD = '4009040000000009'; // Braintree docs: Commercial = Yes
const LEDGER_FILE = args.ledger ? path.resolve(args.ledger) : ledger.DEFAULT_LEDGER;

fs.mkdirSync(path.dirname(LOG), { recursive: true });
const out = (line = '') => { console.log(line); fs.appendFileSync(LOG, `${line}\n`); };

// The demo order: 3 SKUs, about $958 with 8% tax and $25 shipping (SYNTHETIC).
const DEFAULT_ITEMS = [
  { sku: 'NLS-002', qty: 25 }, // nitrile exam gloves, 100/bx
  { sku: 'NLS-007', qty: 10 }, // centrifuge tubes 15 mL
  { sku: 'NLS-005', qty: 5 }, //  filter pipette tips 1000 uL, case
];

function parseItems(s) {
  return String(s).split(',').map((p) => {
    const [sku, qty] = p.split(':');
    return { sku: sku.trim(), qty: Number(qty ?? 1) };
  });
}

function buildOrder() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return {
    orderId: typeof args['order-id'] === 'string' ? args['order-id'] : `LG-M2-${stamp}`,
    poNumber: 'PO-77812',
    items: args.items ? parseItems(args.items) : DEFAULT_ITEMS,
    shipping: '25.00',
    shipTo: { line1: '200 Science Park Rd', city: 'Madison', state: 'WI', postal: '53711', country3: 'USA' },
    shipsFromPostalCode: '60607',
    taxRate: 0.08,
  };
}

function gateway() {
  const { BT_MERCHANT_ID, BT_PUBLIC_KEY, BT_PRIVATE_KEY } = process.env;
  if (!BT_MERCHANT_ID || !BT_PUBLIC_KEY || !BT_PRIVATE_KEY) throw new Error('Missing BT_MERCHANT_ID / BT_PUBLIC_KEY / BT_PRIVATE_KEY in .env');
  return new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox, merchantId: BT_MERCHANT_ID, publicKey: BT_PUBLIC_KEY, privateKey: BT_PRIVATE_KEY,
  });
}

// Ask Braintree whether a sale with this orderId already exists.
async function findByOrderId(gw, orderId) {
  const stream = gw.transaction.search((s) => { s.orderId().is(orderId); });
  const found = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (t) => found.push(t));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return found.filter((t) => !['failed', 'gateway_rejected', 'processor_declined', 'voided'].includes(t.status));
}

function table(rows) {
  const w = [0, 0, 0];
  for (const r of rows) r.slice(0, 3).forEach((c, i) => { w[i] = Math.max(w[i], String(c).length); });
  out(`${'CHECK'.padEnd(w[0])}  ${'EXPECTED'.padEnd(w[1])}  ${'ACTUAL'.padEnd(w[2])}  RESULT`);
  for (const [a, b, c, ok] of rows) out(`${String(a).padEnd(w[0])}  ${String(b).padEnd(w[1])}  ${String(c).padEnd(w[2])}  ${ok ? 'PASS' : 'FAIL'}`);
}

async function readBack(gw, id, req) {
  const tx = await gw.transaction.find(id);
  const li = await gw.transactionLineItem.findAll(id);
  const cc = tx.creditCard || {};
  const rows = [
    ['Sale status', 'accepted', tx.status, ['authorized', 'submitted_for_settlement', 'settling', 'settled', 'settlement_pending'].includes(tx.status)],
    ['Amount', req.amount, tx.amount, tx.amount === req.amount],
    ['PO number', req.purchaseOrderNumber, tx.purchaseOrderNumber, tx.purchaseOrderNumber === req.purchaseOrderNumber],
    ['Tax amount', req.taxAmount, tx.taxAmount, tx.taxAmount === req.taxAmount],
    ['Shipping amount', req.shippingAmount, tx.shippingAmount, tx.shippingAmount === req.shippingAmount],
    ['Ships-from postal', req.shipsFromPostalCode, tx.shipsFromPostalCode, tx.shipsFromPostalCode === req.shipsFromPostalCode],
    ['Commercial card', 'Yes', cc.commercial, cc.commercial === 'Yes'],
    [`Line items returned`, `${req.lineItems.length} of ${req.lineItems.length}`, `${li.length} of ${req.lineItems.length}`, li.length === req.lineItems.length],
  ];
  req.lineItems.forEach((want, k) => {
    const got = li.find((x) => x.productCode === want.productCode) || li[k] || {};
    const same = got.commodityCode === want.commodityCode && got.unitOfMeasure === want.unitOfMeasure
      && got.totalAmount === want.totalAmount && got.taxAmount === want.taxAmount && got.quantity === want.quantity
      && got.description === want.description && got.productCode === want.productCode;
    rows.push([
      `Line ${k + 1} ${want.productCode}`,
      `${want.commodityCode} ${want.unitOfMeasure} x${want.quantity} total ${want.totalAmount} tax ${want.taxAmount}`,
      `${got.commodityCode} ${got.unitOfMeasure} x${got.quantity} total ${got.totalAmount} tax ${got.taxAmount}`,
      same,
    ]);
  });
  return { rows, tx, li };
}

function braintreeErrors(result) {
  const lines = [`Braintree said: ${result.message}`];
  const t = result.transaction;
  if (t) lines.push(`  status=${t.status} processorResponse=${t.processorResponseCode} ${t.processorResponseText || ''}`.trimEnd());
  const errs = result.errors ? result.errors.deepErrors() : [];
  for (const e of errs) lines.push(`  ${e.attribute} [${e.code}] ${e.message}`);
  return lines;
}

async function main() {
  out(`\n=== m2-flow ${new Date().toISOString()} args: ${process.argv.slice(2).join(' ') || '(none)'} ===`);
  out('SYNTHETIC catalog (fictional Northfield Lab Supply), Braintree SANDBOX only.');

  // 1. Enrich the catalog (or reuse it).
  if (args['skip-enrich']) out('\n[1/4] Catalog: reusing data/enriched-catalog.json (--skip-enrich)');
  else {
    out('\n[1/4] Classify the demo catalog');
    const cat = await enrichCatalog({ log: out });
    const review = Object.values(cat.items).filter((i) => i.status === 'needs_review');
    out(`      needs_review: ${review.map((i) => i.sku).join(', ') || 'none'}`);
  }

  // 2 + 3. Build the order and enrich it (refuses before any API call).
  const order = buildOrder();
  out(`\n[2/4] Order ${order.orderId}, PO ${order.poNumber}: ${order.items.map((i) => `${i.sku} x${i.qty}`).join(', ')}`);
  let request;
  try {
    request = enrichSale(order);
  } catch (e) {
    if (e instanceof EnrichSaleError) {
      out(`\n[3/4] enrichSale: ${e.code}`);
      out(`      ${e.message}`);
      out('      No Braintree call was made and the ledger was not touched.');
      return e.code === 'REFUSED' ? 2 : 1;
    }
    throw e;
  }
  out(`\n[3/4] enrichSale OK: ${request.lineItems.length} line items, tax ${request.taxAmount}, shipping ${request.shippingAmount}, total ${request.amount} USD`);
  for (const li of request.lineItems) out(`      ${li.productCode}  ${li.commodityCode}  ${li.unitOfMeasure}  x${li.quantity}  ${li.totalAmount}  ${li.description}`);

  // 4. Charge, exactly once per orderId.
  out('\n[4/4] Braintree sandbox sale');
  const gw = gateway();
  let entry = ledger.get(order.orderId, LEDGER_FILE);

  if (entry && entry.status === 'unknown') {
    out(`      Ledger says a previous attempt got no answer (${entry.updated_at}). Asking Braintree before doing anything else...`);
    const found = await findByOrderId(gw, order.orderId);
    if (found.length) {
      entry = ledger.set(order.orderId, { status: 'charged', transactionId: found[0].id, amount: found[0].amount, reconciled: true }, LEDGER_FILE);
      out(`      Found sale ${found[0].id} at Braintree: ledger corrected to charged.`);
    } else {
      entry = ledger.set(order.orderId, { status: 'failed', note: 'reconciled: no sale found at Braintree' }, LEDGER_FILE);
      out('      No sale found at Braintree for this orderId: nothing was charged, ledger set to failed, retrying is safe.');
    }
  }

  if (entry && entry.status === 'charged') {
    out(`\nALREADY CHARGED: orderId ${order.orderId} was charged as transaction ${entry.transactionId} (${entry.amount} USD, ${entry.updated_at}).`);
    out('No new sale was created.');
    return 0;
  }
  if (entry && entry.status === 'pending') {
    out(`\nBLOCKED: ledger shows orderId ${order.orderId} as "pending" (a previous run stopped mid-sale). Not charging again until it is resolved:`);
    const found = await findByOrderId(gw, order.orderId);
    if (found.length) {
      ledger.set(order.orderId, { status: 'charged', transactionId: found[0].id, amount: found[0].amount, reconciled: true }, LEDGER_FILE);
      out(`Braintree has sale ${found[0].id}: ledger corrected to charged. No new sale was created.`);
      return 0;
    }
    ledger.set(order.orderId, { status: 'failed', note: 'reconciled: pending with no sale at Braintree' }, LEDGER_FILE);
    out('No sale found at Braintree: ledger set to failed. Run again to retry.');
    return 1;
  }

  const sale = {
    ...request,
    creditCard: { number: args.card || COMMERCIAL_TEST_CARD, expirationDate: '12/2030', cvv: '123', cardholderName: 'Lab Ops Purchasing' },
  };
  ledger.set(order.orderId, { status: 'pending', amount: request.amount, po: order.poNumber, started_at: new Date().toISOString() }, LEDGER_FILE);

  let result;
  try {
    result = await gw.transaction.sale(sale);
    if (args['simulate-lost-response']) throw Object.assign(new Error('Braintree reply lost'), { type: 'simulated' });
  } catch (e) {
    // No usable answer: the sale may or may not exist. Try to find out right now.
    out(`\nNo answer from Braintree (${e.type || e.name}: ${e.message}).`);
    ledger.set(order.orderId, { status: 'unknown', error: String(e.message) }, LEDGER_FILE);
    try {
      const found = await findByOrderId(gw, order.orderId);
      if (found.length) {
        ledger.set(order.orderId, { status: 'charged', transactionId: found[0].id, amount: found[0].amount, reconciled: true }, LEDGER_FILE);
        out(`Checked Braintree: the sale DID go through as ${found[0].id}. Ledger set to charged. Do not retry.`);
        return 1;
      }
      ledger.set(order.orderId, { status: 'failed', note: 'no answer, and no sale found at Braintree' }, LEDGER_FILE);
      out('Checked Braintree: no sale exists for this orderId. Ledger set to failed; run again to retry.');
    } catch (e2) {
      out(`Could not check Braintree either (${e2.message}). Ledger status: UNKNOWN. The next run with this orderId will reconcile before charging.`);
    }
    return 1;
  }

  if (!result.success) {
    for (const l of braintreeErrors(result)) out(l);
    ledger.set(order.orderId, { status: 'failed', error: result.message }, LEDGER_FILE);
    out('Nothing was charged. Ledger status: failed (retry with the same orderId is allowed).');
    return 1;
  }

  const id = result.transaction.id;
  ledger.set(order.orderId, { status: 'charged', transactionId: id, amount: result.transaction.amount }, LEDGER_FILE);
  out(`\nSale accepted: transaction ID ${id}, status ${result.transaction.status}, amount ${result.transaction.amount} USD`);

  out('\nRead-back (transaction.find + transactionLineItem.findAll):');
  const { rows } = await readBack(gw, id, request);
  table(rows);
  const failed = rows.filter((r) => !r[3]);
  out(`\nRESULT: ${failed.length ? `FAIL (${failed.length} check${failed.length > 1 ? 's' : ''} failed)` : `PASS (${rows.length}/${rows.length} checks)`}   transaction ${id}`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  out(`\nERROR: ${e.message}`);
  process.exitCode = 1;
});
