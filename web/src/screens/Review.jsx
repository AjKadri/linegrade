import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { api } from '../api.js';
import { Button, Chip, SectionLabel, StatusChip } from '../ui.jsx';
import { columnDefs, gridTheme } from '../grid.jsx';

const UOMS = ['EA', 'BX', 'PK', 'CS', 'LB', 'KG', 'LTR'];
const REASON = { low_confidence: 'LOW CONFIDENCE', look_alike: 'LOOK-ALIKE', no_code: 'NO CODE', classification_failed: 'AI CALL FAILED' };

function Panel({ item, onChanged, busy, setBusy, setError }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ code: '', title: '', uom: 'EA', description: '' });
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);

  useEffect(() => { setEdit(false); setResults([]); }, [item?.sku]);
  useEffect(() => {
    if (!edit) return undefined;
    const t = setTimeout(async () => {
      if (q.trim().length < 2) { setResults([]); return; }
      try { setResults((await api.codes(q)).results); } catch { setResults([]); }
    }, 220);
    return () => clearTimeout(t);
  }, [q, edit]);

  if (!item) return <div className="card"><div className="card-b mono muted" style={{ fontSize: 12 }}>SELECT A ROW TO SEE WHY IT WAS FLAGGED.</div></div>;

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await onChanged(item.sku); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const startEdit = () => {
    setForm({ code: item.unspsc || '', title: item.unspsc_title || '', uom: item.uom_braintree || 'EA', description: item.description || '' });
    setQ(item.raw_name); setEdit(true);
  };

  return (
    <div className="card panel" aria-label={`Details for ${item.sku}`}>
      <div className="card-h">
        <span className="mono" style={{ fontWeight: 500 }}>{item.sku}</span>
        <span style={{ display: 'flex', gap: 6 }}>{item.approved && <Chip kind="ok">LOCKED</Chip>}<StatusChip item={item} /></span>
      </div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontWeight: 500 }}>{item.raw_name}</div>
        {!edit && (
          <>
            <dl className="kv">
              <dt>Official title</dt><dd>{item.unspsc ? <><span className="mono">{item.unspsc}</span><br />{item.unspsc_title}</> : <span className="muted">No code chosen</span>}</dd>
              <dt>Unit</dt><dd className="mono">{item.uom_braintree ? `${item.uom_braintree} / ${item.uom_paypal}` : '—'}</dd>
              <dt>Description</dt><dd>{item.description || <span className="muted">—</span>}</dd>
              <dt>Confidence</dt><dd className="mono">{Number(item.confidence).toFixed(2)}</dd>
              <dt>Runner-up</dt><dd>{item.runner_up ? <><span className="mono">{item.runner_up.unspsc}</span> · {Number(item.runner_up.confidence).toFixed(2)}<br />{item.runner_up.unspsc_title}</> : <span className="muted">none</span>}</dd>
              <dt>Why flagged</dt><dd style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(item.review_reasons || []).length ? item.review_reasons.map((r) => <Chip key={r} kind="review">{REASON[r] || r}</Chip>) : <span className="muted">not flagged</span>}</dd>
              <dt>Model reason</dt><dd className="muted">{item.reason || '—'}</dd>
              {item.approved && item.approval_changes?.length ? (<><dt>Seller change</dt><dd>{item.approval_changes.join('; ')}</dd></>) : null}
            </dl>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!item.approved ? (
                <>
                  <Button small icon="✓" disabled={busy || !item.unspsc} title={item.unspsc ? 'Accept as classified and lock' : 'No code yet: use Edit to pick one'} onClick={() => act(() => api.approve({ sku: item.sku }))}>Approve</Button>
                  <Button small variant="secondary" disabled={busy} onClick={startEdit}>Edit</Button>
                  <Button small variant="secondary" disabled={busy} title="Not a goods line (fee, bundle…): never goes on a card order" onClick={() => act(() => api.exclude(item.sku))}>Exclude</Button>
                </>
              ) : (
                <Button small variant="secondary" disabled={busy} onClick={() => act(() => api.unapprove(item.sku))}>Unlock</Button>
              )}
            </div>
            {!item.unspsc && !item.approved && <p className="mono muted" style={{ fontSize: 11 }}>NO CODE FITS? EXCLUDE FEES, BUNDLES AND OTHER NON-GOODS LINES.</p>}
          </>
        )}
        {edit && (
          <>
            <label className="field"><span>Find a code</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. exam gloves" /></label>
            {results.length > 0 && (
              <div className="result-list" role="listbox" aria-label="Matching UNSPSC codes">
                {results.map((r) => (
                  <button key={r.code} className={form.code === r.code ? 'sel' : ''} onClick={() => setForm({ ...form, code: r.code, title: r.title })} role="option" aria-selected={form.code === r.code}>
                    <span className="mono">{r.code}</span><span>{r.title}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="kv"><dt>Chosen</dt><dd>{form.code ? <><span className="mono">{form.code}</span> {form.title}</> : <span className="muted">none yet</span>}</dd></div>
            <label className="field"><span>Unit (Braintree)</span>
              <select className="select mono" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })}>{UOMS.map((u) => <option key={u}>{u}</option>)}</select>
            </label>
            <label className="field"><span>Description ({form.description.length}/126)</span>
              <textarea className="textarea" maxLength={126} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button small icon="✓" disabled={busy || !form.code || !form.description.trim()} onClick={() => act(() => api.approve({ sku: item.sku, code: form.code, uom: form.uom, description: form.description }))}>Approve &amp; lock</Button>
              <Button small variant="secondary" disabled={busy} onClick={() => setEdit(false)}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Review({ catalog, counts, reload, onNext }) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState(null);
  const [flip, setFlip] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const gridApi = useRef();
  const selectedRef = useRef(null);

  // Row order is fixed when the screen opens: rows that need review first, then the rest.
  const order = useRef(null);
  if (!order.current && catalog) {
    const rank = { needs_review: 0, ok: 1, excluded: 2 };
    order.current = [...catalog.items].sort((a, b) => (rank[a.status] - rank[b.status]) || a.sku.localeCompare(b.sku)).map((i) => i.sku);
  }
  const bySku = useMemo(() => Object.fromEntries(catalog.items.map((i) => [i.sku, i])), [catalog]);
  const rowData = useMemo(() => order.current.map((s) => ({ ...bySku[s], _flip: s === flip })).filter((r) => showAll || r.status === 'needs_review' || r.sku === flip), [bySku, flip, showAll]);

  const pending = catalog.items.filter((i) => i.status === 'needs_review');
  useEffect(() => { if (!selected && pending.length) setSelected(pending[0].sku); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { gridApi.current?.getRowNode(selected)?.setSelected(true); }, [selected, rowData]);

  const onChanged = async (sku) => {
    setFlip(sku);
    const fresh = await reload();
    const next = fresh.items.find((i) => i.status === 'needs_review' && i.sku !== sku);
    setSelected(next ? next.sku : sku);
    setTimeout(() => setFlip((f) => (f === sku ? null : f)), 900);
  };

  selectedRef.current = selected;
  const selItem = selected ? bySku[selected] : null;

  return (
    <>
      <section className="section tight" style={{ paddingTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <SectionLabel>REVIEW</SectionLabel>
          <div style={{ display: 'flex', gap: 8 }}><Chip kind="synthetic" /></div>
        </div>
        <h2 className="h-l" style={{ marginBottom: 16 }}>Review the flagged rows once</h2>
        <div className="stats">
          <div className="stat"><div className="n">{counts.needs_review}</div><div className="k">Needs review</div></div>
          <div className="stat"><div className="n">{counts.ok}</div><div className="k">OK</div></div>
          <div className="stat"><div className="n">{counts.approved}</div><div className="k">Approved &amp; locked</div></div>
          <div className="stat"><div className="n">{counts.excluded}</div><div className="k">Excluded</div></div>
        </div>
      </section>
      <section className="section" style={{ background: 'transparent' }}>
        {counts.needs_review === 0 && (
          <div className="banner" style={{ marginBottom: 16 }}>
            <span><b className="mono">ALL FLAGGED ROWS REVIEWED.</b> Every approved row is locked: re-running the AI will not touch it.</span>
            <Button small icon="→" onClick={onNext}>Continue to order</Button>
          </div>
        )}
        {error && <div className="banner fail" role="alert" style={{ marginBottom: 16 }}><span>{error}</span></div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button className="btn small secondary" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show needs-review only' : `Show all ${counts.total} rows`}</button>
          <span className="mono muted" style={{ fontSize: 11 }}>{rowData.length} ROWS SHOWN · NEEDS-REVIEW ROWS FIRST</span>
        </div>
        <div className="review-wrap">
          <div className="grid-box">
            <AgGridReact
              theme={gridTheme}
              rowData={rowData}
              columnDefs={columnDefs}
              getRowId={(p) => p.data.sku}
              getRowClass={(p) => (p.data._flip ? 'row-flash' : '')}
              rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
              onGridReady={(e) => { gridApi.current = e.api; }}
              onFirstDataRendered={(e) => e.api.getRowNode(selectedRef.current)?.setSelected(true)}
              onRowClicked={(e) => setSelected(e.data.sku)}
              overlayNoRowsTemplate="<span style='font-family:Geist Mono Variable,monospace;font-size:12px'>NOTHING TO REVIEW — SHOW ALL ROWS TO SEE THE CATALOG</span>"
              suppressCellFocus
              animateRows={false}
            />
          </div>
          <Panel item={selItem} onChanged={onChanged} busy={busy} setBusy={setBusy} setError={setError} />
        </div>
      </section>
    </>
  );
}
