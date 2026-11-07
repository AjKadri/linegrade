import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Chip, Footer, Hud, LineItemBand, SectionLabel, money } from '../ui.jsx';
import { useCountUp } from '../hooks.js';

const mark = (status) => (status === 'pass' ? <span className="pass">PASS</span> : status === 'fail' ? <span className="failt">FAIL</span> : <span className="muted">—</span>);

export default function Readiness({ state, onRestart }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.readiness().then(setData).catch(() => setData(null)); }, []);
  const c = data?.counts;
  const after = data?.order?.after;
  const before = data?.order?.before;
  const score = useCountUp(after?.score ?? c?.score ?? 0, { enabled: !!data });
  const fee = data?.fee;

  return (
    <>
      <section className="section" style={{ position: 'relative', paddingTop: 72, paddingBottom: 56 }}>
        <Hud model={state?.modelLabel} rows={c?.total} />
        <div style={{ marginBottom: 20 }}><SectionLabel>Readiness</SectionLabel></div>
        {data && !data.demoOrder.ok && (
          <div className="banner warn" role="alert" style={{ marginBottom: 20 }}><span>The $958 demo order cannot be built right now: {data.demoOrder.refusal?.message}. Showing catalog readiness only.</span></div>
        )}
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
                <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Interchange difference on the {money(fee.amount)} order: Level 3 (Commercial Product 3) vs standard</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', margin: '10px 0 6px' }}>
                  <div className="fee-main" aria-label={`Estimated fee difference ${fee.range.low} to ${fee.range.high} dollars`}>{fee.isRange ? `$${fee.range.low} – $${fee.range.high}` : `$${fee.range.low}`}</div>
                  <Chip kind="estimate" />
                </div>
                <p style={{ fontSize: 13, maxWidth: 760 }}>
                  For a Visa purchasing or corporate card on the card-not-present fallback: <b className="mono">${fee.reference.difference}</b>.
                  The range reflects that the sandbox card is only flagged &quot;commercial&quot;, so its Visa product is unknown.
                </p>

                <div className="navy" style={{ marginTop: 18, overflowX: 'auto' }}>
                  <table className="checks3" style={{ color: '#ede8e8', minWidth: 640 }}>
                    <thead><tr><th style={{ color: '#a9acd8' }}>Card and fallback</th><th style={{ color: '#a9acd8' }}>Standard</th><th style={{ color: '#a9acd8' }}>Product 3 (Level 3)</th><th style={{ color: '#a9acd8', textAlign: 'right' }}>Difference · ESTIMATE</th></tr></thead>
                    <tbody>
                      {fee.scenarios.map((sc) => (
                        <tr key={sc.id}>
                          <td style={{ borderColor: '#23265a' }}>{sc.label}</td>
                          <td className="mono" style={{ borderColor: '#23265a' }}>{sc.standard.rate} = ${sc.standard.fee}</td>
                          <td className="mono" style={{ borderColor: '#23265a' }}>{sc.product3.rate} = ${sc.product3.fee}</td>
                          <td className="mono" style={{ borderColor: '#23265a', textAlign: 'right' }}>${sc.difference}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
