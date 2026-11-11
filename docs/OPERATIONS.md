# LineGrade operations

LineGrade runs as **one web service**: the Express API serves the built UI. Everything is **synthetic data and the Braintree sandbox**: no real money, no real merchants. Fee figures are estimates.

## 1. Expected monthly cost

| Item | Cost | Notes |
|---|---|---|
| Render web service, **Free** plan | **$0** | Hobby workspace is $0. 750 free instance hours per calendar month; one service awake all month is 744 hours, so it fits. Sleeps when idle (section 5). |
| Render **Starter** (optional, always on) | about **$7 / month** | Only if you want no sleeping. Figure from search results quoting Render's pricing page; **confirm in the Render dashboard before choosing it**. Nothing in this repo selects a paid plan. |
| LLM (OpenRouter, Haiku 5.5), live "re-run AI" | **cents** | About $0.0004 per row, so a full 40-row re-run is about $0.02. Hard cap: `LLM_DAILY_CAP_USD` (default **$2/day**, so at most about $60 in a 30-day month, and only if every day hits the cap). Also set a spending limit on the OpenRouter key itself (suggest $5). |
| Braintree sandbox | $0 | |
| Domain / CDN / database | $0 | None used. |

Expected total: **$0**, plus LLM cents. Worst case: $2 per day of LLM spend.

## 2. Deploy (done by you: it needs your Render and GitHub accounts)

1. Push this repo to GitHub. `.env`, `PLAN.md`, `HANDOFF.md`, the UNSPSC workbook and every UNSPSC-derived code list are gitignored and stay on your machine.
2. Render dashboard: **New > Blueprint**, pick the repo. It reads `render.yaml` (free plan, build command, `/health` check).
3. Enter the secrets Render asks for (`sync: false` in `render.yaml`): `LLM_API_KEY`, `BT_MERCHANT_ID`, `BT_PUBLIC_KEY`, `BT_PRIVATE_KEY`, and optionally `ADMIN_TOKEN`. **Never put them in the repo.**
4. Apply. When it is live, open `https://<service>.onrender.com/health` (expect `{"status":"ok",...}`).
5. Verify from your machine:
   ```bash
   BASE=https://<service>.onrender.com npm run screens          # full click-through, one real sandbox sale
   BASE=https://<service>.onrender.com npm run check:sessions   # two browsers at once, two sandbox sales
   BASE=https://<service>.onrender.com npm run coldstart        # cold-start time (add --wait-minutes=16 to let it sleep first)
   ```
   `npm run check:failures` starts its own local servers and needs no deployment.

## 3. Environment variables

Secrets (Render dashboard only): `LLM_API_KEY`, `BT_MERCHANT_ID`, `BT_PUBLIC_KEY`, `BT_PRIVATE_KEY`, `ADMIN_TOKEN`.
Not secret (set in `render.yaml`): `LLM_BASE_URL`, `LLM_MODEL`, `LIVE_AI`, `LLM_DAILY_CAP_USD`, `MAX_RERUNS_PER_SESSION` (2), `MAX_RERUNS_PER_DAY` (30), `MAX_PAYMENTS_PER_SESSION` (5), `MAX_PAYMENTS_PER_DAY` (200), `SESSION_IDLE_MIN` (120), `RATE_LIMIT_SESSION_PER_MIN` (180), `RATE_LIMIT_IP_PER_MIN` (600). Render sets `PORT`; the server binds `0.0.0.0` in production.

## 4. Day-to-day

- **Restart:** Render dashboard, your service, **Manual Deploy** (or the Restart option in the service menu). A restart clears every session and the daily usage counters (the disk is ephemeral). Judges mid-demo see "Your session expired" and start again from the frozen catalog.
- **Turn the live AI off** (the frozen-catalog replay keeps working, clearly labelled):
  - Set `LIVE_AI=off` in Render's environment (Render redeploys), or
  - without a redeploy, if `ADMIN_TOKEN` is set:
    ```bash
    curl -X POST https://<service>/api/admin/live-ai -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"enabled":false}'
    curl https://<service>/api/admin/status -H "Authorization: Bearer $ADMIN_TOKEN"   # usage, caps, sessions
    ```
    The switch lasts until the next restart. Or remove `LLM_API_KEY`.
- **Stop all spending quickly:** `LIVE_AI=off`, and set the OpenRouter key's limit to $0.
- **Logs:** Render dashboard, Logs. Errors are logged without request bodies or secrets.

## 5. Free tier sleeps: cold start and the "waking up" screen

From Render's docs ([Deploy for Free](https://render.com/docs/free)): a Free web service **spins down after 15 minutes without inbound traffic**; spin-up takes **"about one minute"**; Render shows a loading page to browsers meanwhile; free services have an **ephemeral filesystem**; Render **"might restart a Free web service at any time"**.

- **LineGrade's own boot is fast:** on a clean copy built with the exact `render.yaml` build command, the server answered `/health` **0.23 s** after `node server/index.js` started. A cold start on Render is therefore dominated by Render's spin-up.
- **Measured on Render itself (Wed 11 Nov 2026, after 16 idle minutes, commit acf8af7):** first `/health` after idle **12.9 s**; first page (HTML) right after, **0.6 s**; warm `/health` **0.33 s**. One measurement, so treat it as a typical figure, not a guarantee (Render's docs say about a minute). Reproduce with `BASE=https://linegrade.onrender.com npm run coldstart -- --wait-minutes=16`.
- **"Waking up" screen:** if the API stops answering (instance asleep, restarting), the UI shows a "WAKING UP THE DEMO" screen with a seconds counter and continues by itself when `/health` answers (shown in `docs/screens/failures/f8-waking-up.png`). It appears only after 1.5 s of silence, so normal loads never see it. For the very first request, Render's own loading page is what the browser shows while the app is not yet running.
- **Stay awake for free (optional):** point a free external pinger (for example cron-job.org or UptimeRobot) at `https://<service>/health` every 10 minutes. One always-awake free service is 744 hours, inside the 750 free hours, **if it is the only free web service in the workspace**. Before a judging window, also open the URL yourself 2 minutes ahead.

## 6. Keeping it up until 15 December

- Render's free docs set **no expiry for web services** (only free Postgres expires after 30 days; we use none).
- Risks to check: the 750-hour allowance (fine for one service), Render changing free-tier terms (a 2026 source mentions a plan change on 1 August: look at the dashboard), outbound traffic (we make almost none), the OpenRouter key's limit/credit, Braintree sandbox keys, and `data/rates.json` (re-read Visa's schedule before submitting).
- **Calendar:** check the service on 14 Nov, 1 Dec and 14 Dec. After 15 Dec: suspend or delete the service, revoke the Render secrets and set the OpenRouter limit to $0.

## 7. Limits and what a visitor sees

| Limit (default) | When hit |
|---|---|
| Live AI re-runs: 2 per session, 30 per day, `LLM_DAILY_CAP_USD` per day | Clear message on the Catalog screen; button disabled; **replay of the frozen catalog keeps working**. A run stops part-way if the daily budget runs out; unreached rows keep their earlier result. |
| Sandbox payments: 5 per session, 200 per day | "LIMIT REACHED" message under Pay; nothing is sent to Braintree. Duplicates of an already-charged order are still answered. |
| API requests: 180 per session per minute, 600 per address per minute | HTTP 429 with `Retry-After` and a plain message. `/health` is exempt. |
| Idle session: 2 hours | Session and its data deleted; the visitor is told and returns to the frozen catalog. |
| At most 500 sessions | The longest-idle session is dropped. |

## 8. Failure behaviour (all shown working by `npm run check:failures`)

| Failure | Behaviour |
|---|---|
| AI provider down or slow (15 s timeout, fail fast) | Run abandoned, **nothing written**, UI switches to the frozen-catalog replay labelled **REPLAY**; the attempt does not use up a live re-run. |
| Braintree unreachable (request never sent) | "BRAINTREE IS UNAVAILABLE", says nothing was charged; ledger marked `failed`; **retry is safe** and repeatable. |
| Braintree answers badly or the reply is lost | The ledger asks Braintree by order id before doing anything; if Braintree cannot be asked, no new sale is sent and the next attempt reconciles first. A second charge is impossible. |
| Bad quantity, empty order, duplicate or unknown SKU | Error next to the line in the browser; the server repeats the same checks (HTTP 400 with the field named, or a refusal naming the SKU) before any payment call. |
| Server restarts | Sessions are cleared; the UI says so and starts from the frozen catalog. |

## 9. Known limits

- Sessions, rate limits and caps live in memory/ephemeral disk of a **single instance** (the free tier cannot scale out anyway). A restart resets daily counters; the OpenRouter key limit is the backstop.
- **Render = replay only.** The UNSPSC list is (c) UNDP and is not in the repo, so on Render `/health` shows `codeList: "none"`. Live AI is disabled with the note "Live AI runs locally with the licensed UNSPSC list; this demo replays a saved run.", so Render never makes LLM calls and `LLM_API_KEY` is optional there. The Edit-code search only offers codes already in the saved catalog; typing a code that is not in it is refused with a clear message. Everything else (review, order, payment, validator, readiness, fee estimate) works from the saved catalog.
- The sandbox card is a public Braintree test number, not a secret. No card data ever reaches the browser.
