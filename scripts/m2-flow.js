#!/usr/bin/env node
// M2: full flow, locally, end to end (Braintree SANDBOX, SYNTHETIC catalog).
//
//   node scripts/m2-flow.js                      enrich catalog, build the $958 order, charge, read back
//   node scripts/m2-flow.js --order-id=X         reuse an orderId (a second run says "already charged")
//   node scripts/m2-flow.js --items=SKU:qty,...  different order (unknown / needs_review SKUs are refused)
//   node scripts/m2-flow.js --skip-enrich        reuse data/enriched-catalog.json (no LLM calls)
//   node scripts/m2-flow.js --force              re-classify every unapproved row (default: only new/changed rows)
//   node scripts/m2-flow.js --card=NUMBER        other sandbox test card (e.g. a declining one)
//   node scripts/m2-flow.js --simulate-lost-response   test only: pretend Braintree's reply was lost
//
// Output is appended to eval/results/m2-run.log.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may come from the shell */ }

const { enrichCatalog } = require(path.join(ROOT, 'src', 'enrich-catalog.js'));
const { enrichSale, EnrichSaleError } = require(path.join(ROOT, 'src', 'enrich-sale.js'));
const ledger = require(path.join(ROOT, 'src', 'ledger.js'));
const { chargeRequest } = require(path.join(ROOT, 'src', 'pay.js'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));

const LOG = path.resolve(ROOT, args.log || 'eval/results/m2-run.log');
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

function table(rows) {
  const w = [0, 0, 0];
  for (const r of rows) r.slice(0, 3).forEach((c, i) => { w[i] = Math.max(w[i], String(c).length); });
  out(`${'CHECK'.padEnd(w[0])}  ${'EXPECTED'.padEnd(w[1])}  ${'ACTUAL'.padEnd(w[2])}  RESULT`);
  for (const [a, b, c, ok] of rows) out(`${String(a).padEnd(w[0])}  ${String(b).padEnd(w[1])}  ${String(c).padEnd(w[2])}  ${ok ? 'PASS' : 'FAIL'}`);
}

async function main() {
  out(`\n=== m2-flow ${new Date().toISOString()} args: ${process.argv.slice(2).join(' ') || '(none)'} ===`);
  out('SYNTHETIC catalog (fictional Northfield Lab Supply), Braintree SANDBOX only.');

  // 1. Enrich the catalog (or reuse it).
  if (args['skip-enrich']) out('\n[1/4] Catalog: reusing data/enriched-catalog.json (--skip-enrich)');
  else {
    out('\n[1/4] Classify the demo catalog');
    const cat = await enrichCatalog({ log: out, force: !!args.force });
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

  // 4. Charge, exactly once per orderId (shared logic in src/pay.js).
  out('\n[4/4] Braintree sandbox sale');
  const result = await chargeRequest(request, { card: args.card, ledgerFile: LEDGER_FILE, simulateLostResponse: !!args['simulate-lost-response'], log: out });

  if (result.outcome === 'charged') {
    table(result.checks.map((c) => [c.check, c.expected, c.actual, c.pass]));
    const failed = result.checks.filter((c) => !c.pass);
    out(`\nRESULT: ${failed.length ? `FAIL (${failed.length} check${failed.length > 1 ? 's' : ''} failed)` : `PASS (${result.checks.length}/${result.checks.length} checks)`}   transaction ${result.transactionId}`);
    return failed.length ? 1 : 0;
  }
  return result.outcome === 'already_charged' ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    out(`\nERROR: ${e.message}`);
    process.exitCode = 1;
  });
}
