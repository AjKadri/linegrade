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
  ['0 no supplementary_data', null],
  ['1 level_2 only', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) } })],
  ['2 + level_3 amounts only', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) },
    level_3: { shipping_amount: usd(o.shipping), discount_amount: usd('0.00') } })],
  ['3 + ships_from_postal_code', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) },
    level_3: { ships_from_postal_code: o.shipsFromPostalCode, shipping_amount: usd(o.shipping), discount_amount: usd('0.00') } })],
  ['4 + shipping_address', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) },
    level_3: { ships_from_postal_code: o.shipsFromPostalCode, shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr } })],
  ['5 + minimal line_items', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) },
    level_3: { ships_from_postal_code: o.shipsFromPostalCode, shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr,
      line_items: [lineL3] } })],
  ['6 + commodity_code, unit_of_measure', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) },
    level_3: { ships_from_postal_code: o.shipsFromPostalCode, shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), shipping_address: addr,
      line_items: [{ ...lineL3, commodity_code: item.commodity, unit_of_measure: item.uom }] } })],
  ['7 + duty_amount 0.00', (inv, tax) => ({ level_2: { invoice_id: inv, tax_total: usd(tax) },
    level_3: { ships_from_postal_code: o.shipsFromPostalCode, shipping_amount: usd(o.shipping), discount_amount: usd('0.00'), duty_amount: usd('0.00'), shipping_address: addr,
      line_items: [{ ...lineL3, commodity_code: item.commodity, unit_of_measure: item.uom }] } })],
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
  console.log('\nThe first FAIL after a PASS names the field that breaks it. If even variant 1 fails, PayPal sandbox rejects any Level 2/3 data on this account.');
})();
