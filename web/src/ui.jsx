import React, { useEffect, useMemo, useState } from 'react';
import { prefersReducedMotion } from './hooks.js';

// Logo option A ("checked line items"): three bars of decreasing length, an accent tick finishing the
// shortest line. The tick draws itself (300 ms) when `draw` is set. Bars follow currentColor.
export function LogoMark({ size = 24, draw = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="3" y="6" width="22" height="3" fill="currentColor" />
      <rect x="3" y="15" width="16" height="3" fill="currentColor" />
      <rect x="3" y="24" width="10" height="3" fill="currentColor" />
      <path className={`tick${draw ? ' draw' : ''}`} d="M19 25 l4 4 l8 -10" stroke="var(--tick)" strokeWidth="3" fill="none" strokeLinecap="square" pathLength="20" />
    </svg>
  );
}

// Section label ("line-item stub"): two stacked accent bars, then the label in mono caps.
export function SectionLabel({ children }) {
  return (
    <span className="label">
      <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true"><rect x="0" y="1" width="14" height="2" fill="var(--stub)" /><rect x="0" y="7" width="8" height="2" fill="var(--stub)" /></svg>
      {children}
    </span>
  );
}

const CHIP = { ok: 'OK', review: 'NEEDS REVIEW', fail: 'FAILED', estimate: 'ESTIMATE', synthetic: 'SYNTHETIC DATA', sandbox: 'SANDBOX', excluded: 'EXCLUDED' };
export function Chip({ kind, children, flip }) {
  return <span className={`chip ${kind}${flip ? ' flip' : ''}`}>{children ?? CHIP[kind]}</span>;
}

export function StatusChip({ item, flip }) {
  if (item.status === 'excluded') return <Chip kind="excluded" flip={flip} />;
  if (item.status === 'ok') return <Chip kind="ok" flip={flip} />;
  return <Chip kind="review" flip={flip} />;
}

// Primary buttons end with an arrow; the tick (icon="✓") is only for completion moments (Approve, Paid).
export function Button({ variant = 'primary', icon = '→', children, small, ...rest }) {
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
      <div className="hud tl">INVOICE-GRADE · <b>SYNTHETIC DEMO</b></div>
      <div className="hud tr">{where}</div>
      <div className="hud bl">MODEL <b>{model || '—'}</b></div>
      <div className="hud br">CATALOG <b>{rows ?? '—'}</b> SKUs</div>
    </>
  );
}

// Line-item band between sections: rows of thin 1px lines of varying lengths, like printed invoice lines.
const BANDS = [[62, 38, 24, 12], [44, 70, 30, 18], [78, 26, 52, 14]];
export function LineItemBand({ variant = 0 }) {
  const rows = BANDS[variant % BANDS.length];
  const ys = [6, 12, 18, 24];
  return (
    <div className="band" aria-hidden="true">
      <svg width="100%" height="30" preserveAspectRatio="none">
        {rows.map((len, i) => <line key={i} x1="3%" x2={`${len}%`} y1={ys[i] + 0.5} y2={ys[i] + 0.5} stroke="var(--band)" strokeWidth="1" shapeRendering="crispEdges" />)}
        {rows.map((len, i) => <line key={`r${i}`} x1={`${100 - Math.round(len / 3) - 3}%`} x2="97%" y1={ys[i] + 0.5} y2={ys[i] + 0.5} stroke="var(--band)" strokeWidth="1" shapeRendering="crispEdges" />)}
      </svg>
    </div>
  );
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
      <div style={{ color: '#ede8e8', display: 'flex', alignItems: 'center', gap: 12 }}>
        <LogoMark size={44} draw />
        <span className="wm" style={{ fontSize: 28 }}>linegrade</span>
      </div>
      <div className="bar"><i /></div>
    </div>
  );
}

// Shown only if the server does not answer within about a second and a half (a sleeping free-tier instance
// takes about a minute to start). Normal loads never see it.
// After this long without an answer the counter is replaced by "Still waking up" + Retry. ?wakestuck=N is a test hook.
const wakeStuckSeconds = () => Number(new URLSearchParams(location.search).get('wakestuck')) || 60;
export function WakeScreen({ awake, since, detail, onRetry }) {
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (awake) { setVisible(false); return undefined; }
    const show = setTimeout(() => setVisible(true), 1500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearTimeout(show); clearInterval(tick); };
  }, [awake]);
  if (awake || !visible) return null;
  const seconds = Math.max(0, Math.round((now - (since || now)) / 1000));
  const stuck = seconds >= wakeStuckSeconds(); // never an endless counter
  return (
    <div className="wake" role="status" aria-live="polite" data-testid="wake-screen">
      <div style={{ color: '#ede8e8', display: 'flex', alignItems: 'center', gap: 12 }}><LogoMark size={44} draw /><span className="wm" style={{ fontSize: 28 }}>linegrade</span></div>
      <div className="wake-title" data-testid="wake-title">{stuck ? 'STILL WAKING UP' : 'WAKING UP THE DEMO'}</div>
      <div className="bar wake-bar"><i /></div>
      <p className="mono" style={{ fontSize: 12, color: '#8a8a85', maxWidth: 420, textAlign: 'center', lineHeight: 1.7 }}>
        {stuck
          ? 'THE SERVER HAS NOT ANSWERED YET. A FREE SERVER CAN TAKE LONGER THAN A MINUTE. THIS PAGE STILL CONTINUES BY ITSELF WHEN IT ANSWERS, OR RETRY NOW.'
          : 'THIS DEMO RUNS ON A FREE SERVER THAT SLEEPS WHEN IDLE. IT USUALLY TAKES ABOUT A MINUTE TO START. THIS PAGE CONTINUES BY ITSELF.'}
      </p>
      {detail && seconds >= 8 && <div className="mono" style={{ fontSize: 11, color: '#8a8a85', maxWidth: 420, textAlign: 'center' }} data-testid="wake-detail">LAST ANSWER: {String(detail).toUpperCase()}</div>}
      {stuck
        ? <Button small onClick={onRetry} data-testid="wake-retry">Retry</Button>
        : <div className="mono" style={{ fontSize: 12, color: '#8a8a85' }}>{seconds} s</div>}
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
      <div className="wordmark" aria-label="linegrade">
        <span>linegrade</span>
        <svg viewBox="0 0 34 34" aria-hidden="true" className="wm-mark">
          <rect x="3" y="6" width="22" height="3" fill="currentColor" /><rect x="3" y="15" width="16" height="3" fill="currentColor" /><rect x="3" y="24" width="10" height="3" fill="currentColor" />
          <path className="tick draw" d="M19 25 l4 4 l8 -10" stroke="var(--tick)" strokeWidth="3" fill="none" strokeLinecap="square" pathLength="20" />
        </svg>
      </div>
    </footer>
  );
}

export const money = (s) => (s === null || s === undefined ? '—' : Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
