import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip, Hud, Orb, SectionLabel, StatusChip } from '../ui.jsx';
import { streamEnrich } from '../api.js';
import { prefersReducedMotion } from '../hooks.js';

const toRow = (it, action) => ({ sku: it.sku, name: it.raw_name, code: it.unspsc, conf: it.confidence, status: it.status, action });

export default function Enrich({ state, catalog, reload, onNext }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(catalog?.items.length || 0);
  const [phase, setPhase] = useState('idle'); // idle | replay | live | done
  const [mode, setMode] = useState('replay');
  const [force, setForce] = useState(false);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef();
  const closer = useRef();
  const listRef = useRef();

  const replay = useCallback(() => {
    clearInterval(timer.current);
    closer.current?.();
    const items = catalog.items;
    setMode('replay'); setError(null); setSummary(null); setTotal(items.length); setRows([]);
    if (prefersReducedMotion()) { setRows(items.map((i) => toRow(i, 'frozen'))); setPhase('done'); return; }
    setPhase('replay');
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      setRows(items.slice(0, i).map((x) => toRow(x, 'frozen')));
      if (i >= items.length) { clearInterval(timer.current); setPhase('done'); }
    }, 45);
  }, [catalog]);

  useEffect(() => { if (catalog) replay(); return () => { clearInterval(timer.current); closer.current?.(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [rows.length]);

  const rerun = () => {
    clearInterval(timer.current);
    setMode('live'); setPhase('live'); setRows([]); setError(null); setSummary(null);
    closer.current = streamEnrich({ force }, {
      plan: (p) => { setTotal(p.total); setSummary({ toClassify: p.toClassify }); },
      item: (e) => setRows((r) => [...r, toRow(e.item, e.action)]),
      done: async (d) => { setSummary((s) => ({ ...s, ...d })); setPhase('done'); await reload(); },
      error: (m) => { setError(m); setPhase('done'); },
    });
  };

  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const working = phase === 'replay' || phase === 'live';
  const pct = total ? Math.round((100 * rows.length) / total) : 0;
  const reused = rows.filter((r) => r.action === 'reuse').length;
  const locked = rows.filter((r) => r.action === 'locked').length;
  const fresh = rows.filter((r) => r.action === 'classify').length;

  return (
    <section style={{ position: 'relative' }}>
      <Hud model={state?.modelLabel} rows={total} />
      <div className="enrich-grid" style={{ paddingTop: 36 }}>
        <div className="enrich-left">
          <SectionLabel>Enrichment</SectionLabel>
          <Orb working={working} />
          <div>
            <div className="counter" aria-live="polite">{rows.length} / {total}</div>
            <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.08em' }}>CLASSIFIED</div>
          </div>
          <div className="progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
          <div className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--muted)', lineHeight: 1.7 }}>
            {mode === 'replay' ? <>REPLAY OF THE FROZEN CATALOG<br />NO AI CALL · CLASSIFIED WITH {state?.modelLabel}</> : <>LIVE AI RUN · {state?.modelLabel}<br />{fresh} NEW · {reused} REUSED · {locked} LOCKED</>}
          </div>
          {phase === 'done' && !error && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Chip kind="ok">{counts.ok || 0} OK</Chip>
              <Chip kind="review">{counts.needs_review || 0} NEEDS REVIEW</Chip>
              {counts.excluded ? <Chip kind="excluded">{counts.excluded} EXCLUDED</Chip> : null}
            </div>
          )}
          {summary?.last_run && <div className="mono muted" style={{ fontSize: 11 }}>COST ${summary.last_run.cost_usd?.toFixed(4) ?? '—'} · {summary.last_run.classified} CLASSIFIED</div>}
          {error && <div className="banner fail" role="alert"><span>{error}</span></div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 'auto', width: '100%' }}>
            <Button onClick={onNext} disabled={phase !== 'done'}>Continue to review</Button>
            <Button variant="secondary" icon="" onClick={rerun} disabled={working}>Re-run AI (keeps locked rows)</Button>
            <label className="mono muted" style={{ fontSize: 11, display: 'flex', gap: 8, alignItems: 'center', letterSpacing: '0.04em' }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> FORCE: RE-CLASSIFY ALL UNLOCKED ROWS
            </label>
            <button className="btn small" style={{ alignSelf: 'flex-start', color: 'var(--muted)' }} onClick={replay} disabled={working}>↺ replay frozen catalog</button>
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="stream" ref={listRef} role="log" aria-label="Classified SKUs">
            {rows.length === 0 && <div className="mono muted" style={{ padding: 24, fontSize: 12 }}>WAITING FOR THE FIRST ROW…</div>}
            {rows.map((r) => (
              <div className="stream-row" key={r.sku}>
                <span className="mono">{r.sku}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span className="mono">{r.code || '—'}</span>
                <span className="mono muted">{Number(r.conf).toFixed(2)}</span>
                <span><StatusChip item={r} /></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
