import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Button, Chip, SectionLabel, money } from '../ui.jsx';
import { prefersReducedMotion } from '../hooks.js';

const DEMO_LINES = [{ sku: 'NLS-002', qty: 25 }, { sku: 'NLS-007', qty: 10 }, { sku: 'NLS-005', qty: 5 }];
const newOrderId = () => `LG-UI-${Date.now().toString(36).toUpperCase()}`;

function PayResult({ result, onAgain, onNext, paying }) {
  const items = result.lineItemsReturned || [];
  const [shown, setShown] = useState(prefersReducedMotion() ? items.length : 0);
  useEffect(() => {
    if (shown >= items.length) return undefined;
    const t = setTimeout(() => setShown(shown + 1), 420);
    return () => clearTimeout(t);
  }, [shown, items.length]);

  if (result.outcome === 'charged') {
    const done = shown >= items.length;
    const failed = (result.checks || []).filter((c) => !c.pass);
    return (
      <div className="card" aria-live="polite">
        <div className="card-h">
          <span className="label">/VISA DATA · READ-BACK FROM BRAINTREE</span>
          <span style={{ display: 'flex', gap: 6 }}><Chip kind="sandbox" /><Chip kind="synthetic" /></span>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          <table className="t">
            <thead><tr><th>Product</th><th>Commodity</th><th>UoM</th><th className="r">Qty</th><th className="r">Total</th><th className="r">Tax</th><th>Description</th></tr></thead>
            <tbody>
              {items.slice(0, shown).map((l) => (
                <tr key={l.productCode} className="print-in">
                  <td className="mono">{l.productCode}</td><td className="mono">{l.commodityCode}</td><td className="mono">{l.unitOfMeasure}</td>
                  <td className="r mono">{l.quantity}</td><td className="r mono">{l.totalAmount}</td><td className="r mono">{l.taxAmount}</td><td>{l.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {done && (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                <span className={`stamp${failed.length ? ' fail' : ''}`}>{failed.length ? `FAIL ${failed.length}` : `PASS ${result.checks.length}/${result.checks.length}`}</span>
                <div>
                  <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em' }}>TRANSACTION ID</div>
                  <div className="mono" style={{ fontSize: 20 }} data-testid="txn-id">{result.transactionId}</div>
                  <div className="mono muted" style={{ fontSize: 11 }}>{result.status} · {money(result.amount)} · SANDBOX</div>
                </div>
              </div>
              <table className="t">
                <thead><tr><th>Check</th><th>Sent</th><th>Braintree returned</th><th className="r">Result</th></tr></thead>
                <tbody>
                  {result.checks.map((c) => (
                    <tr key={c.check}><td>{c.check}</td><td className="mono">{c.expected}</td><td className="mono">{String(c.actual)}</td><td className={`r ${c.pass ? 'pass' : 'failt'}`}>{c.pass ? 'PASS' : 'FAIL'}</td></tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Button small variant="secondary" disabled={paying} onClick={onAgain}>Submit same order again</Button>
                <Button small icon="→" onClick={onNext}>See readiness</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const tone = result.outcome === 'already_charged' ? 'warn' : 'fail';
  let headline = 'NOT CHARGED';
  let body = (result.messages || []).join(' ');
  if (result.outcome === 'already_charged') {
    headline = 'ALREADY CHARGED — NO NEW SALE CREATED';
    body = `Order ${result.orderId} was already charged as transaction ${result.transactionId} (${money(result.amount)}). The ledger stopped a duplicate.`;
  } else if (result.outcome === 'declined') {
    headline = 'BRAINTREE REFUSED THE SALE';
    body = `${result.message}. Nothing was charged; the order can be retried.`;
  } else if (result.outcome === 'refused') {
    headline = 'ORDER REFUSED BEFORE ANY API CALL';
    body = result.refused?.message;
  } else if (result.outcome === 'charged_reply_lost') {
    headline = 'SALE WENT THROUGH, REPLY LOST'; body = `Braintree has it as ${result.transactionId}. Do not retry.`;
  } else if (result.outcome === 'unknown') {
    headline = 'RESULT UNKNOWN'; body = 'Braintree could not be checked. The next attempt with this order will reconcile first.';
  }
  return (
    <div className={`banner ${tone}`} role="alert">
      <div><div className="mono" style={{ fontWeight: 500, letterSpacing: '0.04em' }}>{headline}</div><div style={{ marginTop: 4 }}>{body}</div></div>
      {result.outcome === 'already_charged' && <Button small icon="→" onClick={onNext}>See readiness</Button>}
    </div>
  );
}

export default function Order({ catalog, onNext, onReview }) {
  const [lines, setLines] = useState(DEMO_LINES);
  const [po, setPo] = useState('PO-77812');
  const [shipping, setShipping] = useState('25.00');
  const [taxPct, setTaxPct] = useState('8');
  const [preview, setPreview] = useState(null);
  const [perr, setPerr] = useState(null);
  const [orderId, setOrderId] = useState(null);
  const [result, setResult] = useState(null);
  const [paying, setPaying] = useState(false);

  const body = useMemo(() => ({ items: lines.filter((l) => l.sku), poNumber: po, shipping, taxRatePct: taxPct }), [lines, po, shipping, taxPct]);

  useEffect(() => {
    setOrderId(null); setResult(null);
    if (!body.items.length) { setPreview(null); setPerr(null); return undefined; }
    const t = setTimeout(async () => {
      try { setPreview(await api.preview(body)); setPerr(null); } catch (e) { setPreview(null); setPerr(e.message); }
    }, 220);
    return () => clearTimeout(t);
  }, [body]);

  const pay = async (again) => {
    const id = again && orderId ? orderId : (orderId || newOrderId());
    setOrderId(id); setPaying(true); setResult(null);
    try { setResult(await api.pay({ ...body, orderId: id })); } catch (e) { setResult({ outcome: 'declined', message: e.message }); } finally { setPaying(false); }
  };

  const setLine = (i, patch) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const ok = preview?.ok;

  return (
    <section className="section" style={{ paddingTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <SectionLabel>ORDER + PAY</SectionLabel>
        <div style={{ display: 'flex', gap: 8 }}><Chip kind="synthetic" /><Chip kind="sandbox" /></div>
      </div>
      <h2 className="h-l" style={{ marginBottom: 24 }}>Place a business-card order</h2>
      <div className="order-grid">
        <div className="card">
          <div className="card-h"><span className="label">/ORDER BUILDER</span><button className="btn small secondary" onClick={() => setLines(DEMO_LINES)}>Load $958 demo order</button></div>
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
                </div>
              ))}
            </div>
            <div><Button small variant="secondary" disabled={lines.length >= 10} onClick={() => setLines([...lines, { sku: '', qty: 1 }])}>+ Add line</Button></div>
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
            <div className="card-h"><span className="label">/AS VISA SEES IT</span><span className="mono muted" style={{ fontSize: 11 }}>LEVEL 2 + LEVEL 3, AS SENT</span></div>
            <div className="card-b" style={{ padding: 0 }}>
              {perr && <div className="banner fail" style={{ margin: 16 }}><span>{perr}</span></div>}
              {preview && !ok && (
                <div className="banner warn" style={{ margin: 16 }} role="alert">
                  <div><div className="mono" style={{ fontWeight: 500 }}>ORDER CANNOT BE BUILT YET</div><div style={{ marginTop: 4 }}>{preview.refused.message}</div></div>
                  <Button small variant="secondary" onClick={onReview}>Go to review</Button>
                </div>
              )}
              {!preview && !perr && <div className="mono muted" style={{ padding: 20, fontSize: 12 }}>ADD A LINE TO SEE THE LEVEL 3 DATA.</div>}
              {ok && (
                <>
                  <dl className="kv" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
                    <dt>PO number (L2)</dt><dd className="mono">{preview.request.purchaseOrderNumber}</dd>
                    <dt>Tax amount (L2)</dt><dd className="mono">{preview.request.taxAmount}</dd>
                    <dt>Shipping (L3)</dt><dd className="mono">{preview.request.shippingAmount} · ships from {preview.request.shipsFromPostalCode}</dd>
                  </dl>
                  <table className="t">
                    <thead><tr><th>Product</th><th>Commodity</th><th>UoM</th><th className="r">Qty</th><th className="r">Unit</th><th className="r">Total</th><th className="r">Tax</th><th>Description</th></tr></thead>
                    <tbody>
                      {preview.request.lineItems.map((l) => (
                        <tr key={l.productCode}><td className="mono">{l.productCode}</td><td className="mono">{l.commodityCode}</td><td className="mono">{l.unitOfMeasure}</td><td className="r mono">{l.quantity}</td><td className="r mono">{l.unitAmount}</td><td className="r mono">{l.totalAmount}</td><td className="r mono">{l.taxAmount}</td><td>{l.description}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="totals">
                    <div><small>Items</small>{preview.totals.items}</div><div><small>Tax</small>{preview.totals.tax}</div><div><small>Shipping</small>{preview.totals.shipping}</div>
                    <div><small>Total USD</small><b style={{ fontSize: 20 }}>{preview.totals.total}</b></div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Chip kind="sandbox" /><span className="mono" style={{ fontSize: 12 }}>BRAINTREE SANDBOX · TEST CARD ••••0009 · COMMERCIAL</span></div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>The test card and all keys stay on the server. No real money moves.</div>
              </div>
              <Button icon="→" disabled={!ok || paying || (result && result.outcome === 'charged')} onClick={() => pay(false)}>{paying ? 'Charging…' : `Pay ${ok ? money(preview.totals.total) : ''} with Braintree sandbox`}</Button>
            </div>
          </div>

          {result && <PayResult result={result} paying={paying} onAgain={() => pay(true)} onNext={onNext} />}
        </div>
      </div>
    </section>
  );
}
