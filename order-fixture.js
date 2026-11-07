// Shared test order: a small B2B lab-supplies order paid with a company card.
// Commodity codes and units are illustrative placeholders for the test only;
// assigning real ones is the job LineGrade's AI would do.

const TAX_RATE = 0.08;

const lines = [
  { sku: 'NG-M-100', name: 'Nitrile exam gloves M 100/bx', description: 'Nitrile exam gloves, size M, powder-free, box of 100', qty: 20, unit: '12.50', uom: 'BX', commodity: '42132203' },
  { sku: 'BK-600-12', name: 'Borosilicate beaker 600mL 12pk', description: 'Borosilicate glass beaker, 600 mL, graduated, pack of 12', qty: 5, unit: '64.00', uom: 'PK', commodity: '41121802' },
  { sku: 'PT-200-96', name: 'Pipette tips 200uL rack/96', description: 'Universal pipette tips, 200 uL, racked, 96 per rack', qty: 30, unit: '9.80', uom: 'RK', commodity: '41121503' },
];

const cents = (s) => Math.round(Number(s) * 100);
const money = (c) => (c / 100).toFixed(2);

const items = lines.map((l) => {
  const total = cents(l.unit) * l.qty;
  // Per-unit tax x quantity, so PayPal's tax_total = sum(items.tax x qty) check holds to the cent.
  const unitTaxC = Math.round(cents(l.unit) * TAX_RATE);
  const tax = unitTaxC * l.qty;
  return { ...l, totalC: total, taxC: tax, total: money(total), tax: money(tax), unitTax: money(unitTaxC) };
});

const itemTotalC = items.reduce((s, i) => s + i.totalC, 0);
const taxC = items.reduce((s, i) => s + i.taxC, 0);
const shippingC = 2500;
const discountC = 0;
const dutyC = 0;
const grandC = itemTotalC + taxC + shippingC - discountC + dutyC;

module.exports = {
  poNumber: 'PO-77812',
  invoiceId: `LG-TEST-${Date.now()}`,
  shipsFromPostalCode: '60607',
  shipTo: { line1: '200 Science Park Rd', city: 'Madison', state: 'WI', postal: '53711', country2: 'US', country3: 'USA' },
  items,
  itemTotal: money(itemTotalC),
  tax: money(taxC),
  shipping: money(shippingC),
  discount: money(discountC),
  duty: money(dutyC),
  grandTotal: money(grandC),
};
