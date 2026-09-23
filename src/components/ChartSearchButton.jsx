import React, { useState } from 'react'

/**
 * "Chart" — opens a symbol lookup that hands the chosen ticker back.
 *
 * Lifted out of the Analytics header so Research can carry it too. Copying the
 * markup instead would have left two inputs with their own state, drifting the
 * moment either changed; the chart modal itself already lives above the tabs,
 * so only this control needed sharing.
 */
export default function ChartSearchButton({ onPick, style = {} }) {
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState('')

  const submit = () => {
    const s = symbol.trim().toUpperCase()
    if (!s) return
    onPick(s)
    setSymbol('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        className="upload-button"
        onClick={() => setOpen(true)}
        style={style}
        title="Search for any symbol and view its chart"
      >
        📊 Chart
      </button>
    )
  }

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', ...style }}>
      <input
        id="chart-search-symbol"
        type="text"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') { setSymbol(''); setOpen(false) }
        }}
        placeholder="Enter symbol (e.g., TSLA)"
        autoFocus
        style={{
          padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc',
          fontSize: 14, width: 150,
        }}
      />
      <button
        onClick={submit}
        disabled={!symbol.trim()}
        style={{
          padding: '8px 12px', borderRadius: 6, border: 'none',
          background: symbol.trim() ? '#3b82f6' : '#94a3b8',
          color: 'white', fontSize: 14, fontWeight: 600,
          cursor: symbol.trim() ? 'pointer' : 'not-allowed',
        }}
      >Show</button>
      <button
        onClick={() => { setSymbol(''); setOpen(false) }}
        style={{
          padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc',
          background: 'transparent', color: 'inherit', fontSize: 14, cursor: 'pointer',
        }}
      >Cancel</button>
    </span>
  )
}
