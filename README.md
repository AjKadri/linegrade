# LineGrade dependency tests

Two scripts that answer the go/stop questions before any build starts.

| Test | Question | GO if |
|---|---|---|
| `braintree-l3-test.js` | Does the Braintree sandbox accept Level 2/3 fields and line items, return them intact, and flag a commercial card? | Sale succeeds with the commercial card and all 3 line items come back with commodity code, unit of measure and totals intact |
| `paypal-l3-test.js` | Does PayPal Orders v2 accept `supplementary_data.card.level_3` on a card payment, and does the payment complete? | Case A (3 lines) is created and captured without validation errors |

Neither sandbox shows the interchange actually charged. That gap is known: savings in the demo must be an estimate from a sourced rate table, labelled as such.

## Setup (about 20 minutes, once)

1. **Braintree sandbox:** sign up at `sandbox.braintreegateway.com` and choose **United States** as the country. Then go to the gear icon → API → API Keys and copy the Merchant ID, Public Key and Private Key.
2. **PayPal sandbox:** at `developer.paypal.com`, go to Apps & Credentials, switch to **Sandbox**, open the default app, and copy the Client ID and Secret. The default sandbox business account is US and has card processing on.
3. In this folder:
   ```bash
   cp .env.example .env    # paste the five values into .env
   npm install
   ```

## Run

```bash
npm run test:braintree
npm run test:paypal
```

Each script prints PASS/FAIL per check and a verdict at the end. If something fails, the full error details and PayPal `debug_id` are printed. Paste that output back into the chat.

## Reading the results

- **Braintree GO, PayPal GO:** build on Braintree first (richer line-item fields, commercial flag), and keep the PayPal Orders path as the second integration.
- **Braintree GO, PayPal fails:** Braintree only. That still counts as PayPal technology under the rules.
- **Braintree fails on line items:** stop and rethink LineGrade before building anything.
- **Token or signup fails:** sandbox access from your account or network is the blocker to resolve first.

Commodity codes and units in `order-fixture.js` are illustrative placeholders for the test. Assigning real ones is the job LineGrade's AI would do.
