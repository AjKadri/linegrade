# LineGrade

LineGrade turns messy B2B catalog lines into the Level 2/3 data that card networks reward (commodity code, unit of measure, specific description), checks an order against it, and sends it to the **Braintree sandbox**. All catalog data is **SYNTHETIC** (a fictional "Northfield Lab Supply"). Fee savings are shown only as an **estimate** from a sourced rate table. Sandbox only; credentials stay on the server.

Licence: MIT (see `LICENSE`). The UNSPSC code list is (c) UNDP, **not included**, not covered by MIT: see `NOTICE`.

## Quick start (no UNSPSC list needed)
```bash
cp .env.example .env          # Braintree sandbox keys (LLM key is only needed for live AI)
npm install && npm run web:install
npm run demo                  # http://127.0.0.1:8787
npm run test:unit
```
Without the UNSPSC list the demo **replays a saved run** (labelled REPLAY) from the frozen `data/enriched-catalog.json`. "Re-run AI" is disabled ("Live AI runs locally with the licensed UNSPSC list; this demo replays a saved run."), and the Edit-code search only offers codes already in the catalog. Review, order, payment, validation, readiness and the fee estimate all work. `/health` reports `codeList: "none"`.

## Live AI locally (needs your own UNSPSC download)
1. Download the UNSPSC English workbook from https://www.unspsc.org (UNDP terms apply) and save it as `data/unspsc_english.xlsx`.
2. `node scripts/build-subset.js` writes `data/unspsc-subset.csv` (both files are gitignored). `/health` then reports `codeList: "full"`.
3. Put `LLM_API_KEY` in `.env`, restart, and "Re-run AI" is enabled (capped; see `docs/OPERATIONS.md`).

Deploying: `docs/OPERATIONS.md` (Render, replay only).

---

# Dependency tests (Braintree / PayPal sandbox)

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

## Run the demo UI (SYNTHETIC data, Braintree SANDBOX)
```bash
npm install && npm run web:install     # once
npm run demo                           # builds web/ and serves UI + API on http://127.0.0.1:8787
npm run screens                        # optional: click through in Chrome, save docs/screens/*.png
npm run test:unit                      # unit and API tests (no payment calls)
```
Needs `.env` (see `.env.example`) for the LLM key and Braintree sandbox keys, which stay on the server. The frozen `data/enriched-catalog.json` is used by default; approvals and AI re-runs work on a gitignored copy (`data/session-catalog.json`). The server resets that copy on start.
