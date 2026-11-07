// LineGrade dependency test 2 (PayPal Orders v2 sandbox, card payments)
// Q1: Does create-order accept purchase_units[].supplementary_data.card.level_2/level_3?
// Q2: Does the order complete, and is supplementary_data visible when the order is read back?
// Q3: What card details (type, BIN data) come back?
// Case B repeats with a single line item, because PayPal's docs map
// level_3.line_items[0].total_amount to amount.breakdown.item_total, which may
// only validate for one line.
//
// Run: npm run test:paypal   (no npm packages needed; uses built-in fetch)

if (require.main === module) {
  const o = require('./order-fixture');
  const { PP_CLIENT_ID, PP_CLIENT_SECRET } = process.env;
  if (!PP_CLIENT_ID || !PP_CLIENT_SECRET) {
    console.error('Missing PP_* values in .env');
    process.exit(1);
  }
  const BASE = 'https://api-m.sandbox.paypal.com';
  const CARD = { number: '4012888888881881', expiry: '2030-12', security_code: '123', name: 'Lab Ops Purchasing' };

  async function token() {
    const r = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(j)}`);
    return j.access_token;
  }

  async function api(tk, method, path, body) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tk}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': `lg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json, debugId: r.headers.get('paypal-debug-id') };
  }

  const usd = (v) => ({ currency_code: 'USD', value: v });

  function buildOrder(items, withL3 = true, card = CARD) {
    const itemTotal = items.reduce((s, i) => s + i.totalC, 0) / 100;
    const tax = items.reduce((s, i) => s + i.taxC, 0) / 100;
    const total = (itemTotal + tax + Number(o.shipping)).toFixed(2);
    const shipAddr = {
      address_line_1: o.shipTo.line1, admin_area_2: o.shipTo.city, admin_area_1: o.shipTo.state,
      postal_code: o.shipTo.postal, country_code: o.shipTo.country2,
    };
    return {
      intent: 'CAPTURE',
      payment_source: { card: { ...card, billing_address: shipAddr } },
      purchase_units: [{
        reference_id: o.poNumber,
        invoice_id: `${o.invoiceId}-${items.length}`,
        amount: {
          currency_code: 'USD',
          value: total,
          breakdown: {
            item_total: usd(itemTotal.toFixed(2)),
            tax_total: usd(tax.toFixed(2)),
            shipping: usd(o.shipping),
            discount: usd(o.discount),
          },
        },
        items: items.map((i) => ({
          name: i.name, description: i.description, sku: i.sku, quantity: String(i.qty),
          unit_amount: usd(i.unit), tax: usd(i.unitTax), category: 'PHYSICAL_GOODS',
        })),
        shipping: { name: { full_name: 'Receiving Dock' }, address: shipAddr },
        supplementary_data: withL3 ? {
          card: {
            level_2: { invoice_id: `${o.invoiceId}-${items.length}`, tax_total: usd(tax.toFixed(2)) },
            level_3: {
              ships_from_postal_code: o.shipsFromPostalCode,
              shipping_amount: usd(o.shipping),
              duty_amount: usd(o.duty),
              discount_amount: usd(o.discount),
              shipping_address: shipAddr,
              line_items: items.map((i) => ({
                name: i.name, description: i.description, quantity: String(i.qty),
                unit_amount: usd(i.unit), tax: usd(i.unitTax),
                commodity_code: i.commodity, unit_of_measure: i.uom,
                discount_amount: usd('0.00'), total_amount: usd(i.total),
              })),
            },
          },
        } : undefined,
      }],
    };
  }

  async function runCase(tk, label, items, withL3 = true, card = CARD) {
    console.log(`\n=== ${label} (${items.length} line item${items.length > 1 ? 's' : ''}) ===`);
    const created = await api(tk, 'POST', '/v2/checkout/orders', buildOrder(items, withL3, card));
    if (created.status >= 300) {
      console.log(`  FAIL  create order ${created.status} (debug_id ${created.debugId})`);
      console.log('       ', JSON.stringify(created.json.details || created.json, null, 2));
      return { accepted: false };
    }
    let order = created.json;
    console.log(`  PASS  order created id=${order.id} status=${order.status}`);
    if (order.status === 'APPROVED') {
      const cap = await api(tk, 'POST', `/v2/checkout/orders/${order.id}/capture`, {});
      if (cap.status >= 300) {
        console.log(`  FAIL  capture ${cap.status} (debug_id ${cap.debugId})`, JSON.stringify(cap.json.details || cap.json));
        return { accepted: true, captured: false };
      }
      order = cap.json;
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    console.log(`  ${capture?.status === 'COMPLETED' ? 'PASS' : 'INFO'}  capture status=${capture?.status} id=${capture?.id}`);

    const got = await api(tk, 'GET', `/v2/checkout/orders/${order.id}`);
    const sd = got.json?.purchase_units?.[0]?.supplementary_data;
    const lines = sd?.card?.level_3?.line_items || [];
    console.log(`  ${sd ? 'PASS' : 'INFO'}  supplementary_data on read-back: ${sd ? `present, ${lines.length} level_3 line(s)` : 'not returned'}`);
    if (lines[0]) console.log(`        first line: commodity_code=${lines[0].commodity_code} uom=${lines[0].unit_of_measure}`);
    console.log('        card details:', JSON.stringify(got.json?.payment_source?.card || {}));
    return { accepted: true, captured: capture?.status === 'COMPLETED', echoed: Boolean(sd) };
  }

  (async () => {
    try {
      const tk = await token();
      console.log('PASS  sandbox token obtained (account access works from this network)');
      const ctrl = await runCase(tk, 'Control 1: no Level 3, card 4012888888881881', o.items, false);
      const ctrl2 = await runCase(tk, 'Control 2: no Level 3, card 4012000077777777', o.items, false, { ...CARD, number: '4012000077777777' });
      if (!ctrl.accepted && !ctrl2.accepted) {
        console.log('\n=== Verdict (PayPal Orders v2) ===');
        console.log('Card payments themselves fail on this sandbox app, with no Level 3 involved. Check Apps & Credentials -> your app -> Features: "Advanced Credit and Debit Card Payments" must be on, and the app must belong to the US business account. Level 3 is untested, not rejected.');
        return;
      }
      const single = await runCase(tk, 'Case B', o.items.slice(0, 1));
      console.log('\n=== Verdict (PayPal Orders v2) ===');
      if (multi.accepted && multi.captured) console.log('GO: multi-line Level 3 payload accepted and the payment completed.');
      else if (single.accepted && single.captured) console.log('PARTIAL: only the single-line payload passed validation. Check Case A errors before relying on this path.');
      else console.log('Plain card orders work but Level 3 orders fail: the Level 3 block is the cause on this path. Braintree stays the primary integration.');
      if ((multi.accepted || single.accepted) && !(multi.echoed || single.echoed)) {
        console.log('Note: accepted but not echoed back. PayPal may pass it to the processor silently; the demo cannot prove it from the API alone.');
      }
    } catch (e) {
      console.log('ERROR', e.message);
      console.log('If this is a token/network error, sandbox access from your network/account is the blocker to resolve first.');
    }
  })();
}
