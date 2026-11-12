import React from 'react';
import { themeQuartz, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import { StatusChip } from './ui.jsx';

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid Theming API, settings from DESIGN.md.
export const gridTheme = themeQuartz.withParams({
  fontFamily: "'Geist Variable', system-ui, sans-serif",
  headerFontFamily: "'Geist Mono Variable', ui-monospace, monospace",
  headerTextColor: '#6B6B66',
  headerFontSize: 11,
  rowHeight: 44,
  headerHeight: 36,
  borderColor: '#D9D9D4',
  rowBorder: true,
  columnBorder: true,
  backgroundColor: '#FFFFFF',
  oddRowBackgroundColor: 'transparent',
  selectedRowBackgroundColor: '#E6E3FF',
  rowHoverColor: '#F6F6F3',
  accentColor: '#4B3FE0',
  wrapperBorderRadius: 2,
  spacing: 6,
});

const mono = (p) => <span className="cell-mono">{p.value ?? '—'}</span>;

function Confidence({ value, data }) {
  const v = Number(value) || 0;
  const c = v >= 0.85 ? 'var(--ok)' : v >= 0.6 ? 'var(--accent)' : 'var(--review)';
  return (
    <div className="conf" style={{ '--c': c }}>
      <div className="bar"><i style={{ width: `${Math.round(v * 100)}%` }} /></div>
      <span>{v.toFixed(2)}</span>
    </div>
  );
}

function Status({ data }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', height: '100%' }}>
      {data.status === 'excluded'
        ? <StatusChip item={data} flip={data._flip} />
        : data.approved
        ? <span className={`chip ok approved${data._flip ? ' flip' : ''}`} data-testid="approved-chip">✓ APPROVED · LOCKED</span>
        : <StatusChip item={data} flip={data._flip} />}
    </div>
  );
}

export const columnDefs = [
  { field: 'sku', headerName: 'SKU', width: 92, minWidth: 84, cellRenderer: mono, pinned: 'left' },
  { field: 'raw_name', headerName: 'Catalog name', flex: 1.4, minWidth: 120 },
  { field: 'unspsc', headerName: 'UNSPSC', width: 112, minWidth: 108, cellRenderer: mono },
  { field: 'unit_price', headerName: 'Price', width: 84, minWidth: 80, cellRenderer: (p) => <span className="cell-mono">${p.value}</span> },
  { field: 'confidence', headerName: 'Confidence', width: 124, minWidth: 116, cellRenderer: Confidence },
  { field: 'status', headerName: 'Status', width: 190, minWidth: 190, cellRenderer: Status },
];
