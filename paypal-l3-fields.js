// Finds which part of supplementary_data triggers PayPal's 500.
// Each variant adds one piece; every order gets a unique invoice_id.
// Run: node --env-file=.env paypal-l3-bisect.js
const o = require('./order-fixture');
const { PP_CLIENT_ID, PP_CLIENT_SECRET } = process.env;
const BASE = 'https://api-m.sandbox.paypal.com';
const usd = (v) => ({ currency_code: 'USD', value: v });
const item = o.items[0]; // single line keeps the item_total mapping simple

async function token() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  return (await r.json()).access_token;
}

const addr = { address_line_1: o.shipTo.line1, admin_area_2: o.shipTo.city, admin_area_1: o.shipTo.state,
  postal_code: o.shipTo.postal, country_code: 'US' };
const lineL3 = { name: item.name, quantity: String(item.qty), unit_amount: usd(item.unit), tax: usd(item.unitTax),
  total_amount: usd(item.total) };

const VARIANTS = [
  ['A commodity_code only (8 digits)', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, commodity_code: '42132203' }] } })],
  ['B commodity_code short (4 digits)', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, commodity_code: '4213' }] } })],
  ['C unit_of_measure BX', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, unit_of_measure: 'BX' }] } })],
  ['D unit_of_measure EA', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, unit_of_measure: 'EA' }] } })],
  ['E unit_of_measure EACH', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, unit_of_measure: 'EACH' }] } })],
  ['F unit_of_measure lowercase box', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, unit_of_measure: 'box' }] } })],
  ['G both, EA + 8-digit code', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, commodity_code: '42132203', unit_of_measure: 'EA' }] } })],
  ['H description + sku (control fields)', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) }, level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr, line_items: [{ ...lineL3, description: 'Nitrile exam gloves box of 100', sku: 'NG-M-100' }] } })],
];

(async () => {
  const tk = await token();
  if (!tk) return console.log('token failed');
  for (const [label, sd] of VARIANTS) {
    const inv = `LG-BIS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tax = item.tax;
    const total = (Number(item.total) + Number(tax) + Number(o.shipping)).toFixed(2);
    const body = { intent: 'CAPTURE',
      payment_source: { card: { number: '4012888888881881', expiry: '2030-12', security_code: '123', name: 'Lab Ops', billing_address: addr } },
      purchase_units: [{ invoice_id: inv,
        amount: { currency_code: 'USD', value: total, breakdown: { item_total: usd(item.total), tax_total: usd(tax), shipping: usd(o.shipping), discount: usd('0.00') } },
        items: [{ name: item.name, quantity: String(item.qty), unit_amount: usd(item.unit), tax: usd(item.unitTax), category: 'PHYSICAL_GOODS' }],
        shipping: { name: { full_name: 'Receiving Dock' }, address: addr },
        ...(sd ? { supplementary_data: { card: sd(inv, tax) } } : {}) }] };
    const r = await fetch(`${BASE}/v2/checkout/orders`, { method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': inv }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    const issue = j.details?.[0] ? `${j.details[0].issue}${j.details[0].field ? ' @ ' + j.details[0].field : ''}` : '';
    console.log(`${r.status < 300 ? 'PASS' : 'FAIL'} ${r.status} ${j.status || ''} ${issue}  <- ${label}  (debug ${r.headers.get('paypal-debug-id')})`);
  }
  console.log('\nEach variant adds ONE field to the passing line item. A FAIL shows that field/format is what breaks it.');
})();
