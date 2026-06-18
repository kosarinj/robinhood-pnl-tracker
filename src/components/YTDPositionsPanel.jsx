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

export default function YTDPositionsPanel() {
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

  const rows = data?.byUnderlying || []
  const sorted = [...rows].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1
    return mul * ((a[sortField] ?? 0) - (b[sortField] ?? 0))
  })

  const totals = rows.reduce((acc, r) => ({
    realizedCalls: acc.realizedCalls + (r.realizedCalls || 0),
    realizedPuts: acc.realizedPuts + (r.realizedPuts || 0),
    totalRealized: acc.totalRealized + (r.totalRealized || 0),
    openPremium: acc.openPremium + (r.openPremium || 0)
  }), { realizedCalls: 0, realizedPuts: 0, totalRealized: 0, openPremium: 0 })

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
                <th style={{ ...thStyle(null), textAlign: 'center', cursor: 'default' }}>Start Date</th>
                <th style={thStyle('realizedCalls')} onClick={() => toggleSort('realizedCalls')}>
                  Calls Realized<SortIcon field="realizedCalls" />
                </th>
                <th style={thStyle('realizedPuts')} onClick={() => toggleSort('realizedPuts')}>
                  Puts Realized<SortIcon field="realizedPuts" />
                </th>
                <th style={thStyle('totalRealized')} onClick={() => toggleSort('totalRealized')}>
                  Total Realized<SortIcon field="totalRealized" />
                </th>
                <th style={{ ...thStyle('openPremium'), borderRight: 'none' }} onClick={() => toggleSort('openPremium')}>
                  Open Premium<SortIcon field="openPremium" />
                </th>
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
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
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
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.realizedCalls, isDark), fontWeight: '600' }}>
                      {fmt(row.realizedCalls)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.realizedPuts, isDark), fontWeight: '600' }}>
                      {fmt(row.realizedPuts)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.totalRealized, isDark), fontWeight: '700', fontSize: '14px' }}>
                      {fmt(row.totalRealized)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(row.openPremium, isDark), fontWeight: '500' }}>
                      <span title="Net premium in open (unmatched) positions">{fmt(row.openPremium)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${border}`, background: headerBg }}>
                <td colSpan={2} style={{ padding: '10px 12px', fontWeight: '700', color: text, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Total ({rows.length} underlyings)
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedCalls, isDark), fontWeight: '700' }}>
                  {fmt(totals.realizedCalls)}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedPuts, isDark), fontWeight: '700' }}>
                  {fmt(totals.realizedPuts)}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.totalRealized, isDark), fontWeight: '700', fontSize: '15px' }}>
                  {fmt(totals.totalRealized)}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.openPremium, isDark), fontWeight: '700' }}>
                  {fmt(totals.openPremium)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
