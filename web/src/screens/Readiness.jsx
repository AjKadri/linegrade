import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Chip, Footer, Hud, LineItemBand, SectionLabel, money } from '../ui.jsx';
import { useCountUp } from '../hooks.js';

// Slider position 0..100 maps logarithmically to $50k..$5M, rounded to a tidy step. Default 50 = $500k.
const volumeAt = (t) => {
  const raw = 50000 * 100 ** (t / 100);
  const step = raw < 500000 ? 5000 : raw < 2000000 ? 25000 : 50000;
  return Math.round(raw / step) * step;
};
const money0 = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const mark = (status) => (status === 'pass' ? <span className="pass">PASS</span> : status === 'fail' ? <span className="failt">FAIL</span> : <span className="muted">—</span>);

export default function Readiness({ state, onRestart }) {
  const [data, setData] = useState(null);
  const [t, setT] = useState(50);
  useEffect(() => { api.readiness().then(setData).catch(() => setData(null)); }, []);
  const c = data?.counts;
  const after = data?.order?.after;
  const before = data?.order?.before;
  const score = useCountUp(after?.score ?? c?.score ?? 0, { enabled: !!data });
  const fee = data?.fee;
  const volume = volumeAt(t);
  const yearly = fee ? (volume * fee.rateDifference.pct) / 100 : 0; // ESTIMATE: all volume on qualifying cards

  return (
    <>
      <section className="section" style={{ position: 'relative', paddingTop: 72, paddingBottom: 56 }}>
        <Hud model={state?.modelLabel} rows={c?.total} />
        <div style={{ marginBottom: 20 }}><SectionLabel>Readiness</SectionLabel></div>
        {data && !data.demoOrder.ok && (
          <div className="banner warn" role="alert" style={{ marginBottom: 20 }}><span>The $958 demo order cannot be built right now: {data.demoOrder.refusal?.message}. Showing catalog readiness only.</span></div>
        )}
        <div className="navy score-panel">
        <div className="ba">
          <div>
            <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.08em', marginBottom: 8 }}>BEFORE · LEVEL 1 ONLY</div>
            <div className="score-before" aria-label={`Before score ${before?.score ?? 0} out of 100`}>{before?.score ?? 0}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>{before ? `${before.passed} OF ${before.total} CHECKS PASS` : '—'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.08em', marginBottom: 4 }}>AFTER · LINEGRADE</div>
              <div className="score" aria-label={`After score ${after?.score ?? 0} out of 100`}>{score}</div>
            </div>
            <div style={{ paddingBottom: 18 }}>
              <div className="mono" style={{ fontSize: 20 }}>/ 100</div>
              <h2 className="h-s" style={{ marginTop: 6 }}>Data readiness</h2>
              <p className="mono muted" style={{ fontSize: 11, maxWidth: 380, marginTop: 8, letterSpacing: '0.04em', lineHeight: 1.6 }}>
                SCORE = SHARE OF THE VALIDATOR&apos;S CHECKS THAT PASS FOR THE $958 ORDER. IT MEASURES WHETHER THE DATA IS COMPLETE AND VALID, NOT WHETHER EACH CODE IS THE RIGHT ONE.
              </p>
            </div>
          </div>
        </div>
        </div>
      </section>
      <LineItemBand variant={2} />
      <section className="section tight">
        <div className="stats draw">
          <div className="stat" style={{ '--d': '0ms' }}><div className="n">{data ? `${data.catalog.after.rowsReady}/${data.catalog.rows}` : '—'}</div><div className="k">Catalog rows ready</div></div>
          <div className="stat" style={{ '--d': '150ms' }}><div className="n">{c?.approved ?? '—'}</div><div className="k">Reviewed &amp; locked</div></div>
          <div className="stat" style={{ '--d': '300ms' }}><div className="n">{data?.level3Orders ?? '—'}</div><div className="k">Level 3 orders (sandbox)</div></div>
          <div className="stat" style={{ '--d': '450ms' }}><div className="n">{c?.needs_review ?? '—'}</div><div className="k">Still need review</div></div>
        </div>
        {data?.lastOrder && <p className="mono muted" style={{ fontSize: 11, marginTop: 12 }}>LAST ORDER {data.lastOrder.orderId} · TRANSACTION {data.lastOrder.transactionId} · {money(data.lastOrder.amount)} · SANDBOX</p>}
      </section>

      {before && after && (
        <section className="section">
          <div className="card">
            <div className="card-h"><SectionLabel>What the validator checks</SectionLabel><Chip kind="synthetic" /></div>
            <div className="tscroll">
              <table className="checks3">
                <thead><tr><th>Check</th><th style={{ textAlign: 'center' }}>Level 1</th><th style={{ textAlign: 'center' }}>LineGrade</th></tr></thead>
                <tbody>
                  {after.checks.map((ch, i) => (
                    <tr key={ch.id}><td>{ch.label}</td><td className="c">{mark(before.checks[i].status)}</td><td className="c">{mark(ch.status)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="estimate-box">
          <div className="card-h" style={{ borderBottomStyle: 'dashed' }}>
            <SectionLabel>Estimated fee</SectionLabel>
            <Chip kind="estimate" />
          </div>
          <div className="card-b">
            {fee ? (
              <>
                <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Visa purchasing / corporate card: Level 3 (Commercial Product 3) vs the card-not-present fallback</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', margin: '10px 0 6px' }}>
                  <div className="fee-main" data-testid="fee-headline" aria-label={`Estimated rate difference ${fee.rateDifference.pct} percent back on purchasing-card sales`}>≈ {fee.rateDifference.pct.toFixed(2)}% back on purchasing-card sales</div>
                  <Chip kind="estimate" />
                </div>
                <p style={{ fontSize: 13, maxWidth: 780 }}>
                  {fee.rateDifference.standardPct.toFixed(2)}% + ${fee.rateDifference.standardFixed.toFixed(2)} on the standard fallback, {fee.rateDifference.product3Pct.toFixed(2)}% + ${fee.rateDifference.product3Fixed.toFixed(2)} on Commercial Product 3. The fixed ${fee.rateDifference.product3Fixed.toFixed(2)} is the same in both, so the gap is the percentage alone.
                </p>

                <div className="vol" style={{ marginTop: 22 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
                    <label htmlFor="volume" className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Yearly business-card volume</label>
                    <span className="mono" style={{ fontSize: 20 }} data-testid="volume-value">{money0(volume)}</span>
                  </div>
                  <input id="volume" className="range" type="range" min="0" max="100" step="1" value={t} onChange={(e) => setT(Number(e.target.value))} aria-valuetext={money0(volume)} />
                  <div className="mono muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}><span>$50k</span><span>$5M</span></div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginTop: 14 }}>
                    <span className="mono" style={{ fontSize: 40, letterSpacing: '-0.02em' }} data-testid="yearly-value" aria-live="polite">≈ {money0(yearly)}</span>
                    <span className="mono muted" style={{ fontSize: 12 }}>A YEAR</span>
                    <Chip kind="estimate" />
                  </div>
                  <p className="mono muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.7, letterSpacing: '0.03em' }}>
                    PURCHASING / CORPORATE CARD CASE. ASSUMES ALL VOLUME IS ON QUALIFYING CARDS WITH VERIFIED LEVEL 3 DATA. INTERCHANGE ONLY, FOR INTERCHANGE-PLUS MERCHANTS. NOT SAVINGS ACHIEVED.
                  </p>
                </div>

                <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px dashed var(--line-strong)' }}>
                  <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Detail: the {money(fee.amount)} demo order, by card type</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', margin: '8px 0 4px' }}>
                    <div className="mono" style={{ fontSize: 28, letterSpacing: '-0.02em' }} data-testid="fee-range" aria-label={`Estimated fee difference ${fee.range.low} to ${fee.range.high} dollars`}>{fee.isRange ? `$${fee.range.low} – $${fee.range.high}` : `$${fee.range.low}`}</div>
                    <Chip kind="estimate" />
                  </div>
                  <p style={{ fontSize: 13, maxWidth: 760 }}>
                    For a purchasing or corporate card on the card-not-present fallback: <b className="mono">${fee.reference.difference}</b>.
                    The range reflects that the sandbox card is only flagged &quot;commercial&quot;, so its Visa product is unknown.
                  </p>

                  <div style={{ marginTop: 14, overflowX: 'auto', border: '1px solid var(--line)', background: 'var(--surface)', borderRadius: 'var(--radius-card)' }}>
                    <table className="checks3" style={{ minWidth: 640 }}>
                      <thead><tr><th>Card and fallback</th><th>Standard</th><th>Product 3 (Level 3)</th><th style={{ textAlign: 'right' }}>Difference · ESTIMATE</th></tr></thead>
                      <tbody>
                        {fee.scenarios.map((sc) => (
                          <tr key={sc.id}>
                            <td>{sc.label}</td>
                            <td className="mono">{sc.standard.rate} = ${sc.standard.fee}</td>
                            <td className="mono">{sc.product3.rate} = ${sc.product3.fee}</td>
                            <td className="mono" style={{ textAlign: 'right' }}>${sc.difference}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <p className="mono muted" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.7 }}>
                  SOURCE: <a href={fee.source.url} target="_blank" rel="noopener noreferrer">{fee.source.title}</a>, RATES EFFECTIVE {fee.source.effective} · ACCESSED {fee.source.accessed}. ESTIMATE FOR INTERCHANGE-PLUS MERCHANTS ONLY, NOT SAVINGS ACHIEVED. EXCLUDES PROCESSOR MARKUP AND THE PARTICIPATION FEE SOME SOURCES REPORT. THE SANDBOX NEVER SHOWS INTERCHANGE CHARGED.
                </p>
                <details style={{ marginTop: 10 }}>
                  <summary className="mono muted" style={{ fontSize: 11, cursor: 'pointer', letterSpacing: '0.04em' }}>WHERE SOURCES DISAGREE ({fee.conflicts.length}) · ALL SOURCES ({fee.sources.length})</summary>
                  <ul style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 8 }}>
                    {fee.conflicts.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                  <ul className="mono" style={{ fontSize: 11, lineHeight: 1.8, marginTop: 8, paddingLeft: 18 }}>
                    {fee.sources.map((s) => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.publisher}</a> · {s.kind} · {s.effective || s.published || s.document_date} · accessed {s.accessed}</li>)}
                  </ul>
                </details>
              </>
            ) : <div className="mono muted" style={{ fontSize: 12 }}>LOADING…</div>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <Button variant="secondary" icon="" onClick={onRestart}>Start over</Button>
        </div>
      </section>
      <Footer />
    </>
  );
}
