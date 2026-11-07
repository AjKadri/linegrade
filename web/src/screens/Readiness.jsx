import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Chip, Footer, Hud, NoiseBand, SectionLabel, money } from '../ui.jsx';
import { useCountUp } from '../hooks.js';

export default function Readiness({ state, onRestart }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.readiness().then(setData).catch(() => setData(null)); }, []);
  const c = data?.counts;
  const score = useCountUp(c?.score ?? 0, { enabled: !!c });
  return (
    <>
      <section className="section" style={{ position: 'relative', paddingTop: 72, paddingBottom: 56 }}>
        <Hud model={state?.modelLabel} rows={c?.total} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          <SectionLabel>READINESS</SectionLabel><Chip kind="synthetic" />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
          <div className="score" aria-label={`Data readiness score ${c?.score ?? 0} out of 100`}>{score}</div>
          <div style={{ paddingBottom: 18 }}>
            <div className="mono" style={{ fontSize: 20 }}>/ 100</div>
            <h2 className="h-s" style={{ marginTop: 6 }}>Data readiness</h2>
            <p className="mono muted" style={{ fontSize: 11, maxWidth: 360, marginTop: 8, letterSpacing: '0.04em' }}>
              SHARE OF GOODS ROWS THAT ARE LEVEL 3 READY (CODE, UNIT, SPECIFIC DESCRIPTION). PROVISIONAL FORMULA, REPLACED BY THE VALIDATOR IN M3.
            </p>
          </div>
        </div>
      </section>
      <NoiseBand />
      <section className="section tight">
        <div className="stats draw">
          <div className="stat" style={{ '--d': '0ms' }}><div className="n">{c ? `${c.ok}/${c.total - c.excluded}` : '—'}</div><div className="k">Rows OK</div></div>
          <div className="stat" style={{ '--d': '150ms' }}><div className="n">{c?.approved ?? '—'}</div><div className="k">Reviewed &amp; locked</div></div>
          <div className="stat" style={{ '--d': '300ms' }}><div className="n">{data?.level3Orders ?? '—'}</div><div className="k">Level 3 orders (sandbox)</div></div>
          <div className="stat" style={{ '--d': '450ms' }}><div className="n">{c?.needs_review ?? '—'}</div><div className="k">Still need review</div></div>
        </div>
        {data?.lastOrder && <p className="mono muted" style={{ fontSize: 11, marginTop: 12 }}>LAST ORDER {data.lastOrder.orderId} · TRANSACTION {data.lastOrder.transactionId} · {money(data.lastOrder.amount)} · SANDBOX</p>}
      </section>
      <section className="section">
        <div className="estimate-box">
          <div className="card-h" style={{ borderBottomStyle: 'dashed' }}>
            <span className="label">/ESTIMATED FEE · STANDARD VS CEDP PRODUCT 3</span>
            <Chip kind="estimate">ESTIMATE — SOURCE PENDING</Chip>
          </div>
          <div className="card-b">
            <div className="navy" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {[['Standard commercial rate', '$ —.—'], ['CEDP Product 3 rate', '$ —.—'], ['Difference on the $958 order', '$ —.—']].map(([k, v], i) => (
                <div key={k} style={{ padding: '22px 24px', borderRight: i < 2 ? '1px dashed #3a3d80' : 0 }}>
                  <div className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: '#a9acd8', textTransform: 'uppercase' }}>{k}</div>
                  <div className="mono" style={{ fontSize: 28, marginTop: 6 }}>{v}</div>
                  <div style={{ marginTop: 8 }}><Chip kind="estimate" /></div>
                </div>
              ))}
            </div>
            <p className="mono muted" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.7, letterSpacing: '0.03em' }}>
              PLACEHOLDER: NO RATES ARE SHOWN YET. THE SOURCED VISA RATE TABLE, ITS DATE AND ITS LIMITS ARRIVE WITH M3. WHEN THEY DO, THESE ARE ESTIMATES FOR INTERCHANGE-PLUS MERCHANTS ONLY, NOT SAVINGS ACTUALLY ACHIEVED. THE SANDBOX NEVER SHOWS INTERCHANGE CHARGED.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <Button variant="secondary" onClick={onRestart}>Start over</Button>
        </div>
      </section>
      <Footer />
    </>
  );
}
