import React from 'react';
import { Button, Hud, NoiseBand, SectionLabel, Chip } from '../ui.jsx';

export default function Landing({ state, onLoad, loading }) {
  const c = state?.counts;
  return (
    <>
      <section className="hero" style={{ borderBottom: '1px solid var(--line)' }}>
        <Hud model={state?.modelLabel} rows={c?.total} />
        <SectionLabel>INVOICE-GRADE</SectionLabel>
        <h1 className="h-xl">Invoice-grade card data for B2B sellers</h1>
        <p className="sub">
          Visa&apos;s Commercial Enhanced Data Program is built around line-item (Level 3) data on business-card payments.
          LineGrade turns a messy product catalog into that data once, so every later business-card order carries it automatically.
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button icon="→" onClick={onLoad} disabled={loading}>{loading ? 'Loading…' : 'Load demo catalog'}</Button>
          <span className="mono muted" style={{ fontSize: 11, letterSpacing: '0.06em' }}>40 INVENTED PRODUCTS · NO REAL MERCHANT · NO REAL MONEY</span>
        </div>
      </section>
      <NoiseBand />
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <SectionLabel>HOW IT WORKS</SectionLabel>
          <Chip kind="synthetic" />
        </div>
        <div className="diagram">
          <div className="dbox"><div className="t">01 · input</div><div className="v">Catalog</div><div className="s">Messy names, no commodity codes, no units.</div></div>
          <div className="dbox"><div className="t">02 · AI, once</div><div className="v">Classify + review</div><div className="s">Code, unit, specific description, confidence. You approve only the flagged rows.</div></div>
          <div className="dbox"><div className="t">03 · every order</div><div className="v">Visa Level 3</div><div className="s">Line items attach to each business-card order by SKU.</div></div>
          <div className="dbox"><div className="t">04 · sandbox</div><div className="v">Braintree</div><div className="s">Sent and read back. PayPal path is on the roadmap.</div></div>
        </div>
      </section>
      <NoiseBand />
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
