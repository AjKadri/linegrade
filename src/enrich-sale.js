// enrichSale(order): a plain order (SKUs + quantities) -> a Braintree transaction.sale request
// carrying Level 2/3 data, built from the enriched catalog. No network calls here.
//
// Refuses (throws EnrichSaleError, code "REFUSED") if any SKU is missing from the catalog, still
// needs_review or excluded, naming the SKUs. The built request is then run through src/validate.js
// (totals to the cent, placeholder descriptions, units per processor, field lengths); a failure throws
// EnrichSaleError code "VALIDATION".
//
// Tax rule (same as order-fixture.js): unit tax = round(unit price in cents x taxRate);
// line tax = unit tax x quantity. Money is handled in integer cents.
//
// SYNTHETIC demo data only; the caller adds the payment method (e.g. creditCard).

const fs = require('node:fs');
const path = require('node:path');

const { validateRequest } = require('./validate');

const DEFAULT_CATALOG = path.join(__dirname, '..', 'data', 'enriched-catalog.json');

// Braintree field limits.
const LIMITS = { name: 35, description: 127, productCode: 12, commodityCode: 12, unitOfMeasure: 12, purchaseOrderNumber: 17, orderId: 255 };

class EnrichSaleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EnrichSaleError';
    this.code = code; // REFUSED | INVALID_ORDER | CATALOG | TOTALS
    this.details = details;
  }
}

const cents = (s) => Math.round(Number(s) * 100);
const money = (c) => (c / 100).toFixed(2);

function loadCatalog(file = DEFAULT_CATALOG) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new EnrichSaleError('CATALOG', `Cannot read enriched catalog ${path.relative(process.cwd(), file)}: ${e.message}. Run: node src/enrich-catalog.js`);
  }
  if (!parsed || typeof parsed.items !== 'object') throw new EnrichSaleError('CATALOG', 'Enriched catalog has no "items" object');
  return parsed;
}

function shortName(description) {
  if (description.length <= LIMITS.name) return description;
  const cut = description.slice(0, LIMITS.name);
  const at = cut.lastIndexOf(' ');
  return (at > 15 ? cut.slice(0, at) : cut).replace(/[\s,;:-]+$/, '');
}

function validateOrder(order) {
  const bad = (m) => { throw new EnrichSaleError('INVALID_ORDER', `Invalid order: ${m}`); };
  if (!order || typeof order !== 'object') bad('order must be an object');
  const { orderId, poNumber, items, shipping, shipTo, shipsFromPostalCode, taxRate } = order;
  if (typeof orderId !== 'string' || !orderId.trim()) bad('orderId is required');
  if (orderId.length > LIMITS.orderId) bad('orderId too long');
  if (typeof poNumber !== 'string' || !poNumber.trim()) bad('poNumber is required');
  if (poNumber.length > LIMITS.purchaseOrderNumber) bad(`poNumber longer than ${LIMITS.purchaseOrderNumber} characters (Braintree limit)`);
  if (!Array.isArray(items) || !items.length) bad('items must be a non-empty array');
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it.sku !== 'string' || !it.sku) bad('every item needs a sku');
    if (!Number.isInteger(it.qty) || it.qty < 1) bad(`item ${it.sku}: qty must be a whole number >= 1`);
    if (seen.has(it.sku)) bad(`item ${it.sku} appears twice; combine the quantities`);
    seen.add(it.sku);
  }
  const ship = Number(shipping);
  if (shipping === undefined || shipping === null || shipping === '' || !Number.isFinite(ship) || ship < 0) bad('shipping must be an amount >= 0');
  if (typeof taxRate !== 'number' || !(taxRate >= 0 && taxRate < 1)) bad('taxRate must be a number from 0 up to 1, e.g. 0.08');
  if (!/^\d{5}(-\d{4})?$/.test(String(shipsFromPostalCode || ''))) bad('shipsFromPostalCode must be a US ZIP');
  if (!shipTo || !shipTo.line1 || !shipTo.city || !shipTo.state || !shipTo.postal) bad('shipTo needs line1, city, state, postal');
}

/**
 * @param {{orderId:string, poNumber:string, items:{sku:string, qty:number}[], shipping:string|number,
 *   shipTo:{line1:string,city:string,state:string,postal:string,country3?:string}, shipsFromPostalCode:string, taxRate:number}} order
 * @param {{catalog?:object, catalogPath?:string}} [opts]
 * @returns {object} Braintree transaction.sale request (without a payment method)
 */
function enrichSale(order, opts = {}) {
  validateOrder(order);
  const catalog = opts.catalog || loadCatalog(opts.catalogPath);

  const missing = []; const needsReview = []; const excluded = [];
  for (const { sku } of order.items) {
    const row = catalog.items[sku];
    if (!row) missing.push(sku);
    else if (row.status === 'excluded') excluded.push(sku);
    else if (row.status !== 'ok') needsReview.push(sku);
    else if (!row.unspsc || !row.uom_braintree || !row.description) needsReview.push(sku); // defensive: "ok" without data
  }
  if (missing.length || needsReview.length || excluded.length) {
    const parts = [];
    if (missing.length) parts.push(`not in catalog: ${missing.join(', ')}`);
    if (needsReview.length) parts.push(`needs_review (review these before invoicing): ${needsReview.join(', ')}`);
    if (excluded.length) parts.push(`excluded from card orders by the seller (not goods lines): ${excluded.join(', ')}`);
    throw new EnrichSaleError('REFUSED', `Order ${order.orderId} refused, ${parts.join('; ')}`, { missing, needsReview, excluded });
  }

  let itemsC = 0; let taxC = 0;
  const lineItems = order.items.map(({ sku, qty }) => {
    const row = catalog.items[sku];
    const unitC = cents(row.unit_price);
    const unitTaxC = Math.round(unitC * order.taxRate);
    const totalC = unitC * qty;
    const lineTaxC = unitTaxC * qty;
    itemsC += totalC; taxC += lineTaxC;
    const li = {
      name: shortName(row.description),
      description: row.description.slice(0, LIMITS.description),
      kind: 'debit',
      quantity: String(qty),
      unitAmount: money(unitC),
      unitTaxAmount: money(unitTaxC),
      unitOfMeasure: row.uom_braintree,
      totalAmount: money(totalC),
      taxAmount: money(lineTaxC),
      discountAmount: '0.00',
      productCode: sku,
      commodityCode: row.unspsc,
    };
    for (const k of ['productCode', 'commodityCode', 'unitOfMeasure']) {
      if (li[k].length > LIMITS[k]) throw new EnrichSaleError('CATALOG', `${sku}: ${k} "${li[k]}" is longer than ${LIMITS[k]} characters`);
    }
    return li;
  });

  const shippingC = cents(order.shipping);
  const request = {
    amount: money(itemsC + taxC + shippingC),
    orderId: order.orderId,
    // Level 2
    purchaseOrderNumber: order.poNumber,
    taxAmount: money(taxC),
    taxExempt: false,
    // Level 3 (transaction level)
    shippingAmount: money(shippingC),
    discountAmount: '0.00',
    shipsFromPostalCode: order.shipsFromPostalCode,
    shipping: {
      streetAddress: order.shipTo.line1,
      locality: order.shipTo.city,
      region: order.shipTo.state,
      postalCode: order.shipTo.postal,
      countryCodeAlpha3: order.shipTo.country3 || 'USA',
    },
    lineItems,
    options: { submitForSettlement: true },
  };
  const v = validateRequest(request);
  if (!v.valid) throw new EnrichSaleError('VALIDATION', `Order ${order.orderId} failed validation: ${v.issues.map((i) => i.message).join('; ')}`, { issues: v.issues });
  return request;
}

module.exports = { enrichSale, loadCatalog, EnrichSaleError, DEFAULT_CATALOG };
