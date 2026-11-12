import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Button, Chip, SectionLabel, money } from '../ui.jsx';
import { prefersReducedMotion } from '../hooks.js';

const DEMO_LINES = [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }];
const newOrderId = () => `LG-UI-${Date.now().toString(36).toUpperCase()}`;

const MISSING_IN_LEVEL1 = ['Line items', 'Commodity codes', 'Units of measure', 'PO number', 'Tax amount', 'Shipping and ships-from'];

// Tick that draws itself inside the PASS stamp.
const Tick = () => (
  <svg viewBox="0 0 34 34" aria-hidden="true"><path className="tick draw" d="M5 18 l8 8 l16 -19" stroke="currentColor" strokeWidth="4" fill="none" strokeLinecap="square" pathLength="20" /></svg>
);

const RAIL_NAME = { braintree: 'Braintree', paypal: 'PayPal' };
const PP_NOT_ECHOED = 'Accepted by PayPal (Level 3 sent; PayPal does not return it on read-back)';

// neutral: a Level 1 read-back. "Match" = nothing was sent and nothing came back (or the amount matches); it is not a PASS.
function ChecksTable({ checks, rail = 'braintree', neutral = false }) {
  return (
    <div className="tscroll">
      <table className="t fixed" aria-label="All read-back checks">
        <colgroup><col style={{ width: '24%' }} /><col style={{ width: '33%' }} /><col style={{ width: '33%' }} /><col style={{ width: '10%' }} /></colgroup>
        <thead><tr><th>Check</th><th>Sent</th><th>{RAIL_NAME[rail]} returned</th><th className="r">Result</th></tr></thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.check}><td>{c.check}</td><td className="mono">{c.expected}</td><td className="mono">{String(c.actual)}</td><td className={`r ${c.pass ? (neutral ? 'muted mono' : 'pass') : 'failt'}`} data-testid={neutral && c.pass ? 'match' : undefined}>{c.pass ? (neutral ? 'MATCH' : 'PASS') : 'FAIL'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The payoff, directly under the Pay button: stamp + transaction id (or the reason nothing was charged).
function Payoff({ result, paying, onAgain, onNext }) {
  const [showChecks, setShowChecks] = useState(false);
  useEffect(() => setShowChecks(false), [result]);

  const rail = result.rail || 'braintree';
  const railName = RAIL_NAME[rail];
  if (result.outcome === 'charged' && result.level === 1) {
    // A Level 1 sale: no PASS stamp. It shows what the card network was NOT given. Never claims an observed fee difference.
    return (
      <div className="payoff-wrap" aria-live="polite">
        <div className="payoff">
          <span className="stamp l1" data-testid="stamp">SENT · LEVEL 1 ONLY</span>
          <div>
            <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em' }}>{rail === 'paypal' ? 'PAYPAL CAPTURE ID' : 'TRANSACTION ID'}</div>
            <div className="mono" style={{ fontSize: 22 }} data-testid="txn-id">{result.transactionId}</div>
            <div className="mono muted" style={{ fontSize: 11 }}>{rail === 'paypal' ? `ORDER ${result.paypalOrderId} · ` : ''}{result.status} · {money(result.amount)} · SANDBOX · AMOUNT AND ORDER ID ONLY</div>
            <div style={{ fontSize: 13, marginTop: 6, maxWidth: 560 }} data-testid="l1-note">Card networks receive no line items, so this sale would fall to the standard rate (estimate).</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button small variant="secondary" icon="" onClick={() => setShowChecks(!showChecks)} aria-expanded={showChecks}>{showChecks ? 'Hide read-back' : 'Show read-back'}</Button>
            <Button small variant="secondary" icon="" disabled={paying} onClick={onAgain}>Submit same order again</Button>
            <Button small onClick={onNext}>See readiness</Button>
          </div>
        </div>
        {showChecks && <div style={{ marginTop: 14 }}><ChecksTable checks={result.checks} rail={rail} neutral /></div>}
      </div>
    );
  }
  if (result.outcome === 'charged') {
    const failed = result.checks.filter((c) => !c.pass);
    // PayPal: only claim a full read-back if PayPal really returned Level 3. Otherwise say what we know.
    const partial = rail === 'paypal' && !result.level3Echoed;
    const stampText = failed.length ? `FAIL ${failed.length}` : partial ? 'ACCEPTED' : `PASS ${result.checks.length}/${result.checks.length}`;
    return (
      <div className="payoff-wrap" aria-live="polite">
        <div className="payoff">
          <span className={`stamp${failed.length ? ' fail' : ''}`} data-testid="stamp"><Tick />{stampText}</span>
          <div>
            <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em' }}>{rail === 'paypal' ? 'PAYPAL CAPTURE ID' : 'TRANSACTION ID'}</div>
            <div className="mono" style={{ fontSize: 22 }} data-testid="txn-id">{result.transactionId}</div>
            <div className="mono muted" style={{ fontSize: 11 }}>{rail === 'paypal' ? `ORDER ${result.paypalOrderId} · ` : ''}{result.status} · {money(result.amount)} · SANDBOX · {result.checks.length - failed.length} OF {result.checks.length} CHECKS PASSED</div>
            {partial && <div className="mono" style={{ fontSize: 11, marginTop: 4 }} data-testid="pp-not-echoed">{PP_NOT_ECHOED.toUpperCase()}</div>}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button small variant="secondary" icon="" onClick={() => setShowChecks(!showChecks)} aria-expanded={showChecks}>{showChecks ? 'Hide checks' : 'Show all checks'}</Button>
            <Button small variant="secondary" icon="" disabled={paying} onClick={onAgain}>Submit same order again</Button>
            <Button small onClick={onNext}>See readiness</Button>
          </div>
        </div>
        {showChecks && <div style={{ marginTop: 14 }}><ChecksTable checks={result.checks} rail={rail} /></div>}
      </div>
    );
  }

  const tone = result.outcome === 'already_charged' || ['already_charged', 'braintree_unavailable', 'paypal_unavailable', 'blocked_other_rail', 'unknown', 'capped'].includes(result.outcome) ? 'warn' : 'fail';
  let headline = 'NOT CHARGED';
  let body = (result.messages || []).join(' ');
  if (result.outcome === 'already_charged') {
    headline = 'ALREADY CHARGED — NO NEW SALE CREATED';
    body = `Order ${result.orderId} was already charged${result.rail ? ` on ${railName}` : ''} as transaction ${result.transactionId} (${money(result.amount)}). The ledger stopped a duplicate.`;
  } else if (result.outcome === 'declined') {
    headline = `${railName.toUpperCase()} REFUSED THE ${rail === 'paypal' ? 'PAYMENT' : 'SALE'}`;
    body = `${result.message}. Nothing was charged; the order can be retried.`;
  } else if (result.outcome === 'refused') {
    headline = 'ORDER REFUSED BEFORE ANY API CALL';
    body = result.refused?.message;
  } else if (result.outcome === 'charged_reply_lost') {
    headline = 'SALE WENT THROUGH, REPLY LOST'; body = `Braintree has it as ${result.transactionId}. Do not retry.`;
  } else if (result.outcome === 'braintree_unavailable') {
    headline = 'BRAINTREE IS UNAVAILABLE';
    body = result.charged === false
      ? 'The request never reached Braintree, so nothing was charged. It is safe to try again.'
      : 'We could not check whether the earlier attempt went through, so nothing new was sent. Trying again checks Braintree first and cannot charge twice.';
  } else if (result.outcome === 'paypal_unavailable') {
    headline = 'PAYPAL IS UNAVAILABLE';
    body = result.charged === false
      ? 'The request never reached PayPal, so nothing was charged. It is safe to try again.'
      : 'PayPal did not give a clear answer. Trying again is safe: the retry carries the same idempotency key, so it cannot charge twice.';
  } else if (result.outcome === 'blocked_other_rail') {
    headline = 'AN EARLIER ATTEMPT IS UNRESOLVED ON THE OTHER RAIL'; body = result.message;
  } else if (result.outcome === 'unknown') {
    headline = 'BRAINTREE DID NOT ANSWER'; body = 'We could not confirm whether the order went through. It is safe to try again: the next attempt checks Braintree first and cannot charge twice.';
  } else if (result.outcome === 'capped') {
    headline = 'LIMIT REACHED'; body = result.message;
  }
  return (
    <div className={`banner ${tone}`} role="alert" style={{ marginTop: 16 }}>
      <div><div className="mono" style={{ fontWeight: 500, letterSpacing: '0.04em' }}>{headline}</div><div style={{ marginTop: 4 }}>{body}</div></div>
      {result.outcome === 'already_charged' && <Button small onClick={onNext}>See readiness</Button>}
      {(result.outcome === 'braintree_unavailable' || result.outcome === 'paypal_unavailable' || result.outcome === 'unknown') && <Button small variant="secondary" icon="" disabled={paying} onClick={onAgain}>Try again</Button>}
    </div>
  );
}

// After a Level 1 and a LineGrade sale of the same order: the two results next to each other. Codes and counts only.
function SameOrderTwoWays({ l1, l3, before }) {
  const lineCount = (l3.lineItemsReturned || []).length || 3;
  const full = l3.checks.every((c) => c.pass);
  const partial = (l3.rail || 'braintree') === 'paypal' && !l3.level3Echoed;
  return (
    <div className="card" data-testid="two-ways">
      <div className="card-h"><SectionLabel>Same order, two ways</SectionLabel><Chip kind="sandbox" /></div>
      <div className="two-ways">
        <div>
          <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.08em' }}>LEVEL 1</div>
          <div className="mono" style={{ fontSize: 18, marginTop: 6 }} data-testid="tw-l1-id">{l1.transactionId}</div>
          <dl className="kv" style={{ marginTop: 10 }}><dt>Line items</dt><dd className="mono">0</dd><dt>Checks</dt><dd className="mono">{before ? `${before.passed} OF ${before.total}` : '0 OF 8'}</dd></dl>
        </div>
        <div>
          <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.08em' }}>LINEGRADE</div>
          <div className="mono" style={{ fontSize: 18, marginTop: 6 }} data-testid="tw-l3-id">{l3.transactionId}</div>
          <dl className="kv" style={{ marginTop: 10 }}><dt>Line items</dt><dd className="mono">{lineCount}</dd><dt>Checks</dt><dd className="mono">{!full ? 'FAIL' : partial ? 'ACCEPTED' : `PASS ${l3.checks.length}/${l3.checks.length}`}</dd></dl>
        </div>
      </div>
    </div>
  );
}

// Line items "print" into the read-back panel one by one.
function ReadBack({ result }) {
  const railName = RAIL_NAME[result.rail || 'braintree'];
  const items = result.lineItemsReturned || [];
  const [shown, setShown] = useState(prefersReducedMotion() ? items.length : 0);
  useEffect(() => {
    if (shown >= items.length) return undefined;
    const t = setTimeout(() => setShown(shown + 1), 420);
    return () => clearTimeout(t);
  }, [shown, items.length]);
  return (
    <div className="card">
      <div className="card-h"><SectionLabel>{`Visa data read back from ${railName}`}</SectionLabel><Chip kind="sandbox" /></div>
      <div className="tscroll">
        <table className="t">
          <thead><tr><th className="nw">Product</th><th className="nw">Commodity</th><th className="nw">UoM</th><th className="r">Qty</th><th className="r">Total</th><th className="r">Tax</th><th>Description</th></tr></thead>
          <tbody>
            {items.slice(0, shown).map((l) => (
              <tr key={l.productCode} className="print-in">
                <td className="mono nw">{l.productCode}</td><td className="mono nw">{l.commodityCode}</td><td className="mono nw">{l.unitOfMeasure}</td>
                <td className="r mono">{l.quantity}</td><td className="r mono">{l.totalAmount}</td><td className="r mono">{l.taxAmount}</td><td className="wrap">{l.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Order({ catalog, state, onNext, onReview }) {
  const [lines, setLines] = useState(DEMO_LINES);
  const [po, setPo] = useState('PO-77812');
  const [shipping, setShipping] = useState('25.00');
  const [taxPct, setTaxPct] = useState('8');
  const [preview, setPreview] = useState(null);
  const [perr, setPerr] = useState(null);
  const [orderId, setOrderId] = useState(null);
  const [sales, setSales] = useState({ 1: null, 3: null }); // the latest result shown for the Level 1 and the LineGrade sale of the current order
  const [charged, setCharged] = useState({ 1: null, 3: null }); // the sales that really went through (a later duplicate answer must not hide them)
  const [paying, setPaying] = useState(false);
  const railOn = !!state?.limits?.rails?.paypal; // the PayPal rail only exists when the server has its credentials
  const [rail, setRail] = useState('braintree');
  const view0 = 'without';
  const [view, setView] = useState(view0); // default: what a basic Level 1 checkout sends
  const [paymentsLeft, setPaymentsLeft] = useState(state?.limits?.paymentsLeft ?? null);

  // Input checks in the browser, with the same wording as the server's, so mistakes show next to the line.
  const lineErrors = useMemo(() => lines.map((l, i) => {
    if (!l.sku) return null; // an empty SKU row is ignored until it is filled in
    if (l.qty === '' || l.qty === null || !Number.isFinite(Number(l.qty))) return `Line ${i + 1} (${l.sku}): enter a quantity.`;
    if (!Number.isInteger(Number(l.qty))) return `Line ${i + 1} (${l.sku}): quantity must be a whole number.`;
    if (Number(l.qty) < 1 || Number(l.qty) > 1000) return `Line ${i + 1} (${l.sku}): quantity must be from 1 to 1000.`;
    if (lines.findIndex((x) => x.sku === l.sku) !== i) return `Line ${i + 1}: ${l.sku} appears twice. Combine the quantities.`;
    return null;
  }), [lines]);
  const problems = lineErrors.filter(Boolean);
  // The demo order is already loaded; the button only appears once the order has been edited.
  const isDemo = po === 'PO-77812' && Number(shipping) === 25 && Number(taxPct) === 8
    && JSON.stringify(lines.filter((l) => l.sku).map((l) => [l.sku, Number(l.qty)]).sort()) === JSON.stringify(DEMO_LINES.map((l) => [l.sku, l.qty]).sort());
  const resetDemo = () => { setLines(DEMO_LINES); setPo('PO-77812'); setShipping('25.00'); setTaxPct('8'); };
  const filled = lines.filter((l) => l.sku);
  const body = useMemo(() => ({ items: filled, poNumber: po, shipping, taxRatePct: taxPct, rail }), [lines, po, shipping, taxPct, rail]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setOrderId(null); setSales({ 1: null, 3: null }); setCharged({ 1: null, 3: null });
    if (!body.items.length || problems.length) { setPreview(null); setPerr(null); return undefined; }
    const t = setTimeout(async () => {
      try { setPreview(await api.preview(body)); setPerr(null); } catch (e) { setPreview(null); setPerr(e.message); }
    }, 220);
    return () => clearTimeout(t);
  }, [body]);

  const level = view === 'with' ? 3 : 1; // paying sends what the selected view shows
  const result = sales[level];
  const setResult = (r) => { setSales((x) => ({ ...x, [level]: r })); if (r && r.outcome === 'charged') setCharged((x) => ({ ...x, [level]: r })); };
  const pay = async (again) => {
    const id = again && orderId ? orderId : (orderId || newOrderId());
    setOrderId(id); setPaying(true); setResult(null);
    try {
      const r = await api.pay({ ...body, orderId: id, level });
      setResult(r);
      if (typeof r.paymentsLeft === 'number') setPaymentsLeft(r.paymentsLeft);
    } catch (e) {
      // A cap, a rate limit or a server problem: say so plainly. Nothing was charged.
      setResult({ outcome: e instanceof ApiError && (e.cap || e.code === 'RATE_LIMIT') ? 'capped' : 'unknown_error', message: e.message });
    } finally { setPaying(false); }
  };

  const setLine = (i, patch) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const ok = preview?.ok && !problems.length;
  const paid = result?.outcome === 'charged';
  const v = ok ? preview.validation : null;
  const ppUnit = (l) => (rail === 'paypal' ? ((preview?.paypal?.uomNotes || []).find((n) => n.sku === l.productCode)?.sent || '(omitted)') : l.unitOfMeasure);
  const railName = RAIL_NAME[rail];

  return (
    <section className="section" style={{ paddingTop: 28 }}>
      <div style={{ marginBottom: 16 }}><SectionLabel>Order + pay</SectionLabel></div>
      <h2 className="h-l" style={{ marginBottom: 24 }}>Place a business-card order</h2>
      <div className="order-grid">
        <div className="card">
          <div className="card-h"><SectionLabel>Order builder</SectionLabel>{!isDemo && <button className="btn small secondary" onClick={resetDemo}>Reset to $958 demo order</button>}</div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="lines">
              {lines.map((l, i) => (
                <div className="line" key={i}>
                  <label className="field"><span>{i === 0 ? 'SKU' : ' '}</span>
                    <select className="select" value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} aria-label={`Line ${i + 1} SKU`}>
                      <option value="">Choose a SKU…</option>
                      {catalog.items.map((it) => <option key={it.sku} value={it.sku} disabled={it.status !== 'ok'}>{it.sku} · {it.raw_name}{it.status === 'ok' ? '' : it.status === 'excluded' ? ' (excluded)' : ' (needs review)'}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>{i === 0 ? 'Qty' : ' '}</span><input className="input mono" type="number" min="1" max="1000" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })} aria-label={`Line ${i + 1} quantity`} /></label>
                  <button className="x-btn" onClick={() => setLines(lines.filter((_, k) => k !== i))} aria-label={`Remove line ${i + 1}`}>×</button>
                  {lineErrors[i] && <div className="field-error" role="alert" style={{ gridColumn: '1 / -1' }}>{lineErrors[i]}</div>}
                </div>
              ))}
            </div>
            <div><Button small variant="secondary" icon="" disabled={lines.length >= 10} onClick={() => setLines([...lines, { sku: '', qty: 1 }])}>+ Add line</Button></div>
            <div className="grid3">
              <label className="field"><span>PO number</span><input className="input mono" value={po} maxLength={17} onChange={(e) => setPo(e.target.value)} /></label>
              <label className="field"><span>Shipping $</span><input className="input mono" value={shipping} onChange={(e) => setShipping(e.target.value)} /></label>
              <label className="field"><span>Tax %</span><input className="input mono" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} /></label>
            </div>
            <dl className="kv"><dt>Ship to</dt><dd>200 Science Park Rd, Madison WI 53711 <span className="muted">(invented address)</span></dd><dt>Ships from</dt><dd className="mono">60607</dd></dl>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div className="card">
            <div className="card-h">
              <SectionLabel>As Visa sees it</SectionLabel>
              {view === 'without' ? <Chip kind="level l1">Level 1 · standard rate</Chip> : <Chip kind="level">Level 3 · LineGrade data</Chip>}
            </div>
            <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
              <div className="seg" role="group" aria-label="What Visa receives">
                <button aria-pressed={view === 'without'} onClick={() => setView('without')}>Without LineGrade</button>
                <button aria-pressed={view === 'with'} onClick={() => setView('with')}>With LineGrade</button>
              </div>
              {v && <span className="mono muted" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
                DATA READINESS {view === 'without' ? `${v.before.score} / 100 · ${v.before.passed} OF ${v.before.total} CHECKS` : `${v.after.score} / 100 · ${v.after.passed} OF ${v.after.total} CHECKS`}
              </span>}
            </div>
            <div className="card-b" style={{ padding: 0 }}>
              {perr && <div className="banner fail" style={{ margin: 16 }}><span>{perr}</span></div>}
              {preview && preview.ok === false && preview.refused && (
                <div className="banner warn" style={{ margin: 16 }} role="alert">
                  <div><div className="mono" style={{ fontWeight: 500 }}>ORDER CANNOT BE BUILT YET</div><div style={{ marginTop: 4 }}>{preview.refused.message}</div></div>
                  <Button small variant="secondary" icon="" onClick={onReview}>Go to review</Button>
                </div>
              )}
              {!preview && !perr && !problems.length && <div className="mono muted" style={{ padding: 20, fontSize: 12 }} data-testid="empty-order">{filled.length ? 'LOADING…' : 'ADD AT LEAST ONE LINE TO THE ORDER TO SEE WHAT VISA RECEIVES.'}</div>}
              {problems.length > 0 && <div className="banner warn" role="alert" style={{ margin: 16 }} data-testid="order-problems"><span>Fix the highlighted line{problems.length > 1 ? 's' : ''} to see the order: {problems[0]}</span></div>}
              {ok && view === 'without' && (
                <div key="without">
                  <dl className="kv" style={{ padding: '14px 16px' }}>
                    <dt>Amount</dt><dd className="mono">{preview.level1.amount} USD</dd>
                    <dt>Order total</dt><dd className="mono">{preview.level1.amount} USD</dd>
                  </dl>
                  <div className="missing" aria-label="Not sent with Level 1">
                    {MISSING_IN_LEVEL1.map((m) => (<React.Fragment key={m}><b>{m}</b><span>not sent</span></React.Fragment>))}
                  </div>
                </div>
              )}
              {ok && view === 'with' && (
                <div key="with">
                  <dl className="kv" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
                    <dt>PO number (L2)</dt><dd className="mono print-in">{preview.request.purchaseOrderNumber}</dd>
                    <dt>Tax amount (L2)</dt><dd className="mono print-in" style={{ '--d': '60ms' }}>{preview.request.taxAmount}</dd>
                    <dt>Shipping (L3)</dt><dd className="mono print-in" style={{ '--d': '120ms' }}>{preview.request.shippingAmount} · ships from {preview.request.shipsFromPostalCode}</dd>
                  </dl>
                  <div className="tscroll">
                    <table className="t">
                      <thead><tr><th className="nw">Product</th><th className="nw">Commodity</th><th className="nw">UoM</th><th className="r">Qty</th><th className="r">Unit</th><th className="r">Total</th><th className="r">Tax</th><th>Description</th></tr></thead>
                      <tbody>
                        {preview.request.lineItems.map((l, i) => (
                          <tr key={l.productCode} className="print-in" style={{ '--d': `${200 + i * 160}ms` }}><td className="mono nw">{l.productCode}</td><td className="mono nw">{l.commodityCode}</td><td className="mono nw">{ppUnit(l)}</td><td className="r mono">{l.quantity}</td><td className="r mono">{l.unitAmount}</td><td className="r mono">{l.totalAmount}</td><td className="r mono">{l.taxAmount}</td><td className="wrap">{l.description}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="totals">
                    <div><small>Items</small>{preview.totals.items}</div><div><small>Tax</small>{preview.totals.tax}</div><div><small>Shipping</small>{preview.totals.shipping}</div>
                    <div><small>Total USD</small><b style={{ fontSize: 20 }}>{preview.totals.total}</b></div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-b">
              {railOn && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
                  <SectionLabel>Payment rail</SectionLabel>
                  <div className="seg" role="group" aria-label="Payment rail">
                    <button aria-pressed={rail === 'braintree'} disabled={paying} onClick={() => setRail('braintree')}>Braintree</button>
                    <button aria-pressed={rail === 'paypal'} disabled={paying} onClick={() => setRail('paypal')}>PayPal</button>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Chip kind="sandbox" /><span className="mono" style={{ fontSize: 12 }} data-testid="rail-line">{rail === 'paypal' ? 'PAYPAL SANDBOX · TEST CARD ••••1881' : 'BRAINTREE SANDBOX · TEST CARD ••••0009 · COMMERCIAL'}</span></div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>The test card and all keys stay on the server. No real money moves.{paymentsLeft !== null && <span className="mono" data-testid="payments-left"> · SANDBOX PAYMENTS LEFT THIS SESSION: {paymentsLeft} OF {state?.limits?.paymentsMax}</span>}</div>
                  {rail === 'paypal' && <div className="muted" style={{ fontSize: 12, marginTop: 6 }} data-testid="pp-commercial-note">PayPal’s sandbox returns no card BIN data, so this rail does not claim the card was detected as commercial. Units are sent as PayPal words (BOX, PACK, CASE); a unit PayPal does not accept is left out.</div>}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  {!sales[1] && !sales[3] && <Button variant="secondary" onClick={onNext} disabled={paying}>Skip to readiness</Button>}
                  {paid
                    ? <Button icon="✓" disabled>Paid</Button>
                    : <Button disabled={!ok || paying} onClick={() => pay(false)}>{paying ? 'Charging…' : level === 1 ? `Pay ${ok ? money(preview.totals.total) : ''} · Level 1 only` : `Pay ${ok ? money(preview.totals.total) : ''} with LineGrade data`}</Button>}
                </div>
              </div>
              {result && <Payoff result={result} paying={paying} onAgain={() => pay(true)} onNext={onNext} />}
            </div>
          </div>

          {paid && result.level !== 1 && <ReadBack result={result} />}
          {charged[1] && charged[3] && <SameOrderTwoWays l1={charged[1]} l3={charged[3]} before={preview?.validation?.before} />}
        </div>
      </div>
    </section>
  );
}
