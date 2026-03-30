import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '$0.00'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const fmtDate = (s) => {
  if (!s) return ''
  const d = new Date(s + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const getMondayOfWeek = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  const fri = new Date(monday)
  fri.setDate(monday.getDate() + 4)
  return { monday: monday.toISOString().slice(0, 10), friday: fri.toISOString().slice(0, 10) }
}

export default function OptionsPnLPanel() {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [activeQuick, setActiveQuick] = useState('all')
  const [expandedTicker, setExpandedTicker] = useState(null)
  const [showWeeklyTable, setShowWeeklyTable] = useState(false)
  const [livePositions, setLivePositions] = useState(null)
  const [posLoading, setPosLoading] = useState(false)
  const [posError, setPosError] = useState(null)
  const [asOfDate, setAsOfDate] = useState('')
  const [byUnderlyingWeeks, setByUnderlyingWeeks] = useState(1)

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const green = '#22c55e'
  const red = '#ef4444'

  const fetchData = async (overrideAsOf) => {
    setLoading(true)
    setError(null)
    try {
      const asOf = overrideAsOf ?? asOfDate
      const url = asOf ? `/api/options-pnl/history?asOf=${asOf}` : '/api/options-pnl/history'
      const res = await fetch(url, { credentials: 'include' })
      const json = await res.json()
      if (json.success) setData(json)
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchLivePositions = async () => {
    setPosLoading(true)
    setPosError(null)
    try {
      const res = await fetch('/api/options-pnl/open-positions', { credentials: 'include' })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { setPosError(`Bad response (${res.status}): ${text.slice(0, 200)}`); return }
      if (json.success) {
        // Always update stockPrices; keep previous positions if new fetch returns empty (avoid blanking on glitch)
        setLivePositions(prev => ({
          ...json,
          positions: json.positions?.length > 0 ? json.positions : (prev?.positions || [])
        }))
      } else {
        setPosError(json.error || 'Unknown error')
      }
    } catch (e) {
      setPosError(e.message)
    } finally {
      setPosLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    fetchLivePositions()
    const interval = setInterval(() => {
      fetchData()
      fetchLivePositions()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const setQuick = (range) => {
    setActiveQuick(range)
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    if (range === 'month') {
      const lastDay = new Date(y, now.getMonth() + 1, 0).getDate()
      setFromDate(`${y}-${m}-01`)
      setToDate(`${y}-${m}-${lastDay}`)
    } else if (range === 'last-month') {
      const lm = now.getMonth() === 0 ? 12 : now.getMonth()
      const ly = now.getMonth() === 0 ? y - 1 : y
      const lmStr = String(lm).padStart(2, '0')
      const lastDay = new Date(ly, lm, 0).getDate()
      setFromDate(`${ly}-${lmStr}-01`)
      setToDate(`${ly}-${lmStr}-${lastDay}`)
    } else if (range === 'year') {
      setFromDate(`${y}-01-01`)
      setToDate(`${y}-12-31`)
    } else {
      setFromDate('')
      setToDate('')
    }
  }

  // Sort ascending for running total, then reverse for display
  const sortedAsc = [...(data?.weeks || [])].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
  let running = 0
  const weeksWithRunning = sortedAsc.map(w => { running += w.totalDelta; return { ...w, runningTotal: Math.round(running * 100) / 100 } })
  const filteredWeeks = weeksWithRunning
    .filter(w => {
      if (fromDate && w.weekStart < fromDate) return false
      if (toDate && w.weekStart > toDate) return false
      return true
    })
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart))

  const rangeTotal = filteredWeeks.reduce((s, w) => s + w.totalDelta, 0)
  const positiveWeeks = filteredWeeks.filter(w => w.totalDelta > 0).length
  const negativeWeeks = filteredWeeks.filter(w => w.totalDelta < 0).length

  const cardStyle = {
    background: surface,
    border: `1px solid ${border}`,
    borderRadius: '12px',
    padding: '20px 24px',
    marginBottom: '16px',
  }

  const btnStyle = (active) => ({
    padding: '5px 12px',
    borderRadius: '6px',
    border: `1px solid ${active ? '#667eea' : border}`,
    background: active ? '#667eea' : 'transparent',
    color: active ? '#fff' : textMid,
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '600',
    transition: 'all 0.15s'
  })

  const allTimeTotal = data?.weeks?.reduce((s, w) => s + w.totalDelta, 0) || 0

  // Cumulative by-underlying: sum byUnderlying across the last N weeks (sorted desc)
  const cumulativeByUnderlying = (() => {
    const weeks = data?.weeks || []
    const sorted = [...weeks].sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    const slice = byUnderlyingWeeks === 0 ? sorted : sorted.slice(0, byUnderlyingWeeks)
    const totals = {}
    slice.forEach(w => {
      Object.entries(w.byUnderlying || {}).forEach(([ticker, val]) => {
        totals[ticker] = (totals[ticker] || 0) + val
      })
    })
    return totals
  })()
  const totalStockPnL = Object.values(data?.weeklyStockPnL || {}).reduce((s, v) => s + (v?.pnl ?? v), 0)
  const otherStockPnL = data?.otherStockPnL || 0
  // Use live positions from dedicated endpoint (with Polygon prices), fall back to history data
  const openPositions = livePositions?.positions || data?.openOptionPositions || []
  const hasPrices = openPositions.some(p => p.unrealizedPnl != null)
  const totalUnrealizedPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)
  const optionsWeekPnL = hasPrices
    ? (data?.currentWeekRealizedTotal || 0) + totalUnrealizedPnl
    : (data?.currentWeekPnL || 0)
  const netWeekPnL = optionsWeekPnL + totalStockPnL + otherStockPnL
  // Unrealized P&L grouped by underlying ticker
  const unrealizedByTicker = openPositions.reduce((m, p) => {
    if (p.unrealizedPnl != null) m[p.ticker] = (m[p.ticker] || 0) + p.unrealizedPnl
    return m
  }, {})
  // Stock price by ticker:
  // Start with Yahoo Finance today prices from history endpoint (always available after load)
  // then override with Polygon live underlying_asset.price when available (market hours)
  const stockPriceByTicker = {
    // Yahoo Finance today prices for stocks user holds
    ...Object.fromEntries(Object.entries(data?.weeklyStockPnL || {}).filter(([, e]) => (e?.toPrice ?? 0) > 0).map(([sym, e]) => [sym, e.toPrice])),
    // Yahoo Finance today prices for option-only underlyings (e.g. HOOD where user holds no stock)
    ...(data?.optionUnderlyingPrices || {}),
    // Polygon live underlying_asset.price overrides when available (market hours)
    ...openPositions.reduce((m, p) => { if (p.stockPrice > 0) m[p.ticker] = p.stockPrice; return m }, {})
  }
  // Remaining premium — compute client-side using stock prices already in stockPriceByTicker
  const remPremByTicker = openPositions.reduce((m, p) => {
    const stockPrice = stockPriceByTicker[p.ticker]
    const mark = p.markPrice
    if (!stockPrice || !mark) return m
    if (!p.isLong && p.optionType === 'call') {
      const extrinsic = Math.round(Math.max(0, mark - Math.max(0, stockPrice - p.strike)) * 100) / 100
      if (extrinsic > 0) {
        if (!m[p.ticker]) m[p.ticker] = { shortCall: null, longPut: null }
        m[p.ticker].shortCall = Math.round(((m[p.ticker].shortCall || 0) + extrinsic) * 100) / 100
      }
    } else if (p.isLong && p.optionType === 'put') {
      const extrinsic = Math.round(Math.max(0, mark - Math.max(0, p.strike - stockPrice)) * 100) / 100
      if (extrinsic > 0) {
        if (!m[p.ticker]) m[p.ticker] = { shortCall: null, longPut: null }
        m[p.ticker].longPut = Math.round(((m[p.ticker].longPut || 0) + extrinsic) * 100) / 100
      }
    }
    return m
  }, {})

  const handleRefreshAll = () => { fetchData(); fetchLivePositions() }
  const handleAsOfChange = (e) => {
    const val = e.target.value
    setAsOfDate(val)
    fetchData(val)
  }
  const handleAsOfClear = () => {
    setAsOfDate('')
    fetchData('')
  }

  return (
    <div style={{ color: text }}>
      {/* Global Refresh */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        {livePositions?.fetchedAt && <span style={{ fontSize: '11px', color: textMid }}>Updated {new Date(livePositions.fetchedAt).toLocaleTimeString()}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '11px', color: textMid }}>As of</span>
          <input type="date" value={asOfDate} onChange={handleAsOfChange}
            style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: `1px solid ${asOfDate ? '#667eea' : border}`, background: surface, color: text, cursor: 'pointer' }} />
          {asOfDate && <button onClick={handleAsOfClear} style={{ fontSize: '11px', color: textMid, background: 'none', border: 'none', cursor: 'pointer' }}>✕ today</button>}
        </div>
        <button onClick={handleRefreshAll} disabled={loading || posLoading} style={{ ...btnStyle(false), padding: '6px 16px', opacity: (loading || posLoading) ? 0.6 : 1 }}>
          {(loading || posLoading) ? '…' : '↻ Refresh All'}
        </button>
      </div>
      {/* This Week Hero Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        {/* Options P&L */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${optionsWeekPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid, marginBottom: '6px' }}>Wk — Options</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: optionsWeekPnL >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(optionsWeekPnL)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>
            Realized: <span style={{ color: (data?.currentWeekRealizedTotal || 0) >= 0 ? green : red, fontWeight: '600' }}>{fmt(data?.currentWeekRealizedTotal || 0)}</span>
            {hasPrices && <span style={{ marginLeft: '8px' }}>· Unrealized: <span style={{ color: totalUnrealizedPnl >= 0 ? green : red, fontWeight: '600' }}>{fmt(totalUnrealizedPnl)}</span></span>}
          </div>
        </div>
        {/* Stock P&L */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${totalStockPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid, marginBottom: '6px' }}>Wk — Stock</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: totalStockPnL >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(totalStockPnL)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>Fri–Fri close · {Object.keys(data?.weeklyStockPnL || {}).length} positions</div>
        </div>
        {/* Other Stocks */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${otherStockPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid, marginBottom: '8px' }}>Wk — Other Stocks</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: otherStockPnL >= 0 ? green : red, lineHeight: 1, marginBottom: '10px' }}>
            {loading ? '…' : fmt(otherStockPnL)}
          </div>
          {Object.keys(data?.otherStockPnLBySymbol || {}).length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              {Object.entries(data.otherStockPnLBySymbol)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([sym, entry]) => {
                  const pnl = entry?.pnl ?? entry
                  const tooltip = entry?.fromPrice ? `${entry.fromDate}: $${entry.fromPrice.toFixed(2)} → ${entry.toDate}: $${entry.toPrice.toFixed(2)}` : undefined
                  return (
                    <div key={sym} title={tooltip} style={{
                      padding: '3px 5px', borderRadius: '6px', fontSize: '10px',
                      background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                      border: `1px solid ${border}`, cursor: tooltip ? 'help' : 'default',
                      minWidth: 0, overflow: 'hidden'
                    }}>
                      <span style={{ fontWeight: '700', color: text }}>{sym}</span>
                      {entry?.toPrice && <span style={{ color: textMid, marginLeft: '5px', fontSize: '11px' }}>{fmt(entry.toPrice)}</span>}
                      <span style={{ color: pnl >= 0 ? green : red, marginLeft: '6px' }}>
                        {pnl >= 0 ? '+' : ''}{fmt(pnl)}
                      </span>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
        {/* Net Total */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${netWeekPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid, marginBottom: '6px' }}>Wk — Net Total</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: netWeekPnL >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(netWeekPnL)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>Options + Stock + Other Stocks</div>
        </div>
      </div>

      {/* Per-underlying breakdown + refresh */}
      <div style={{
        ...cardStyle,
        borderLeft: `4px solid ${(data?.currentWeekPnL || 0) >= 0 ? green : red}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ fontSize: '13px', fontWeight: '700', color: text }}>By Underlying</div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {[['1W', 1], ['4W', 4], ['8W', 8], ['All', 0]].map(([label, val]) => (
              <button key={label} onClick={() => setByUnderlyingWeeks(val)}
                style={{ ...btnStyle(byUnderlyingWeeks === val), padding: '3px 10px', fontSize: '11px' }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Per-underlying breakdown — single week (detailed) or multi-week (options total only) */}
        {byUnderlyingWeeks !== 1 && Object.keys(cumulativeByUnderlying).length > 0 && (
          <div style={{ paddingTop: '12px', borderTop: `1px solid ${border}` }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {Object.entries(cumulativeByUnderlying)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                .map(([ticker, optPnl]) => (
                  <div key={ticker} style={{ minWidth: '120px', flex: '1 1 120px', maxWidth: '220px',
                    padding: '8px 12px', borderRadius: '8px', fontSize: '12px',
                    background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                    border: `1px solid ${border}` }}>
                    <div style={{ fontWeight: '700', color: text, marginBottom: '4px' }}>{ticker}</div>
                    <div style={{ color: optPnl >= 0 ? green : red, fontWeight: '600' }}>
                      {optPnl >= 0 ? '+' : ''}{fmt(optPnl)}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
        {byUnderlyingWeeks === 1 && data?.currentWeekByUnderlying && Object.keys(data.currentWeekByUnderlying).length > 0 && (
          <div style={{ paddingTop: '12px', borderTop: `1px solid ${border}` }}>
            <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid, marginBottom: '8px' }}>
              This Week by Underlying
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {/* Tickers with open positions but no current-week trades */}
              {Object.entries(unrealizedByTicker)
                .filter(([ticker]) => !data.currentWeekByUnderlying[ticker])
                .map(([ticker, unrealizedPnl]) => {
                  const rp = remPremByTicker[ticker]
                  const sp = stockPriceByTicker[ticker]
                  return (
                    <div key={`open-${ticker}`} style={{ minWidth: '140px', flex: '1 1 140px', maxWidth: '260px' }}>
                      <div style={{
                        padding: '8px 12px', borderRadius: '8px',
                        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                        border: `1px solid ${border}`, fontSize: '12px'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                          <span style={{ fontWeight: '700', color: text }}>{ticker}</span>
                          {sp && <span style={{ fontSize: '11px', color: textMid }}>{fmt(sp)}</span>}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ color: unrealizedPnl >= 0 ? green : red }}>
                            Unrealized: {unrealizedPnl >= 0 ? '+' : ''}{fmt(unrealizedPnl)}
                          </div>
                          {rp?.shortCall != null && <div style={{ color: '#f59e0b' }}>Rem Short Call: {fmt(rp.shortCall)}</div>}
                          {rp?.longPut != null && <div style={{ color: '#f59e0b' }}>Rem Long Put: {fmt(rp.longPut)}</div>}
                        </div>
                      </div>
                    </div>
                  )
                })
              }
              {Object.entries(data.currentWeekByUnderlying).map(([ticker, optPnl]) => {
                const stockEntry = data.weeklyStockPnL?.[ticker]
                const stockPnl = stockEntry !== undefined ? (stockEntry?.pnl ?? stockEntry) : undefined
                const stockTooltip = stockEntry?.fromPrice ? `${stockEntry.shares} shares · ${stockEntry.fromDate}: $${stockEntry.fromPrice.toFixed(2)} → ${stockEntry.toDate}: $${stockEntry.toPrice.toFixed(2)}` : undefined
                const unrealizedPnl = unrealizedByTicker[ticker]
                const rp = remPremByTicker[ticker]
                const trades = data.currentWeekTradesByUnderlying?.[ticker] || []
                const realizedPnl = data.currentWeekRealizedByUnderlying?.[ticker]
                // When unrealized is available, Net = realized + unrealized + stock
                // (avoids double-counting BTO cost which is already inside unrealizedPnl)
                // When no unrealized, Net = options cash flows + stock (existing behavior)
                const combined = stockPnl !== undefined || unrealizedPnl !== undefined
                  ? (unrealizedPnl !== undefined ? (realizedPnl ?? 0) : optPnl) + (stockPnl ?? 0) + (unrealizedPnl ?? 0)
                  : null
                const isExpanded = expandedTicker === ticker
                const sp = stockPriceByTicker[ticker] || stockEntry?.toPrice
                return (
                  <div key={ticker} style={{ minWidth: '140px', flex: '1 1 140px', maxWidth: '260px' }}>
                    <div
                      onClick={() => setExpandedTicker(isExpanded ? null : ticker)}
                      style={{
                        padding: '8px 12px', borderRadius: isExpanded ? '8px 8px 0 0' : '8px',
                        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                        border: `1px solid ${border}`,
                        fontSize: '12px', cursor: 'pointer',
                        borderBottom: isExpanded ? 'none' : `1px solid ${border}`
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '700', color: text }}>{ticker}{sp ? <span style={{ fontWeight: '400', color: textMid, marginLeft: '6px' }}>{fmt(sp)}</span> : null}</span>
                        <span style={{ color: textMid, fontSize: '10px' }}>{isExpanded ? '▲' : '▼'} {trades.length} trade{trades.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ color: optPnl >= 0 ? green : red }}>
                          Options: {optPnl >= 0 ? '+' : ''}{fmt(optPnl)}
                        </div>
                        {realizedPnl !== undefined && (
                          <div style={{ color: realizedPnl >= 0 ? green : red, fontSize: '11px' }}>
                            ↳ Realized: {realizedPnl >= 0 ? '+' : ''}{fmt(realizedPnl)}
                          </div>
                        )}
                        {stockPnl !== undefined && (
                          <div title={stockTooltip} style={{ color: stockPnl >= 0 ? green : red, cursor: stockTooltip ? 'help' : 'default' }}>
                            Stock: {stockPnl >= 0 ? '+' : ''}{fmt(stockPnl)}
                          </div>
                        )}
                        {unrealizedPnl !== undefined && (
                          <div style={{ color: unrealizedPnl >= 0 ? green : red }}>
                            Unrealized: {unrealizedPnl >= 0 ? '+' : ''}{fmt(unrealizedPnl)}
                          </div>
                        )}
                        {rp?.shortCall != null && <div style={{ color: '#f59e0b' }}>Rem Short Call: {fmt(rp.shortCall)}</div>}
                        {rp?.longPut != null && <div style={{ color: '#f59e0b' }}>Rem Long Put: {fmt(rp.longPut)}</div>}
                        {combined !== null && (
                          <div style={{ color: combined >= 0 ? green : red, fontWeight: '700', borderTop: `1px solid ${border}`, paddingTop: '2px', marginTop: '2px' }}>
                            Net: {combined >= 0 ? '+' : ''}{fmt(combined)}
                          </div>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div style={{
                        border: `1px solid ${border}`, borderTop: 'none',
                        borderRadius: '0 0 8px 8px',
                        background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.02)',
                        fontSize: '11px'
                      }}>
                        {trades.map((t, i) => (
                          <div key={i} style={{
                            padding: '5px 10px',
                            borderBottom: i < trades.length - 1 ? `1px solid ${border}` : 'none',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                              <div style={{ color: textMid, flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                  <span style={{ color: text, fontWeight: '600' }}>{t.transCode || t.action}</span>
                                  <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
                                    background: t.isClosing && t.realizedPnl != null ? 'rgba(34,197,94,0.15)' : t.isClosing ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.15)',
                                    color: t.isClosing && t.realizedPnl != null ? green : t.isClosing ? '#f87171' : textMid }}>
                                    {t.isClosing && t.realizedPnl != null ? 'realized' : t.isClosing ? 'unmatched' : 'open'}
                                  </span>
                                  <span style={{ color: textMid }}>{t.date}</span>
                                </div>
                                <div style={{ wordBreak: 'break-word', lineHeight: '1.4' }}>{t.description}</div>
                              </div>
                              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {t.isClosing && t.realizedPnl != null ? (
                                  <div style={{ color: t.realizedPnl >= 0 ? green : red, fontWeight: '700' }}>
                                    {t.realizedPnl >= 0 ? '+' : ''}{fmt(t.realizedPnl)}
                                  </div>
                                ) : (
                                  <div style={{ color: t.cashFlow >= 0 ? green : red, fontWeight: '700' }}>
                                    {t.cashFlow >= 0 ? '+' : ''}{fmt(t.cashFlow)}
                                  </div>
                                )}
                              </div>
                            </div>
                            {t.isClosing && t.realizedPnl == null && (
                              <div style={{ fontSize: '10px', color: '#f87171', textAlign: 'right', marginTop: '2px' }}>
                                no matching opening trade found
                              </div>
                            )}
                            {t.isClosing && t.realizedPnl != null && (
                              <div style={{ fontSize: '10px', color: textMid, textAlign: 'right', marginTop: '2px' }}>
                                proceeds {t.cashFlow >= 0 ? '+' : ''}{fmt(t.cashFlow)}
                                {t.realizedPnlDetail && (
                                  <span style={{ marginLeft: '6px' }}>
                                    · cost basis {fmt(t.realizedPnlDetail.costBasis)}
                                    {t.realizedPnlDetail.matchedLegs?.map((leg, li) => (
                                      <span key={li}> [{leg.contracts}c @ {fmt(leg.pricePerContract)}{leg.date ? ` on ${leg.date}` : ''}]</span>
                                    ))}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Date Range Filter */}
      <div style={{ ...cardStyle, padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', color: textMid, fontWeight: '600' }}>Range:</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            {[['month','This Month'],['last-month','Last Month'],['year','This Year'],['all','All Time']].map(([key, label]) => (
              <button key={key} style={btnStyle(activeQuick === key)} onClick={() => setQuick(key)}>{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '8px' }}>
            <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setActiveQuick('custom') }}
              style={{ padding: '5px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px' }} />
            <span style={{ color: textMid }}>&#8594;</span>
            <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setActiveQuick('custom') }}
              style={{ padding: '5px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px' }} />
          </div>
        </div>
      </div>

      {/* Summary stats for range */}
      {filteredWeeks.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {[
            { label: 'Range Total', value: fmt(rangeTotal), color: rangeTotal >= 0 ? green : red },
            { label: 'Weeks Shown', value: filteredWeeks.length, color: text },
            { label: 'Winning Weeks', value: positiveWeeks, color: green },
            { label: 'Losing Weeks', value: negativeWeeks, color: red },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ ...cardStyle, padding: '14px 18px', marginBottom: 0 }}>
              <div style={{ fontSize: '11px', color: textMid, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '6px' }}>{label}</div>
              <div style={{ fontSize: '1.2rem', fontWeight: '700', color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Weekly Table */}
      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div
          onClick={() => setShowWeeklyTable(s => !s)}
          style={{ padding: '14px 20px', borderBottom: showWeeklyTable ? `1px solid ${border}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
          <span style={{ fontWeight: '700', fontSize: '14px' }}>Weekly Breakdown</span>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: textMid }}>{filteredWeeks.length} week{filteredWeeks.length !== 1 ? 's' : ''}</span>
            <span style={{ fontSize: '12px', color: textMid }}>{showWeeklyTable ? '▲' : '▼'}</span>
          </div>
        </div>
        {showWeeklyTable && loading && <div style={{ padding: '40px', textAlign: 'center', color: textMid }}>Loading…</div>}
        {showWeeklyTable && error && <div style={{ padding: '20px', color: red }}>{error}</div>}
        {showWeeklyTable && !loading && !error && filteredWeeks.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: textMid }}>No data for selected range</div>
        )}
        {showWeeklyTable && !loading && filteredWeeks.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: isDark ? '#252b3b' : '#f8fafc' }}>
                  {['Week', 'Options', 'Stock Δ', 'Other Stocks', 'Net'].map((h, hi) => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: '12px', fontWeight: '700',
                      color: text, borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap',
                      width: hi === 0 ? '35%' : undefined }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredWeeks.map((week, i) => {
                  const { monday, friday } = getMondayOfWeek(week.weekStart)
                  const stockDeltaTotal = week.stockDelta ? Object.values(week.stockDelta).reduce((s, v) => s + v, 0) : null
                  const stockTooltip = week.stockDelta ? Object.entries(week.stockDelta).map(([t, v]) => `${t}: ${v >= 0 ? '+' : ''}${fmt(v)}`).join(', ') : null
                  const otherDeltaTotal = week.otherStockDelta ? Object.values(week.otherStockDelta).reduce((s, v) => s + v, 0) : null
                  const otherTooltip = week.otherStockDelta ? Object.entries(week.otherStockDelta).map(([t, v]) => `${t}: ${v >= 0 ? '+' : ''}${fmt(v)}`).join(', ') : null
                  const net = week.totalDelta + (stockDeltaTotal ?? 0) + (otherDeltaTotal ?? 0)
                  return (
                    <tr key={week.weekStart} style={{ borderBottom: `1px solid ${border}`, background: i % 2 === 0 ? 'transparent' : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)') }}>
                      <td style={{ padding: '10px 12px', color: text }}>
                        <span style={{ fontWeight: '600' }}>{fmtDate(monday)}</span>
                        <span style={{ color: textMid, marginLeft: '6px', fontSize: '12px' }}>&#8211; {fmtDate(friday)}</span>
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: '600', color: week.totalDelta >= 0 ? green : red }}>
                        {week.totalDelta >= 0 ? '+' : ''}{fmt(week.totalDelta)}
                      </td>
                      <td title={stockTooltip || ''} style={{ padding: '10px 12px', color: stockDeltaTotal == null ? textMid : (stockDeltaTotal >= 0 ? green : red), cursor: stockTooltip ? 'help' : 'default' }}>
                        {stockDeltaTotal == null ? '—' : `${stockDeltaTotal >= 0 ? '+' : ''}${fmt(stockDeltaTotal)}`}
                      </td>
                      <td title={otherTooltip || ''} style={{ padding: '10px 12px', color: otherDeltaTotal == null ? textMid : (otherDeltaTotal >= 0 ? green : red), cursor: otherTooltip ? 'help' : 'default' }}>
                        {otherDeltaTotal == null ? '—' : `${otherDeltaTotal >= 0 ? '+' : ''}${fmt(otherDeltaTotal)}`}
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: '700', color: net >= 0 ? green : red }}>
                        {net >= 0 ? '+' : ''}{fmt(net)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: isDark ? '#252b3b' : '#f8fafc', borderTop: `2px solid ${border}` }}>
                  <td style={{ padding: '10px 16px', fontWeight: '700', color: text }}>Total</td>
                  <td style={{ padding: '10px 16px', fontWeight: '700', color: rangeTotal >= 0 ? green : red }}>
                    {rangeTotal >= 0 ? '+' : ''}{fmt(rangeTotal)}
                  </td>
                  {(() => {
                    const stockTotal = filteredWeeks.reduce((s, w) => w.stockDelta ? s + Object.values(w.stockDelta).reduce((a, b) => a + b, 0) : s, 0)
                    const otherTotal = filteredWeeks.reduce((s, w) => w.otherStockDelta ? s + Object.values(w.otherStockDelta).reduce((a, b) => a + b, 0) : s, 0)
                    const hasStock = filteredWeeks.some(w => w.stockDelta)
                    const hasOther = filteredWeeks.some(w => w.otherStockDelta)
                    const netTotal = rangeTotal + stockTotal + otherTotal
                    return <>
                      <td style={{ padding: '10px 12px', fontWeight: '700', color: stockTotal >= 0 ? green : red }}>{hasStock ? `${stockTotal >= 0 ? '+' : ''}${fmt(stockTotal)}` : '—'}</td>
                      <td style={{ padding: '10px 12px', fontWeight: '700', color: otherTotal >= 0 ? green : red }}>{hasOther ? `${otherTotal >= 0 ? '+' : ''}${fmt(otherTotal)}` : '—'}</td>
                      <td style={{ padding: '10px 12px', fontWeight: '700', color: netTotal >= 0 ? green : red }}>{`${netTotal >= 0 ? '+' : ''}${fmt(netTotal)}`}</td>
                    </>
                  })()}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Open Option Positions */}
      <div style={{ ...cardStyle, marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontWeight: '700', fontSize: '14px', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Open Option Positions</div>
          {openPositions.length > 0 && livePositions?.positions?.some(p => p.unrealizedPnl != null) && (
            <div style={{ fontWeight: '800', fontSize: '1.1rem', color: totalUnrealizedPnl >= 0 ? green : red }}>
              {fmt(totalUnrealizedPnl)} unrealized
            </div>
          )}
        </div>
        {posError && <div style={{ fontSize: '12px', color: red, marginBottom: '8px' }}>Error: {posError}</div>}
        {livePositions && (
          <div style={{ fontSize: '11px', color: textMid, marginBottom: '8px', fontFamily: 'monospace', lineHeight: '1.6' }}>
            <div>Stocks (Polygon): {Object.entries(stockPriceByTicker).map(([t, p]) => `${t}=$${p}`).join(' · ') || 'none (using Yahoo fallback in cards)'}</div>
            <div>Marks: {(livePositions.positions || []).map(p => `${p.ticker}${p.strike}${p.optionType[0].toUpperCase()} mark=$${p.markPrice} remPrem=$${remPremByTicker[p.ticker]?.shortCall ?? remPremByTicker[p.ticker]?.longPut ?? 'null'}`).join(' · ') || 'none'}</div>
          </div>
        )}
        {openPositions.length === 0 ? (
          <div style={{ fontSize: '13px', color: textMid }}>No open positions detected — upload your latest CSV to see open contracts.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {openPositions.map((pos, i) => {
              const hasPrice = pos.markPrice > 0
              const pnlColor = pos.unrealizedPnl == null ? textMid : (pos.unrealizedPnl >= 0 ? green : red)
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: isDark ? '#161926' : '#f8fafc', borderRadius: '8px', border: `1px solid ${border}` }}>
                  <div>
                    <div style={{ fontWeight: '700', fontSize: '14px', color: text }}>
                      {pos.ticker} ${pos.strike} {pos.optionType?.toUpperCase()}&nbsp;
                      <span style={{ fontSize: '12px', fontWeight: '500', color: pos.isLong ? green : '#f59e0b' }}>{pos.isLong ? 'LONG' : 'SHORT'}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: textMid, marginTop: '2px' }}>
                      Exp {pos.expiry} · {pos.openContracts} contract{pos.openContracts !== 1 ? 's' : ''} · avg cost {fmt(pos.avgCostPerContract)}/contract
                      {pos.stockPrice ? <span style={{ marginLeft: '8px', color: text }}>{pos.ticker} @ {fmt(pos.stockPrice)}</span> : null}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: '700', fontSize: '14px', color: pnlColor }}>
                      {pos.unrealizedPnl == null ? '—' : fmt(pos.unrealizedPnl)}
                    </div>
                    <div style={{ fontSize: '12px', color: textMid }}>
                      mark {hasPrice ? fmt(pos.markPrice) : (posLoading ? '…' : 'N/A')}
                    </div>
                    {pos.remainingPremium != null && (
                      <div style={{ fontSize: '12px', color: '#f59e0b', marginTop: '2px' }}>
                        {pos.remainingPremiumLabel || 'Rem. Premium'}: {fmt(pos.remainingPremium)}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {livePositions?.expiredFiltered > 0 && (
          <div style={{ fontSize: '11px', color: textMid, marginTop: '8px' }}>
            {livePositions.expiredFiltered} expired contract{livePositions.expiredFiltered !== 1 ? 's' : ''} hidden — re-upload CSV to reconcile
          </div>
        )}
      </div>
    </div>
  )
}
