// LineGrade dependency test 1 (Braintree sandbox)
// Q1: Does transaction.sale accept Level 2/3 fields + line items?
// Q2: Do the line items come back intact (commodity code, unit of measure)?
// Q3: Does the sandbox flag the commercial test card as Commercial: Yes?
//
// Run: npm install && npm run test:braintree   (needs .env, see .env.example)

if (require.main === module) {
  const braintree = require('braintree');
  const o = require('./order-fixture');

  const { BT_MERCHANT_ID, BT_PUBLIC_KEY, BT_PRIVATE_KEY } = process.env;
  if (!BT_MERCHANT_ID || !BT_PUBLIC_KEY || !BT_PRIVATE_KEY) {
    console.error('Missing BT_* values in .env');
    process.exit(1);
  }

  const gateway = new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,
    merchantId: BT_MERCHANT_ID,
    publicKey: BT_PUBLIC_KEY,
    privateKey: BT_PRIVATE_KEY,
  });

  // From Braintree's testing docs: 4009040000000009 -> Commercial: Yes; 4111111111111111 -> standard Visa.
  const CARDS = [
    { label: 'Commercial test card', number: '4009040000000009' },
    { label: 'Standard Visa (control)', number: '4111111111111111' },
  ];

  function saleRequest(cardNumber) {
    return {
      amount: o.grandTotal,
      creditCard: { number: cardNumber, expirationDate: '12/2030', cvv: '123', cardholderName: 'Lab Ops Purchasing' },
      orderId: o.invoiceId,
      // Level 2
      purchaseOrderNumber: o.poNumber,
      taxAmount: o.tax,
      taxExempt: false,
      // Level 3 (transaction level)
      shippingAmount: o.shipping,
      discountAmount: o.discount,
      shipsFromPostalCode: o.shipsFromPostalCode,
      shipping: {
        streetAddress: o.shipTo.line1,
        locality: o.shipTo.city,
        region: o.shipTo.state,
        postalCode: o.shipTo.postal,
        countryCodeAlpha3: o.shipTo.country3,
      },
      // Level 3 line items
      lineItems: o.items.map((i) => ({
        name: i.name,
        description: i.description,
        kind: 'debit',
        quantity: String(i.qty),
        unitAmount: i.unit,
        unitTaxAmount: i.unitTax,
        unitOfMeasure: i.uom,
        totalAmount: i.total,
        taxAmount: i.tax,
        discountAmount: '0.00',
        productCode: i.sku,
        commodityCode: i.commodity,
      })),
      options: { submitForSettlement: true },
    };
  }

  function check(label, ok, detail = '') {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
    return ok;
  }

  async function runCard(card) {
    console.log(`\n=== ${card.label} (${card.number.slice(0, 6)}...) ===`);
    const result = await gateway.transaction.sale(saleRequest(card.number));
    if (!result.success) {
      console.log('  FAIL  sale rejected:', result.message);
      const errs = result.errors ? result.errors.deepErrors() : [];
      for (const e of errs) console.log(`        ${e.attribute} [${e.code}] ${e.message}`);
      return { accepted: false };
    }
    const id = result.transaction.id;
    console.log(`  PASS  sale accepted, id=${id}, status=${result.transaction.status}`);

    const tx = await gateway.transaction.find(id);
    check('PO number stored', tx.purchaseOrderNumber === o.poNumber, tx.purchaseOrderNumber);
    check('tax amount stored', tx.taxAmount === o.tax, tx.taxAmount);
    check('shipping amount stored', tx.shippingAmount === o.shipping, tx.shippingAmount);
    check('ships-from postal stored', tx.shipsFromPostalCode === o.shipsFromPostalCode, tx.shipsFromPostalCode);

    const cc = tx.creditCard || {};
    console.log('  card indicators:', JSON.stringify({
      commercial: cc.commercial, purchase: cc.purchase, corporate: cc.corporate, business: cc.business,
      debit: cc.debit, prepaid: cc.prepaid, productId: cc.productId, cardType: cc.cardType,
    }));

    const li = await gateway.transactionLineItem.findAll(id);
    const roundTrip = li.length === o.items.length && o.items.every((want, k) =>
      li[k] && li[k].commodityCode === want.commodity && li[k].unitOfMeasure === want.uom && li[k].totalAmount === want.total);
    check(`line items returned (${li.length}/${o.items.length}) with commodity code + UoM + totals intact`, roundTrip);
    if (!roundTrip) console.log('        returned:', JSON.stringify(li, null, 2));
    return { accepted: true, roundTrip, commercial: cc.commercial };
  }

  (async () => {
    console.log(`Order ${o.invoiceId}: items ${o.itemTotal} + tax ${o.tax} + shipping ${o.shipping} = ${o.grandTotal} USD`);
    const out = [];
    for (const c of CARDS) {
      try { out.push(await runCard(c)); } catch (e) { console.log('  ERROR', e.type || e.name, e.message); out.push({ accepted: false }); }
    }
    const [commercial] = out;
    console.log('\n=== Verdict (Braintree) ===');
    const go = commercial.accepted && commercial.roundTrip;
    console.log(go
      ? 'GO: sandbox accepts and returns full Level 3 data.'
      : 'STOP/RETHINK: Level 3 payload not accepted or not returned intact. See errors above.');
    console.log(commercial.commercial === 'Yes'
      ? 'Commercial flag works: the demo can branch on "is this a business card?".'
      : `Commercial flag came back as "${commercial.commercial}": the demo will need the card type supplied manually.`);
    console.log('Known gap: the sandbox never shows the interchange actually charged. Savings must be an estimate from a sourced rate table.');
  })();
}
