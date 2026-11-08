import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Chip, LogoMark, Preloader, WakeScreen } from './ui.jsx';
import Landing from './screens/Landing.jsx';
import Enrich from './screens/Enrich.jsx';
import Review from './screens/Review.jsx';
import Order from './screens/Order.jsx';
import Readiness from './screens/Readiness.jsx';

// DESIGN.md: dark for landing / enrichment / readiness, light for review and order.
const THEME = { landing: 'dark', enrich: 'dark', review: 'light', order: 'light', readiness: 'dark' };
const NAV = [['enrich', 'Catalog'], ['review', 'Review'], ['order', 'Order + pay'], ['readiness', 'Readiness']];

export default function App() {
  const [screen, setScreen] = useState(() => (new URLSearchParams(location.search).get('screen') || 'landing'));
  const [state, setState] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [awake, setAwake] = useState(true); // false while the server is asleep or restarting
  const [expired, setExpired] = useState(false);

  const reload = useCallback(async () => {
    const [s, c] = await Promise.all([api.state(), api.catalog()]);
    setState(s); setCatalog(c);
    return c;
  }, []);

  // Waking up: Render's free tier sleeps after 15 idle minutes. Poll /health until the server answers.
  useEffect(() => {
    let cancelled = false;
    const wake = async () => {
      setAwake(false);
      while (!cancelled) {
        try { await api.health(); if (!cancelled) setAwake(true); return; } catch { await new Promise((r) => setTimeout(r, 2000)); }
      }
    };
    wake();
    const offline = () => { wake(); };
    const gone = () => setExpired(true);
    window.addEventListener('lg:offline', offline);
    window.addEventListener('lg:session-expired', gone);
    return () => { cancelled = true; window.removeEventListener('lg:offline', offline); window.removeEventListener('lg:session-expired', gone); };
  }, []);

  useEffect(() => { if (awake) api.state().then(setState).catch((e) => { if (e.code !== 'OFFLINE') setError(`Cannot reach the API: ${e.message}`); }); }, [awake]);
  useEffect(() => { if (screen !== 'landing' && !catalog) reload().catch((e) => setError(e.message)); }, [screen, catalog, reload]);
  useEffect(() => { document.documentElement.dataset.theme = THEME[screen] || 'dark'; window.scrollTo(0, 0); }, [screen]);

  const go = (s) => { setScreen(s); history.replaceState(null, '', s === 'landing' ? location.pathname : `?screen=${s}`); };
  const loadDemo = async () => { setLoading(true); try { await reload(); go('enrich'); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const restart = async () => { await api.reset(); setCatalog(null); await reload(); go('landing'); };

  const restartFromFrozen = async () => { setExpired(false); setCatalog(null); await reload().catch(() => {}); go('landing'); };
  const ready = !!catalog;
  const counts = catalog ? state?.counts : null;

  return (
    <div className="app">
      <Preloader />
      <WakeScreen awake={awake} />
      <div className="grain" aria-hidden="true" />
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand" onClick={() => go('landing')} aria-label="LineGrade home"><LogoMark size={24} /> <span className="wm">linegrade</span></button>
          <nav className="nav" aria-label="Demo steps">
            {NAV.map(([id, label]) => (
              <button key={id} onClick={() => go(id)} disabled={!ready && id !== 'enrich'} aria-current={screen === id ? 'page' : undefined}>{label}</button>
            ))}
          </nav>
          <div className="topbar-right">
            <Chip kind="synthetic" />
            {ready && <Button small variant="secondary" icon="" onClick={restart} title="Back to the frozen demo catalog">Reset demo</Button>}
          </div>
        </div>
      </header>
      <main className="frame">
        {expired && <div className="banner warn" role="alert" style={{ margin: 16 }}><span>Your session expired after {state?.session?.idleMinutes ?? 120} minutes of inactivity. Your earlier approvals are gone: you are back on the frozen demo catalog.</span><Button small variant="secondary" icon="" onClick={restartFromFrozen}>Start again</Button></div>}
        {error && <div className="banner fail" role="alert" style={{ margin: 16 }}><span>{error}</span><Button small variant="secondary" icon="" onClick={() => setError(null)}>Dismiss</Button></div>}
        {screen === 'landing' && <Landing state={state} onLoad={loadDemo} loading={loading} />}
        {screen === 'enrich' && catalog && <Enrich state={state} catalog={catalog} reload={reload} onNext={() => go('review')} />}
        {screen === 'review' && catalog && <Review catalog={catalog} counts={counts} reload={reload} onNext={() => go('order')} />}
        {screen === 'order' && catalog && <Order catalog={catalog} state={state} onNext={() => go('readiness')} onReview={() => go('review')} />}
        {screen === 'readiness' && catalog && <Readiness state={state} onRestart={restart} />}
        {screen !== 'landing' && !catalog && !error && <div className="section mono muted" style={{ fontSize: 12 }}>LOADING CATALOG…</div>}
      </main>
    </div>
  );
}
