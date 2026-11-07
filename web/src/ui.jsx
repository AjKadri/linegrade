import React, { useEffect, useMemo, useState } from 'react';
import { prefersReducedMotion } from './hooks.js';

export function LogoMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" fill="currentColor" opacity="0.08" />
      <rect x="6" y="8" width="20" height="3" fill="currentColor" />
      <rect x="6" y="14.5" width="14" height="3" fill="currentColor" />
      <rect x="6" y="21" width="8" height="3" fill="#4b3fe0" />
    </svg>
  );
}

export function SectionLabel({ children }) { return <span className="label">/{children}</span>; }

const CHIP = { ok: 'OK', review: 'NEEDS REVIEW', fail: 'FAILED', estimate: 'ESTIMATE', synthetic: 'SYNTHETIC DATA', sandbox: 'SANDBOX', excluded: 'EXCLUDED' };
export function Chip({ kind, children, flip }) {
  return <span className={`chip ${kind}${flip ? ' flip' : ''}`}>{children ?? CHIP[kind]}</span>;
}

export function StatusChip({ item, flip }) {
  if (item.status === 'excluded') return <Chip kind="excluded" flip={flip} />;
  if (item.status === 'ok') return <Chip kind="ok" flip={flip} />;
  return <Chip kind="review" flip={flip} />;
}

export function Button({ variant = 'primary', icon, children, small, ...rest }) {
  return (
    <button className={`btn ${variant}${small ? ' small' : ''}`} {...rest}>
      {children}
      {icon ? <span className="ico" aria-hidden="true">{icon}</span> : null}
    </button>
  );
}

export function Orb({ working }) { return <div className={`orb ${working ? 'working' : 'idle'}`} role="img" aria-label={working ? 'AI is working' : 'AI idle'} />; }

export function Hud({ model, rows, where = 'SANDBOX · BRAINTREE' }) {
  return (
    <>
      <div className="hud tl">LINEGRADE · <b>INVOICE-GRADE</b></div>
      <div className="hud tr">{where}</div>
      <div className="hud bl">MODEL <b>{model || '—'}</b></div>
      <div className="hud br">CATALOG <b>{rows ?? '—'}</b> SKUs</div>
    </>
  );
}

// Pixel-noise band between sections: generated once on a canvas from a seeded PRNG.
export function NoiseBand() {
  const url = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 6;
    const g = c.getContext('2d');
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let x = 0; x < c.width; x++) for (let y = 0; y < c.height; y++) {
      const v = Math.floor(150 + rnd() * 100);
      g.fillStyle = `rgba(${v},${v},${v},${rnd() > 0.55 ? 0.55 : 0.12})`;
      g.fillRect(x, y, 1, 1);
    }
    return c.toDataURL();
  }, []);
  return <div className="noiseband" style={{ backgroundImage: `url(${url})` }} aria-hidden="true" />;
}

export function Preloader() {
  const [gone, setGone] = useState(() => prefersReducedMotion() || sessionStorage.getItem('lg-preloaded') === '1');
  useEffect(() => {
    if (gone) return undefined;
    const t = setTimeout(() => { setGone(true); try { sessionStorage.setItem('lg-preloaded', '1'); } catch { /* storage unavailable */ } }, 1180);
    return () => clearTimeout(t);
  }, [gone]);
  if (gone) return null;
  return (
    <div className="preloader" role="status" aria-label="Loading">
      <LogoMark size={44} />
      <div className="bar"><i /></div>
      <div className="mono" style={{ fontSize: 11, letterSpacing: '0.1em', color: '#8a8a85' }}>LINEGRADE · SYNTHETIC DEMO</div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="section footer" style={{ paddingBottom: 0 }}>
      <div className="footer-links">
        <span>Synthetic data</span><span>·</span><span>Sandbox</span><span>·</span><span>Estimates</span>
        <span style={{ marginLeft: 'auto' }}>No real money. No real merchants.</span>
      </div>
      <div className="wordmark" aria-hidden="true">LINEGRADE</div>
    </footer>
  );
}

export const money = (s) => (s === null || s === undefined ? '—' : Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
