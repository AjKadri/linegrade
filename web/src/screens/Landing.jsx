import React, { useEffect, useState } from 'react';
import { Button, Chip, Hud, LineItemBand, SectionLabel } from '../ui.jsx';
import { prefersReducedMotion } from '../hooks.js';

// Small animated "raw name -> code" preview. The rows are REAL classifier output from the frozen demo catalog.
function HeroPreview({ samples }) {
  const [i, setI] = useState(0);
  const list = samples?.length ? samples : [];
  useEffect(() => {
    if (list.length < 2 || prefersReducedMotion()) return undefined;
    const t = setInterval(() => setI((n) => (n + 1) % list.length), 3600);
    return () => clearInterval(t);
  }, [list.length]);
  if (!list.length) return <div className="pv" aria-hidden="true"><div className="pv-b" /></div>;
  const s = list[i];
  return (
    <div className="pv" aria-label="Example: catalog name to commodity code">
      <div className="pv-h"><SectionLabel>Catalog row to line item</SectionLabel><Chip kind="synthetic" /></div>
      <div className="pv-b" aria-live="off">
        <div key={`r${i}`} className="pv-raw">{s.rawName}</div>
        <div className="pv-arrow" aria-hidden="true">↓ classify once</div>
        <div key={`o${i}`} className="pv-out">
          <div className="pv-code">{s.code}</div>
          <div style={{ fontWeight: 500 }}>{s.title}</div>
          <div className="mono muted" style={{ fontSize: 12 }}>UNIT {s.uom} · {s.description}</div>
        </div>
        <div className="pv-dots" aria-hidden="true">{list.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
      </div>
    </div>
  );
}

export default function Landing({ state, onLoad, loading }) {
  const c = state?.counts;
  return (
    <>
      <section className="hero" style={{ borderBottom: '1px solid var(--line)' }}>
        <Hud model={state?.modelLabel} rows={c?.total} />
        <div className="hero-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <SectionLabel>Invoice-grade</SectionLabel>
            <h1 className="h-xl">Invoice-grade card data for B2B sellers</h1>
            <p className="sub">
              Visa&apos;s Commercial Enhanced Data Program is built around line-item (Level 3) data on business-card payments.
              LineGrade turns a messy product catalog into that data once, so every later business-card order carries it automatically.
            </p>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button onClick={onLoad} disabled={loading}>{loading ? 'Loading…' : 'Load demo catalog'}</Button>
              <span className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em' }}>40 INVENTED PRODUCTS · NO REAL MERCHANT · NO REAL MONEY</span>
            </div>
          </div>
          <HeroPreview samples={state?.samples} />
        </div>
      </section>
      <LineItemBand variant={0} />
      <section className="section">
        <div style={{ marginBottom: 20 }}><SectionLabel>How it works</SectionLabel></div>
        <div className="diagram">
          <div className="dbox"><div className="t">input</div><div className="v">Catalog</div><div className="s">Messy names, no commodity codes, no units.</div></div>
          <div className="dbox"><div className="t">AI, once</div><div className="v">Classify + review</div><div className="s">Code, unit, specific description, confidence. You approve only the flagged rows.</div></div>
          <div className="dbox"><div className="t">every order</div><div className="v">Visa Level 3</div><div className="s">Line items attach to each business-card order by SKU.</div></div>
          <div className="dbox"><div className="t">sandbox</div><div className="v">Braintree</div><div className="s">Sent and read back. PayPal path is on the roadmap.</div></div>
        </div>
      </section>
      <LineItemBand variant={1} />
      <section className="section tight">
        <div className="stats">
          <div className="stat"><div className="n">{c?.total ?? '—'}</div><div className="k">SKUs in demo catalog</div></div>
          <div className="stat"><div className="n">{c?.ok ?? '—'}</div><div className="k">Level 3 ready</div></div>
          <div className="stat"><div className="n">{c?.needs_review ?? '—'}</div><div className="k">Need your review</div></div>
          <div className="stat"><div className="n">1×</div><div className="k">Work per catalog</div></div>
        </div>
      </section>
    </>
  );
}
