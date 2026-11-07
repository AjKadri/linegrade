// Data-readiness scores, built from the validator checks (src/validate.js).
//   before: what a basic Level 1 checkout sends (amount + order id only)
//   after : the same order with LineGrade's Level 2/3 data
// The score = share of applicable checks that pass. It measures whether the data is complete and
// valid, NOT whether each commodity code is the right one (that is what review and the eval are for).

const { validateRequest, validateCatalogRow, level1Payload } = require('./validate');

function orderReadiness(request) {
  const before = validateRequest(level1Payload(request));
  const after = validateRequest(request);
  return { before, after };
}

/** Share of goods rows (not excluded) that pass the row checks, versus the raw catalog (name + price only). */
function catalogReadiness(items) {
  const goods = items.filter((i) => i.status !== 'excluded');
  const valid = (row) => (row.status === 'ok' ? validateCatalogRow(row).valid : false);
  const afterOk = goods.filter(valid).length;
  const rawOk = goods.filter((i) => validateCatalogRow({ sku: i.sku, raw_name: i.raw_name, unit_price: i.unit_price }).valid).length;
  const pct = (n) => (goods.length ? Math.round((100 * n) / goods.length) : 0);
  return { rows: goods.length, before: { rowsReady: rawOk, score: pct(rawOk) }, after: { rowsReady: afterOk, score: pct(afterOk) } };
}

module.exports = { orderReadiness, catalogReadiness };
