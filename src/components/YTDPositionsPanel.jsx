import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const DEFAULT_GLOBAL_START = '2026-03-15'
const LS_GLOBAL_KEY = 'ytdPanel_globalStart'
const LS_SYMBOL_KEY = 'ytdPanel_symbolDates'

const fmt = (n) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}

export default function YTDPositionsPanel({ pnlData = [] }) {
  const { isDark } = useTheme()

  const [globalStart, setGlobalStart] = useState(() => localStorage.getItem(LS_GLOBAL_KEY) || DEFAULT_GLOBAL_START)
  const [symbolDates, setSymbolDates] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_SYMBOL_KEY) || '{}') } catch { return {} }
  })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [editingSymbol, setEditingSymbol] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [sortField, setSortField] = useState('totalRealized')
  const [sortDir, setSortDir] = useState('desc')
  const [livePrices, setLivePrices] = useState({})

  const fetchData = useCallback(async (overrideGlobal, overrideSymbolDates) => {
    setLoading(true)
    setError(null)
    try {
      const gs = overrideGlobal ?? globalStart
      const sd = overrideSymbolDates ?? symbolDates
      const params = new URLSearchParams({ startDate: gs })
      if (Object.keys(sd).length > 0) params.set('symbolDates', JSON.stringify(sd))
      const res = await fetch(`/api/options-pnl/ytd?${params}`, { credentials: 'include' })
      const json = await res.json()
      if (json.success) setData(json)
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [globalStart, symbolDates])

  useEffect(() => { fetchData() }, [])

  // Fetch live stock prices whenever the underlying data changes
  useEffect(() => {
    const tickers = data?.byUnderlying?.map(r => r.ticker).filter(Boolean)
    if (!tickers?.length) return
    fetch(`/api/current-prices?symbols=${tickers.join(',')}`, { credentials: 'include' })
      .then(r => r.json())
      .then(json => { if (json.success) setLivePrices(json.prices || {}) })
      .catch(() => {})
  }, [data])

  const applyGlobalStart = (date) => {
    setGlobalStart(date)
    localStorage.setItem(LS_GLOBAL_KEY, date)
    fetchData(date, symbolDates)
  }

  const saveSymbolDate = (ticker, date) => {
    const updated = { ...symbolDates }
    if (!date || date === globalStart) {
      delete updated[ticker]
    } else {
      updated[ticker] = date
    }
    setSymbolDates(updated)
    localStorage.setItem(LS_SYMBOL_KEY, JSON.stringify(updated))
    setEditingSymbol(null)
    fetchData(globalStart, updated)
  }

  const clearSymbolDate = (ticker) => {
    const updated = { ...symbolDates }
    delete updated[ticker]
    setSymbolDates(updated)
    localStorage.setItem(LS_SYMBOL_KEY, JSON.stringify(updated))
    fetchData(globalStart, updated)
  }

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const headerBg = isDark ? '#151929' : '#f8fafc'
  const rowHover = isDark ? '#252d3d' : '#f8fafc'

  // Build a fallback stock lookup from pnlData (dashboard data) for when server-side data is missing
  const pnlLookup = {}
  pnlData.forEach(p => {
    if (!p.isOption && p.symbol) {
      pnlLookup[p.symbol] = {
        position: p.real?.position ?? p.avgCost?.position ?? 0,
        avgCost: p.real?.avgCostBasis ?? p.avgCost?.avgCostBasis ?? 0,
        currentPrice: p.currentPrice ?? 0,
        unrealizedPnL: p.real?.unrealizedPnL ?? 0
      }
    }
  })

  const rows = data?.byUnderlying || []
  const sorted = [...rows].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1
    return mul * ((a[sortField] ?? 0) - (b[sortField] ?? 0))
  })

  const totals = rows.reduce((acc, r) => {
    const fb = pnlLookup[r.ticker]
    const pos = (fb?.position > 0 ? fb.position : null) ?? (r.stockPosition > 0 ? r.stockPosition : null)
    const avgCost = (fb?.avgCost > 0 ? fb.avgCost : null) ?? (r.stockAvgCost > 0 ? r.stockAvgCost : null)
    const price = livePrices[r.ticker] > 0 ? livePrices[r.ticker] : null
    const stockPnL = (pos > 0 && avgCost > 0 && price > 0)
      ? Math.round(pos * (price - avgCost) * 100) / 100
      : 0
    return {
      realizedShortCalls: acc.realizedShortCalls + (r.realizedShortCalls || 0),
      realizedLongCalls: acc.realizedLongCalls + (r.realizedLongCalls || 0),
      realizedShortPuts: acc.realizedShortPuts + (r.realizedShortPuts || 0),
      realizedLongPuts: acc.realizedLongPuts + (r.realizedLongPuts || 0),
      totalRealized: acc.totalRealized + (r.totalRealized || 0),
      openPremium: acc.openPremium + (r.openPremium || 0),
      stockUnrealizedPnL: acc.stockUnrealizedPnL + stockPnL
    }
  }, { realizedShortCalls: 0, realizedLongCalls: 0, realizedShortPuts: 0, realizedLongPuts: 0, totalRealized: 0, openPremium: 0, stockUnrealizedPnL: 0 })

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span style={{ opacity: 0.3, fontSize: '10px' }}> ↕</span>
    return <span style={{ fontSize: '10px' }}> {sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const thStyle = (field) => ({
    padding: '10px 12px', textAlign: 'right', fontSize: '11px', fontWeight: '600',
    color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
    background: sortField === field ? (isDark ? '#1a2035' : '#f0f4ff') : headerBg,
    borderBottom: `2px solid ${border}`
  })

  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Header controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: text }}>Options YTD by Underlying</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: textMid, fontWeight: '500' }}>Default Start:</label>
          <input
            type="date"
            value={globalStart}
            onChange={(e) => applyGlobalStart(e.target.value)}
            style={{
              padding: '5px 8px', borderRadius: '6px', border: `1px solid ${border}`,
              background: surface, color: text, fontSize: '13px', cursor: 'pointer'
            }}
          />
          <button
            onClick={() => fetchData()}
            style={{
              padding: '5px 12px', borderRadius: '6px', border: 'none',
              background: '#3b82f6', color: 'white', fontSize: '12px',
              fontWeight: '600', cursor: 'pointer'
            }}
          >
            Refresh
          </button>
        </div>
        <span style={{ fontSize: '12px', color: textMid }}>
          Click a date cell to set a per-symbol start date
        </span>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', background: '#fee2e2', color: '#991b1b', marginBottom: '12px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '24px', color: textMid, fontSize: '14px' }}>Loading…</div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div style={{ textAlign: 'center', padding: '32px', color: textMid, fontSize: '14px' }}>
          No options data found from {fmtDate(globalStart)}. Upload a CSV to get started.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', background: surface, borderRadius: '10px', overflow: 'hidden', border: `1px solid ${border}` }}>
            <thead>
              <tr>
                <th style={{ ...thStyle(null), textAlign: 'left', cursor: 'default' }}>Ticker</th>
                <th style={thStyle('realizedShortCalls')} onClick={() => toggleSort('realizedShortCalls')} title="Realized P&L from short calls (covered calls sold)">
                  Short Calls<SortIcon field="realizedShortCalls" />
                </th>
                <th style={thStyle('realizedLongCalls')} onClick={() => toggleSort('realizedLongCalls')} title="Realized P&L from long calls (calls bought)">
                  Long Calls<SortIcon field="realizedLongCalls" />
                </th>
                <th style={thStyle('realizedShortPuts')} onClick={() => toggleSort('realizedShortPuts')} title="Realized P&L from short puts (cash-secured puts)">
                  Short Puts<SortIcon field="realizedShortPuts" />
                </th>
                <th style={thStyle('realizedLongPuts')} onClick={() => toggleSort('realizedLongPuts')} title="Realized P&L from long puts (protective puts bought)">
                  Long Puts<SortIcon field="realizedLongPuts" />
                </th>
                <th style={thStyle('totalRealized')} onClick={() => toggleSort('totalRealized')}>
                  Options Total<SortIcon field="totalRealized" />
                </th>
                <th style={thStyle('openPremium')} onClick={() => toggleSort('openPremium')}
                    title="Net premium in currently-open positions (all time — not filtered by start date)">
                  Open Premium<SortIcon field="openPremium" />
                </th>
                <th style={{ ...thStyle(null), cursor: 'default', borderLeft: `1px solid ${border}` }} title="Shares held">Shares</th>
                <th style={{ ...thStyle(null), cursor: 'default' }} title="Average cost per share">Avg Cost</th>
                <th style={{ ...thStyle(null), cursor: 'default' }} title="Current stock price">Stock Price</th>
                <th style={{ ...thStyle('stockPnL'), borderRight: 'none' }} onClick={() => toggleSort('stockPnL')}>
                  Stock P&L<SortIcon field="stockPnL" />
                </th>
                <th style={{ ...thStyle(null), textAlign: 'center', cursor: 'default', borderLeft: `1px solid ${border}` }}>Start Date</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const isEditing = editingSymbol === row.ticker
                const effectiveDate = symbolDates[row.ticker] || globalStart
                const hasOverride = !!symbolDates[row.ticker]
                return (
                  <tr
                    key={row.ticker}
                    style={{ borderBottom: `1px solid ${border}`, background: i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff') }}
                    onMouseEnter={e => e.currentTarget.style.background = rowHover}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff')}
                  >
                    <td style={{ padding: '10px 12px', fontWeight: '700', color: text, letterSpacing: '0.03em' }}>
                      {row.ticker}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.realizedShortCalls, isDark), fontWeight: '600' }}>
                      {fmt(row.realizedShortCalls)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.realizedLongCalls, isDark), fontWeight: '600' }}>
                      {fmt(row.realizedLongCalls)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.realizedShortPuts, isDark), fontWeight: '600' }}>
                      {fmt(row.realizedShortPuts)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.realizedLongPuts, isDark), fontWeight: '600' }}>
                      {fmt(row.realizedLongPuts)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.totalRealized, isDark), fontWeight: '700', fontSize: '14px' }}>
                      {fmt(row.totalRealized)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.openPremium, isDark), fontWeight: '500' }}>
                      <span title="Net premium received from currently-open positions (all time)">{fmt(row.openPremium)}</span>
                    </td>
                    {/* Stock columns: pnlData for pos/avgCost, livePrices for current price */}
                    {(() => {
                      const fb = pnlLookup[row.ticker]
                      // Prefer pnlData for position + avg cost (computed by P&L engine from all trades)
                      const pos = (fb?.position > 0 ? fb.position : null) ?? (row.stockPosition > 0 ? row.stockPosition : null)
                      const avgCost = (fb?.avgCost > 0 ? fb.avgCost : null) ?? (row.stockAvgCost > 0 ? row.stockAvgCost : null)
                      // Always use fresh live price; never fall back to stale pnlData price
                      const price = livePrices[row.ticker] > 0 ? livePrices[row.ticker] : null
                      // Only compute P&L when all three are valid non-zero values
                      const pnl = (pos > 0 && avgCost > 0 && price > 0)
                        ? Math.round(pos * (price - avgCost) * 100) / 100
                        : null
                      return (<>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: textMid, borderLeft: `1px solid ${border}` }}>
                          {pos != null && pos > 0 ? pos.toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: textMid }}>
                          {avgCost ? fmt(avgCost) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: text }}>
                          {price ? fmt(price) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: pnlColor(pnl, isDark) }}
                            title={pos && price && avgCost ? `${pos} shares × ($${price.toFixed(2)} − $${avgCost.toFixed(2)})` : ''}>
                          {pnl != null ? fmt(pnl) : '—'}
                        </td>
                      </>)
                    })()}
                    <td style={{ padding: '10px 12px', textAlign: 'center', borderLeft: `1px solid ${border}` }}>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                          <input
                            type="date"
                            value={editDraft}
                            onChange={e => setEditDraft(e.target.value)}
                            autoFocus
                            style={{ padding: '3px 6px', borderRadius: '4px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '12px', width: '120px' }}
                          />
                          <button onClick={() => saveSymbolDate(row.ticker, editDraft)} style={{ padding: '3px 8px', borderRadius: '4px', border: 'none', background: '#22c55e', color: 'white', fontSize: '11px', cursor: 'pointer' }}>✓</button>
                          <button onClick={() => { setEditingSymbol(null) }} style={{ padding: '3px 8px', borderRadius: '4px', border: 'none', background: '#94a3b8', color: 'white', fontSize: '11px', cursor: 'pointer' }}>✗</button>
                          {hasOverride && <button onClick={() => { clearSymbolDate(row.ticker); setEditingSymbol(null) }} style={{ padding: '3px 8px', borderRadius: '4px', border: 'none', background: '#ef4444', color: 'white', fontSize: '11px', cursor: 'pointer' }}>Reset</button>}
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingSymbol(row.ticker); setEditDraft(effectiveDate) }}
                          style={{
                            padding: '3px 10px', borderRadius: '4px', border: `1px solid ${hasOverride ? '#3b82f6' : border}`,
                            background: hasOverride ? (isDark ? '#1e3a5f' : '#eff6ff') : 'transparent',
                            color: hasOverride ? '#3b82f6' : textMid, fontSize: '12px', cursor: 'pointer',
                            fontWeight: hasOverride ? '600' : '400'
                          }}
                          title={hasOverride ? `Custom: ${effectiveDate} (click to change)` : `Using global: ${effectiveDate} (click to override)`}
                        >
                          {fmtDate(effectiveDate)}{hasOverride ? ' ✎' : ''}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${border}`, background: headerBg }}>
                <td style={{ padding: '10px 12px', fontWeight: '700', color: text, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Total ({rows.length})
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedShortCalls, isDark), fontWeight: '700' }}>{fmt(totals.realizedShortCalls)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedLongCalls, isDark), fontWeight: '700' }}>{fmt(totals.realizedLongCalls)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedShortPuts, isDark), fontWeight: '700' }}>{fmt(totals.realizedShortPuts)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedLongPuts, isDark), fontWeight: '700' }}>{fmt(totals.realizedLongPuts)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.totalRealized, isDark), fontWeight: '700', fontSize: '15px' }}>{fmt(totals.totalRealized)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.openPremium, isDark), fontWeight: '700' }}>{fmt(totals.openPremium)}</td>
                <td colSpan={3} style={{ padding: '10px 12px', borderLeft: `1px solid ${border}` }} />
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.stockUnrealizedPnL, isDark), fontWeight: '700' }}>{fmt(totals.stockUnrealizedPnL)}</td>
                <td style={{ borderLeft: `1px solid ${border}` }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
