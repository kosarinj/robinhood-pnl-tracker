import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import IntradayChart, { RSIBadge } from './IntradayChart'

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
  const [expandedOpenPos, setExpandedOpenPos] = useState({})
  const [tradeSearch, setTradeSearch] = useState('')
  const [showWeeklyTable, setShowWeeklyTable] = useState(false)
  const [livePositions, setLivePositions] = useState(null)
  const [posLoading, setPosLoading] = useState(false)
  const [posError, setPosError] = useState(null)
  const [asOfDate, setAsOfDate] = useState('')
  const [activeTab, setActiveTab] = useState('week')
  const [byUnderlyingWeeks, setByUnderlyingWeeks] = useState(1)
  const [weekOffset, setWeekOffset] = useState(0) // 0 = current week, 1 = 1W ago, etc.
  const [chartTicker, setChartTicker] = useState(null)
  const [whatIfData, setWhatIfData] = useState(null)
  const [whatIfLoading, setWhatIfLoading] = useState(false)
  const [whatIfError, setWhatIfError] = useState(null)
  const [showWhatIf, setShowWhatIf] = useState(false)
  const [whatIfWeek, setWhatIfWeek] = useState(null) // null = current week, or 'YYYY-MM-DD'
  const [showScenario, setShowScenario] = useState(false)
  const [scenarioMarks, setScenarioMarks] = useState({})

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

  // Cumulative by-underlying: sum byUnderlying + stockDelta across the last N weeks (sorted desc)
  const { cumulativeByUnderlying, cumulativeRealizedByUnderlying, cumulativeStockDelta, weeklyBreakdown, cumulativeStockPrices, sliceFromDate, sliceToDate, historicalWeeks, numWeeks } = (() => {
    const weeks = data?.weeks || []
    const currentWeekStart = data?.weekStart || ''
    // Only include weeks up to and including the current week — exclude future expiry weeks
    const sorted = [...weeks]
      .filter(w => !currentWeekStart || w.weekStart <= currentWeekStart)
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    const slice = byUnderlyingWeeks === 0 ? sorted : sorted.slice(0, byUnderlyingWeeks)
    const options = {}
    const realized = {}
    const stock = {}
    const breakdown = {} // ticker → [{ weekStart, optPnl, stockPnl }]
    const stockPrices = {} // ticker → { fromPrice (oldest week), toPrice (newest week), shares }
    slice.forEach((w, i) => {
      const isCurrentWeek = w.weekStart === currentWeekStart
      Object.entries(w.byUnderlying || {}).forEach(([ticker, val]) => {
        // Current week: byUnderlying includes premiums paid for still-open positions which
        // are already in unrealizedByTicker — use realizedByUnderlying (closed legs only)
        // so there's no double-count. Historical weeks are all closed so byUnderlying is correct.
        const contribution = isCurrentWeek ? (w.realizedByUnderlying?.[ticker] ?? 0) : val
        options[ticker] = (options[ticker] || 0) + contribution
        if (!breakdown[ticker]) breakdown[ticker] = []
        const existing = breakdown[ticker].find(e => e.weekStart === w.weekStart)
        if (existing) existing.optPnl = (existing.optPnl || 0) + contribution
        else breakdown[ticker].push({ weekStart: w.weekStart, optPnl: contribution, stockPnl: null })
      })
      Object.entries(w.realizedByUnderlying || {}).forEach(([ticker, val]) => {
        realized[ticker] = (realized[ticker] || 0) + val
        if (!breakdown[ticker]) breakdown[ticker] = []
        const existing = breakdown[ticker].find(e => e.weekStart === w.weekStart)
        const calls = w.realizedCallsByUnderlying?.[ticker]
        const puts = w.realizedPutsByUnderlying?.[ticker]
        if (existing) { existing.realizedPnl = val; if (calls != null) existing.realizedCalls = calls; if (puts != null) existing.realizedPuts = puts }
        else breakdown[ticker].push({ weekStart: w.weekStart, optPnl: null, stockPnl: null, realizedPnl: val, realizedCalls: calls ?? null, realizedPuts: puts ?? null })
      })
      Object.entries(w.stockDelta || {}).forEach(([ticker, val]) => {
        stock[ticker] = (stock[ticker] || 0) + val
        if (!breakdown[ticker]) breakdown[ticker] = []
        const existing = breakdown[ticker].find(e => e.weekStart === w.weekStart)
        if (existing) existing.stockPnl = val
        else breakdown[ticker].push({ weekStart: w.weekStart, optPnl: null, stockPnl: val })
      })
      Object.entries(w.stockPrices || {}).forEach(([ticker, prices]) => {
        if (!stockPrices[ticker]) {
          // Most recent week — store its fromPrice and shares separately so older weeks
          // can contribute their own share-count-based P&L correctly
          stockPrices[ticker] = {
            fromPrice: prices.fromPrice,   // will be updated to oldest week's fromPrice
            toPrice: prices.toPrice,
            shares: prices.shares,
            recentFromPrice: prices.fromPrice,
            recentShares: prices.shares,
            olderWeeksStockPnl: 0
          }
        } else {
          // Older week — accumulate its P&L using that week's actual share count
          stockPrices[ticker].fromPrice = prices.fromPrice
          if (prices.fromPrice != null && prices.toPrice != null && prices.shares) {
            stockPrices[ticker].olderWeeksStockPnl += (prices.toPrice - prices.fromPrice) * prices.shares
          }
        }
      })
    })
    // Sort each ticker's breakdown newest first
    Object.values(breakdown).forEach(arr => arr.sort((a, b) => b.weekStart.localeCompare(a.weekStart)))
    // Date range for the slice
    const fromWeek = slice[slice.length - 1]?.weekStart
    const toWeek = slice[0]?.weekStart
    const sliceFromDate = fromWeek ? fromWeek : null
    // Use Friday of the toWeek, but cap at today so current partial week doesn't show future date
    const sliceToDate = toWeek ? (() => {
      const d = new Date(toWeek + 'T12:00:00'); d.setDate(d.getDate() + 4)
      const today = new Date(); today.setHours(0,0,0,0)
      return (d <= today ? d : today).toISOString().slice(0, 10)
    })() : null
    return { cumulativeByUnderlying: options, cumulativeRealizedByUnderlying: realized, cumulativeStockDelta: stock, weeklyBreakdown: breakdown, cumulativeStockPrices: stockPrices, sliceFromDate, sliceToDate, historicalWeeks: sorted.filter(w => w.weekStart !== currentWeekStart), numWeeks: slice.length }
  })()
  const totalStockPnL = Object.values(data?.weeklyStockPnL || {}).reduce((s, v) => s + (v?.pnl ?? v), 0)
  const otherStockPnL = data?.otherStockPnL || 0
  const preMarketPrices = data?.preMarketPrices || {}
  // Use live positions from dedicated endpoint (with Polygon prices), fall back to history data
  const openPositions = livePositions?.positions || data?.openOptionPositions || []
  // Short puts are a trading mistake (should always be long) — flag them prominently
  const shortPutsByTicker = openPositions.reduce((m, p) => {
    if (!p.isLong && p.optionType === 'put') {
      if (!m[p.ticker]) m[p.ticker] = []
      m[p.ticker].push({ strike: p.strike, expiry: p.expiry })
    }
    return m
  }, {})
  const hasShortPuts = Object.keys(shortPutsByTicker).length > 0
  const hasPrices = openPositions.some(p => p.unrealizedPnl != null)
  const totalUnrealizedPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)
  // When viewing a past week (asOfDate set), unrealized P&L uses today's Polygon prices — not meaningful
  // for historical views, so exclude it and show realized-only for options
  const isHistoricalView = !!asOfDate
  const optionsWeekPnL = hasPrices && !isHistoricalView
    ? (data?.currentWeekRealizedTotal || 0) + totalUnrealizedPnl
    : (data?.currentWeekRealizedTotal || data?.currentWeekPnL || 0)
  const netWeekPnL = optionsWeekPnL + totalStockPnL + otherStockPnL
  // Next-week unrealized: positions expiring after this Friday and up to next Friday
  const thisWeekFriday = data?.weekStart
    ? (() => { const d = new Date(data.weekStart + 'T12:00:00'); d.setDate(d.getDate() + 4); return d.toISOString().slice(0, 10) })()
    : null
  const nextWeekFriday = thisWeekFriday
    ? (() => { const d = new Date(thisWeekFriday + 'T12:00:00'); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10) })()
    : null
  // Unrealized P&L grouped by underlying ticker (only shown for current week)
  const unrealizedByTicker = !isHistoricalView
    ? openPositions.reduce((m, p) => {
        if (p.unrealizedPnl != null) {
          m[p.ticker] = (m[p.ticker] || 0) + p.unrealizedPnl
        }
        return m
      }, {})
    : {}
  const nextWeekUnrealizedByTicker = !isHistoricalView && thisWeekFriday
    ? openPositions.reduce((m, p) => {
        if (p.unrealizedPnl != null && p.expiry > thisWeekFriday && (!nextWeekFriday || p.expiry <= nextWeekFriday))
          m[p.ticker] = (m[p.ticker] || 0) + p.unrealizedPnl
        return m
      }, {})
    : {}
  // Stock price by ticker:
  // For historical views use only server-computed historical prices (Yahoo Finance for asOf date)
  // For current view also override with Polygon live underlying_asset.price when available (market hours)
  const stockPriceByTicker = {
    // Yahoo Finance prices for the asOf date (or today) for stocks user holds
    ...Object.fromEntries(Object.entries(data?.weeklyStockPnL || {}).filter(([, e]) => (e?.toPrice ?? 0) > 0).map(([sym, e]) => [sym, e.toPrice])),
    // Yahoo Finance prices for option-only underlyings
    ...(data?.optionUnderlyingPrices || {}),
    // Polygon live prices only when viewing current week (not historical)
    ...(!isHistoricalView ? openPositions.reduce((m, p) => { if (p.stockPrice > 0) m[p.ticker] = p.stockPrice; return m }, {}) : {})
  }
  // Remaining premium — compute client-side using stock prices already in stockPriceByTicker
  const remPremByTicker = openPositions.reduce((m, p) => {
    const stockPrice = stockPriceByTicker[p.ticker]
    const mark = p.markPrice
    if (!stockPrice || !mark) return m
    if (!p.isLong && p.optionType === 'call') {
      const extrinsic = Math.round(Math.max(0, mark - Math.max(0, stockPrice - p.strike)) * 100) / 100
      if (extrinsic > 0) {
        if (!m[p.ticker]) m[p.ticker] = { shortCall: null, longPut: null, shortCallPositions: [], longPutPositions: [] }
        m[p.ticker].shortCall = Math.round(((m[p.ticker].shortCall || 0) + extrinsic) * 100) / 100
        if (p.strike && !m[p.ticker].shortCallPositions.some(x => x.strike === p.strike)) m[p.ticker].shortCallPositions.push({ strike: p.strike, mark })
      }
    } else if (p.isLong && p.optionType === 'put') {
      const extrinsic = Math.round(Math.max(0, mark - Math.max(0, p.strike - stockPrice)) * 100) / 100
      if (extrinsic > 0) {
        if (!m[p.ticker]) m[p.ticker] = { shortCall: null, longPut: null, shortCallPositions: [], longPutPositions: [] }
        m[p.ticker].longPut = Math.round(((m[p.ticker].longPut || 0) + extrinsic) * 100) / 100
        if (p.strike && !m[p.ticker].longPutPositions.some(x => x.strike === p.strike)) m[p.ticker].longPutPositions.push({ strike: p.strike, mark })
      }
    }
    return m
  }, {})

  const fetchWhatIf = async (overrideWeek) => {
    const week = overrideWeek !== undefined ? overrideWeek : whatIfWeek
    setWhatIfLoading(true)
    setWhatIfError(null)
    try {
      const url = week ? `/api/whatif?week=${week}` : '/api/whatif'
      const res = await fetch(url, { credentials: 'include' })
      const json = await res.json()
      if (json.success) setWhatIfData(json.whatIf)
      else setWhatIfError(json.error)
    } catch (e) {
      setWhatIfError(e.message)
    } finally {
      setWhatIfLoading(false)
    }
  }

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
      {/* Intraday chart modal */}
      {chartTicker && (
        <IntradayChart symbol={chartTicker} isDark={isDark} onClose={() => setChartTicker(null)} />
      )}
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
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: `2px solid ${border}`, paddingBottom: '0' }}>
        {[['week', 'This Week'], ['history', 'History']].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{
            padding: '8px 20px', fontSize: '13px', fontWeight: '600', border: 'none', cursor: 'pointer',
            background: 'none', borderBottom: activeTab === key ? `2px solid #667eea` : '2px solid transparent',
            marginBottom: '-2px', color: activeTab === key ? '#667eea' : textMid,
            transition: 'color 0.15s'
          }}>{label}</button>
        ))}
      </div>
      {hasShortPuts && (
        <div style={{ marginBottom: '12px', padding: '10px 14px', borderRadius: '8px', background: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)', border: '1.5px solid #ef4444', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
          <span style={{ fontSize: '18px', lineHeight: 1 }}>⚠️</span>
          <div>
            <div style={{ fontWeight: '700', color: '#ef4444', fontSize: '13px', marginBottom: '2px' }}>SHORT PUT DETECTED — trading mistake?</div>
            <div style={{ fontSize: '12px', color: isDark ? '#fca5a5' : '#b91c1c' }}>
              {Object.entries(shortPutsByTicker).map(([ticker, puts]) =>
                `${ticker}: ${puts.map(p => `$${p.strike} exp ${p.expiry}`).join(', ')}`
              ).join(' · ')}
            </div>
          </div>
        </div>
      )}
      {activeTab === 'week' && <>
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
                      {preMarketPrices[sym] && (
                        <span style={{ color: preMarketPrices[sym].changePct >= 0 ? green : red, marginLeft: '4px', fontSize: '10px' }}>
                          Pre {preMarketPrices[sym].changePct >= 0 ? '+' : ''}{preMarketPrices[sym].changePct?.toFixed(2)}%
                        </span>
                      )}
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
          <div>
            <div style={{ fontSize: '13px', fontWeight: '700', color: text }}>By Underlying</div>
            {sliceFromDate && <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>{fmtDate(sliceFromDate)} – {fmtDate(sliceToDate)}</div>}
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {[['1W', 1], ['NW', -1], ['2W', 2], ['3W', 3], ['4W', 4], ['5W', 5], ['6W', 6], ['7W', 7], ['8W', 8], ['All', 0]].map(([label, val]) => (
              <button key={label} onClick={() => setByUnderlyingWeeks(val)}
                style={{ ...btnStyle(byUnderlyingWeeks === val), padding: '3px 10px', fontSize: '11px' }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Total Investment strip — stock value + net options premium per ticker */}
        {!isHistoricalView && openPositions.length > 0 && (() => {
          // Build options map: shortCredit = premium received, longCost = premium paid
          const optsByTicker = {}
          openPositions.forEach(pos => {
            const t = pos.ticker || 'Unknown'
            if (!optsByTicker[t]) optsByTicker[t] = { shortCredit: 0, longCost: 0, contracts: 0 }
            const amount = Math.round(pos.avgCostPerContract * pos.openContracts * 100) / 100
            if (pos.isLong) optsByTicker[t].longCost += amount
            else optsByTicker[t].shortCredit += amount
            optsByTicker[t].contracts += pos.openContracts
          })
          // Union of tickers that have either stock or open options
          const allTickers = [...new Set([
            ...Object.keys(optsByTicker),
            ...Object.keys(data?.weeklyStockPnL || {})
          ])].sort()
          let grandTotal = 0
          const rows = allTickers.map(ticker => {
            const opts = optsByTicker[ticker] || { shortCredit: 0, longCost: 0, contracts: 0 }
            const stockEntry = data?.weeklyStockPnL?.[ticker]
            const shares = stockEntry?.shares ?? 0
            const price = stockPriceByTicker[ticker] || stockEntry?.toPrice || 0
            const stockValue = shares > 0 && price > 0 ? Math.round(shares * price * 100) / 100 : 0
            const optionsNet = Math.round((opts.shortCredit - opts.longCost) * 100) / 100
            const total = Math.round((stockValue - optionsNet) * 100) / 100
            if (stockValue === 0 && opts.contracts === 0) return null
            grandTotal += total
            return { ticker, stockValue, shortCredit: opts.shortCredit, longCost: opts.longCost, contracts: opts.contracts, optionsNet, total }
          }).filter(Boolean)
          grandTotal = Math.round(grandTotal * 100) / 100
          if (rows.length === 0) return null
          return (
            <div style={{ borderTop: `1px solid ${border}`, paddingTop: '10px', marginBottom: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em', color: textMid }}>Total Investment</div>
                <div style={{ fontSize: '12px', fontWeight: '700', color: text }}>{fmt(grandTotal)}</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {rows.map(({ ticker, stockValue, shortCredit, longCost, contracts, optionsNet, total }) => (
                  <div key={ticker} style={{
                    padding: '5px 10px', borderRadius: '8px', fontSize: '11px',
                    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                    border: `1px solid ${border}`,
                    display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '130px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                      <span style={{ fontWeight: '700', color: text }}>{ticker}</span>
                      <span style={{ fontWeight: '700', color: text }}>{fmt(total)}</span>
                    </div>
                    {stockValue > 0 && (
                      <div style={{ fontSize: '10px', color: textMid }}>Stock: {fmt(stockValue)}</div>
                    )}
                    {contracts > 0 && (
                      <div style={{ fontSize: '10px', color: optionsNet >= 0 ? green : red }}>
                        Options ({contracts}c): {optionsNet >= 0 ? '−' : '+'}{fmt(Math.abs(optionsNet))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
        {/* Per-underlying breakdown — single week (detailed) or multi-week (options total only) */}
        {byUnderlyingWeeks !== 1 && byUnderlyingWeeks !== -1 && Object.keys(cumulativeByUnderlying).length > 0 && (
          <div style={{ paddingTop: '12px', borderTop: `1px solid ${border}` }}>
            {(() => {
              // Current week: use the same netWeekPnL the 1W view shows so NW Total Net = 1W + 1W ago + ...
              const histSlice = byUnderlyingWeeks === 0 ? historicalWeeks : historicalWeeks.slice(0, byUnderlyingWeeks - 1)
              const histContrib = histSlice.reduce((sum, w) => {
                return sum + Object.entries(w.byUnderlying || {}).reduce((s, [ticker, optPnl]) => {
                  return s + optPnl + (w.stockDelta?.[ticker] ?? 0)
                }, 0)
              }, 0)
              const total = Math.round((netWeekPnL + histContrib) * 100) / 100
              const avgPerWk = numWeeks > 0 ? Math.round(total / numWeeks * 100) / 100 : null
              return <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '12px', fontWeight: '700', color: total >= 0 ? green : red }}>
                  Total Net: {total >= 0 ? '+' : ''}{fmt(total)}
                </div>
                {avgPerWk !== null && numWeeks > 1 && (
                  <div style={{ fontSize: '11px', color: avgPerWk >= 0 ? green : red }}>
                    avg/wk: {avgPerWk >= 0 ? '+' : ''}{fmt(avgPerWk)}
                  </div>
                )}
              </div>
            })()}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {Object.entries(cumulativeByUnderlying)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([ticker, optPnl]) => {
                  const priceRange = cumulativeStockPrices[ticker]
                  const livePrice = stockPriceByTicker[ticker]
                  const displayToPrice = livePrice ?? priceRange?.toPrice
                  const unrealizedPnl = unrealizedByTicker[ticker]
                  const realizedPnl = cumulativeRealizedByUnderlying[ticker]
                  const sp = livePrice
                  const liveStockEntry = data?.weeklyStockPnL?.[ticker]
                  // Stock P&L = sum of each individual week's stock P&L, using the same sources
                  // as the 1W individual view: historicalWeeks[i].stockDelta for past weeks,
                  // data.weeklyStockPnL for the current week. This guarantees NW = 1W + 1W ago + ...
                  const histWeeksForStock = byUnderlyingWeeks === 0
                    ? historicalWeeks
                    : historicalWeeks.slice(0, byUnderlyingWeeks - 1)
                  const histStockSum = histWeeksForStock.reduce((sum, w) => sum + (w.stockDelta?.[ticker] ?? 0), 0)
                  const hasHistStock = histWeeksForStock.some(w => w.stockDelta?.[ticker] !== undefined)
                  const totalStock = hasHistStock || liveStockEntry != null
                    ? Math.round((histStockSum + (liveStockEntry?.pnl ?? 0)) * 100) / 100
                    : undefined
                  if (byUnderlyingWeeks === 2) {
                    const breakdown = histWeeksForStock.map(w => `${w.weekStart}:${w.stockDelta?.[ticker] ?? 'n/a'}`).join(', ')
                    console.log(`[2W stock] ${ticker}: histSum=${histStockSum} (${breakdown}) live=${liveStockEntry?.pnl} cumDelta=${cumulativeStockDelta[ticker]} total=${totalStock}`)
                  }
                  const optTotal = optPnl + (unrealizedPnl ?? 0)
                  const combined = totalStock !== undefined ? optTotal + totalStock : null
                  const shares = priceRange?.shares ?? liveStockEntry?.shares
                  // Scale only stock P&L to 100sh — options/unrealized are independent of share count
                  const combined100 = combined != null && shares && shares !== 100 && totalStock !== undefined
                    ? Math.round((combined - totalStock + totalStock * 100 / shares) * 100) / 100
                    : null
                  const rp = remPremByTicker[ticker]
                  // Max = combined + stock gain to the lowest short call strike (upside cap)
                  // Floor = combined + stock change to the highest long put strike (downside floor)
                  const shortCallStrike = rp?.shortCallPositions?.length > 0
                    ? Math.min(...rp.shortCallPositions.map(p => p.strike))
                    : null
                  const longPutStrike = rp?.longPutPositions?.length > 0
                    ? Math.max(...rp.longPutPositions.map(p => p.strike))
                    : null
                  const maxNet = combined !== null && shortCallStrike != null && livePrice && shares
                    ? Math.round((combined + (shortCallStrike - livePrice) * shares) * 100) / 100
                    : null
                  const floorNet = combined !== null && longPutStrike != null && livePrice && shares
                    ? Math.round((combined + (longPutStrike - livePrice) * shares) * 100) / 100
                    : null
                  const isExpanded = expandedTicker === ticker
                  const wkBreakdown = weeklyBreakdown[ticker] || []
                  return (
                    <div key={ticker} style={{ minWidth: '140px', flex: '1 1 140px', maxWidth: '260px' }}>
                      <div
                        onClick={() => setExpandedTicker(isExpanded ? null : ticker)}
                        style={{ padding: '8px 12px', borderRadius: isExpanded ? '8px 8px 0 0' : '8px', fontSize: '12px', cursor: 'pointer',
                          background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                          border: `1px solid ${border}`, borderBottom: isExpanded ? 'none' : undefined }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <span style={{ fontWeight: '700', color: text }}>
                            {ticker}{sp ? <span style={{ fontWeight: '400', color: textMid, marginLeft: '6px' }}>{fmt(sp)}</span> : null}
                            {shortPutsByTicker[ticker] && <span style={{ marginLeft: '6px', fontSize: '10px', background: '#ef4444', color: '#fff', borderRadius: '4px', padding: '1px 5px', fontWeight: '700' }}>SHORT PUT ⚠</span>}
                          </span>
                          <span style={{ color: textMid, fontSize: '10px' }}>{isExpanded ? '▲' : '▼'}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ color: optPnl >= 0 ? green : red }}>Options: {optPnl >= 0 ? '+' : ''}{fmt(optPnl)}</div>
                          {totalStock !== undefined && (
                            <div style={{ color: totalStock >= 0 ? green : red }}>
                              Stock: {totalStock >= 0 ? '+' : ''}{fmt(totalStock)}
                              {priceRange && displayToPrice && <span style={{ color: textMid, fontSize: '10px', marginLeft: '5px' }}>${priceRange.fromPrice.toFixed(2)} → ${displayToPrice.toFixed(2)}</span>}
                            </div>
                          )}
                          {unrealizedPnl !== undefined && <div style={{ color: unrealizedPnl >= 0 ? green : red }}>Unrealized: {unrealizedPnl >= 0 ? '+' : ''}{fmt(unrealizedPnl)}</div>}
                          {preMarketPrices[ticker] && (
                            <div style={{ color: textMid, fontSize: '10px' }}>
                              Pre: ${preMarketPrices[ticker].price.toFixed(2)}
                              {preMarketPrices[ticker].changePct != null && (
                                <span style={{ marginLeft: '4px', color: preMarketPrices[ticker].changePct >= 0 ? green : red }}>
                                  {preMarketPrices[ticker].changePct >= 0 ? '+' : ''}{preMarketPrices[ticker].changePct.toFixed(2)}%
                                </span>
                              )}
                            </div>
                          )}
                          {!isHistoricalView && <RSIBadge symbol={ticker} isDark={isDark} onClick={setChartTicker} />}
                          {combined !== null && <div style={{ color: combined >= 0 ? green : red, fontWeight: '700', borderTop: `1px solid ${border}`, paddingTop: '2px', marginTop: '2px' }}>Net: {combined >= 0 ? '+' : ''}{fmt(combined)}</div>}
                          {combined100 !== null && <div style={{ color: combined100 >= 0 ? green : red, fontSize: '10px', color: textMid }}>per 100sh: {combined100 >= 0 ? '+' : ''}{fmt(combined100)}</div>}
                          {maxNet !== null && <div style={{ color: maxNet >= 0 ? green : red, fontSize: '11px' }}>Max: {maxNet >= 0 ? '+' : ''}{fmt(maxNet)}<span style={{ color: textMid }}> @${shortCallStrike}</span></div>}
                          {floorNet !== null && <div style={{ color: floorNet >= 0 ? green : red, fontSize: '11px' }}>Floor: {floorNet >= 0 ? '+' : ''}{fmt(floorNet)}<span style={{ color: textMid }}> @${longPutStrike}</span></div>}
                          {combined !== null && numWeeks > 1 && (() => {
                            const avg = Math.round(combined / numWeeks * 100) / 100
                            return <div style={{ color: textMid, fontSize: '10px' }}>avg/wk: {avg >= 0 ? '+' : ''}{fmt(avg)}</div>
                          })()}
                        </div>
                      </div>
                      {isExpanded && wkBreakdown.length > 0 && (
                        <div style={{ border: `1px solid ${border}`, borderTop: 'none', borderRadius: '0 0 8px 8px',
                          background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.02)', fontSize: '11px' }}>
                          {wkBreakdown.map((wk, i) => {
                            const { monday } = getMondayOfWeek(wk.weekStart)
                            const wkStockPrices = data?.weeks?.find(w => w.weekStart === wk.weekStart)?.stockPrices?.[ticker]
                            return (
                              <div key={wk.weekStart} style={{ padding: '5px 10px', borderBottom: i < wkBreakdown.length - 1 ? `1px solid ${border}` : 'none' }}>
                                <div style={{ color: textMid, marginBottom: '2px', fontWeight: '600' }}>Wk of {fmtDate(monday)}</div>
                                {wk.optPnl != null && wk.optPnl !== 0 && <div style={{ color: wk.optPnl >= 0 ? green : red }}>Options: {wk.optPnl >= 0 ? '+' : ''}{fmt(wk.optPnl)}</div>}
                                {wk.realizedPnl != null && (wk.realizedPnl !== 0 || wk.realizedCalls != null || wk.realizedPuts != null) && <div style={{ color: wk.realizedPnl >= 0 ? green : red, fontSize: '11px' }}>↳ Realized: {wk.realizedPnl >= 0 ? '+' : ''}{fmt(wk.realizedPnl)}</div>}
                                {wk.realizedCalls != null && <div style={{ color: wk.realizedCalls >= 0 ? green : red, fontSize: '11px', paddingLeft: '10px' }}>Calls: {wk.realizedCalls >= 0 ? '+' : ''}{fmt(wk.realizedCalls)}</div>}
                                {wk.realizedPuts != null && <div style={{ color: wk.realizedPuts >= 0 ? green : red, fontSize: '11px', paddingLeft: '10px' }}>Puts: {wk.realizedPuts >= 0 ? '+' : ''}{fmt(wk.realizedPuts)}</div>}
                                {wk.stockPnl != null && (
                                  <div style={{ color: wk.stockPnl >= 0 ? green : red }}>
                                    Stock: {wk.stockPnl >= 0 ? '+' : ''}{fmt(wk.stockPnl)}
                                    {wkStockPrices && <span style={{ color: textMid, marginLeft: '4px' }}>(${wkStockPrices.fromPrice.toFixed(2)} → ${wkStockPrices.toPrice.toFixed(2)})</span>}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          </div>
        )}
        {byUnderlyingWeeks === 1 && (() => {
          // Use the same filtered+sorted historicalWeeks list the multi-week view uses.
          // data?.weeks includes future expiry weeks (e.g. options expiring next Friday),
          // which would make histWeeks[0] = next week, not last week, breaking alignment.
          const histWk = weekOffset > 0 ? historicalWeeks[weekOffset - 1] : null
          const hasData = weekOffset === 0
            ? data?.currentWeekByUnderlying && Object.keys(data.currentWeekByUnderlying).length > 0
            : histWk?.byUnderlying && Object.keys(histWk.byUnderlying).length > 0
          if (!hasData) return null
          const wkByUnderlying = histWk ? histWk.byUnderlying : data.currentWeekByUnderlying
          const wkRealized = histWk ? histWk.realizedByUnderlying : data.currentWeekRealizedByUnderlying
          const wkCalls = histWk ? histWk.realizedCallsByUnderlying : data.currentWeekRealizedCallsByUnderlying
          const wkPuts = histWk ? histWk.realizedPutsByUnderlying : data.currentWeekRealizedPutsByUnderlying
          const wkTrades = histWk ? histWk.tradesByUnderlying : data.currentWeekTradesByUnderlying
          const wkStockByTicker = histWk
            ? Object.fromEntries(Object.entries(histWk.stockDelta || {}).map(([sym, pnl]) => {
                const sp = histWk.stockPrices?.[sym]
                return [sym, { pnl, fromPrice: sp?.fromPrice, toPrice: sp?.toPrice, shares: sp?.shares }]
              }))
            : data.weeklyStockPnL || {}
          const wkLabel = weekOffset === 0 ? 'This Week' : weekOffset === 1 ? '1W Ago' : `${weekOffset}W Ago`
          const maxOffset = historicalWeeks.length
          const wkDateStr = (() => {
            const ws = histWk ? histWk.weekStart : data?.weekStart
            if (!ws) return null
            const { monday, friday } = getMondayOfWeek(ws)
            return `${fmtDate(monday)} – ${fmtDate(friday)}`
          })()
          return (
          <div style={{ paddingTop: '12px', borderTop: `1px solid ${border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div>
                  <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid }}>
                    {wkLabel} by Underlying
                  </div>
                  {wkDateStr && <div style={{ fontSize: '10px', color: textMid, marginTop: '1px' }}>{wkDateStr}</div>}
                </div>
                <div style={{ display: 'flex', gap: '2px' }}>
                  <button onClick={() => setWeekOffset(w => Math.min(w + 1, maxOffset))} disabled={weekOffset >= maxOffset}
                    style={{ ...btnStyle(false), padding: '1px 6px', fontSize: '11px', opacity: weekOffset >= maxOffset ? 0.3 : 1 }}>◀</button>
                  <button onClick={() => setWeekOffset(w => Math.max(w - 1, 0))} disabled={weekOffset === 0}
                    style={{ ...btnStyle(false), padding: '1px 6px', fontSize: '11px', opacity: weekOffset === 0 ? 0.3 : 1 }}>▶</button>
                </div>
              </div>
              {(() => {
                // For the current week, use the same calculation as "Wk — Net Total" so they match.
                // For historical weeks, sum per-ticker cash flow + stock (no unrealized/other stocks).
                const total = weekOffset === 0
                  ? Math.round(netWeekPnL * 100) / 100
                  : Object.entries(wkByUnderlying).reduce((sum, [ticker, optPnl]) => {
                      const stockEntry = wkStockByTicker[ticker]
                      const stockPnl = stockEntry ? (stockEntry?.pnl ?? stockEntry ?? 0) : 0
                      return sum + optPnl + stockPnl
                    }, 0)
                const totalRemAdj = weekOffset === 0
                  ? Math.round((total + Object.values(remPremByTicker).reduce((sum, rp) =>
                      sum + (rp.shortCall ?? 0) * 100 - (rp.longPut ?? 0) * 100, 0)) * 100) / 100
                  : null
                return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '700', color: total >= 0 ? green : red }}>
                    Total Net: {total >= 0 ? '+' : ''}{fmt(total)}
                  </div>
                  {totalRemAdj !== null && <div style={{ fontSize: '11px', fontWeight: '700', color: totalRemAdj >= 0 ? green : red }}>
                    Total Net + Rem: {totalRemAdj >= 0 ? '+' : ''}{fmt(totalRemAdj)}
                  </div>}
                </div>
              })()}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {/* Tickers with open positions but no current-week trades (current week only) */}
              {weekOffset === 0 && Object.entries(unrealizedByTicker)
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
                          {rp?.shortCall != null && <div style={{ color: '#f59e0b' }}>Rem Short Call: {fmt(rp.shortCall)}{rp.shortCallPositions?.length > 0 && ` (${rp.shortCallPositions.map(x => `$${x.strike} @ $${x.mark}`).join(' / ')})`}</div>}
                          {rp?.longPut != null && <div style={{ color: '#f59e0b' }}>Rem Long Put: {fmt(rp.longPut)}{rp.longPutPositions?.length > 0 && ` (${rp.longPutPositions.map(x => `$${x.strike} @ $${x.mark}`).join(' / ')})`}</div>}
                        </div>
                      </div>
                    </div>
                  )
                })
              }
              {Object.entries(wkByUnderlying).sort((a, b) => a[0].localeCompare(b[0])).map(([ticker, optPnl]) => {
                const stockEntry = wkStockByTicker[ticker]
                const stockPnl = stockEntry !== undefined ? (stockEntry?.pnl ?? stockEntry) : undefined
                const stockTooltip = stockEntry?.fromPrice ? `${stockEntry.shares ?? ''} shares · $${stockEntry.fromPrice.toFixed(2)} → $${stockEntry.toPrice.toFixed(2)}` : undefined
                const unrealizedPnl = weekOffset === 0 ? unrealizedByTicker[ticker] : undefined
                const rp = weekOffset === 0 ? remPremByTicker[ticker] : null
                const trades = wkTrades?.[ticker] || []
                const realizedPnl = wkRealized?.[ticker]
                const realizedCalls = wkCalls?.[ticker]
                const realizedPuts = wkPuts?.[ticker]
                // Current week: realized (closed legs) + unrealized (open legs, Polygon) + stock
                // Historical weeks: optPnl (cash flow, all closed) + stock
                const combined = weekOffset === 0
                  ? (realizedPnl ?? 0) + (unrealizedPnl ?? 0) + (stockPnl ?? 0)
                  : stockPnl !== undefined || unrealizedPnl !== undefined
                    ? optPnl + (unrealizedPnl ?? 0) + (stockPnl ?? 0)
                    : optPnl || null
                const shares1w = stockEntry?.shares
                // Scale only stock P&L to 100sh — options/unrealized are independent of share count
                const combined100 = combined != null && shares1w && shares1w !== 100 && stockPnl !== undefined
                  ? Math.round((combined - stockPnl + stockPnl * 100 / shares1w) * 100) / 100
                  : null
                const isExpanded = expandedTicker === ticker
                const sp = weekOffset === 0 ? (stockPriceByTicker[ticker] || stockEntry?.toPrice) : stockEntry?.toPrice
                return (
                  <div key={ticker} style={{ minWidth: '140px', flex: '1 1 140px', maxWidth: '260px' }}>
                    <div
                      onClick={() => { setExpandedTicker(isExpanded ? null : ticker); setTradeSearch('') }}
                      style={{
                        padding: '8px 12px', borderRadius: isExpanded ? '8px 8px 0 0' : '8px',
                        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                        border: `1px solid ${border}`,
                        fontSize: '12px', cursor: trades.length > 0 ? 'pointer' : 'default',
                        borderBottom: isExpanded ? 'none' : `1px solid ${border}`
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '700', color: text }}>
                          {ticker}{sp ? <span style={{ fontWeight: '400', color: textMid, marginLeft: '6px' }}>{fmt(sp)}</span> : null}
                          {shortPutsByTicker[ticker] && <span style={{ marginLeft: '6px', fontSize: '10px', background: '#ef4444', color: '#fff', borderRadius: '4px', padding: '1px 5px', fontWeight: '700' }}>SHORT PUT ⚠</span>}
                        </span>
                        {trades.length > 0 && <span style={{ color: textMid, fontSize: '10px' }}>{isExpanded ? '▲' : '▼'} {trades.length} trade{trades.length !== 1 ? 's' : ''}</span>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {optPnl !== 0 && <div style={{ color: optPnl >= 0 ? green : red }}>
                          Options: {optPnl >= 0 ? '+' : ''}{fmt(optPnl)}
                        </div>}
                        {realizedPnl != null && (realizedPnl !== 0 || realizedCalls != null || realizedPuts != null) && (
                          <div style={{ color: realizedPnl >= 0 ? green : red, fontSize: '11px' }}>
                            ↳ Realized: {realizedPnl >= 0 ? '+' : ''}{fmt(realizedPnl)}
                          </div>
                        )}
                        {realizedCalls != null && (
                          <div style={{ color: realizedCalls >= 0 ? green : red, fontSize: '11px', paddingLeft: '10px' }}>
                            Calls: {realizedCalls >= 0 ? '+' : ''}{fmt(realizedCalls)}
                          </div>
                        )}
                        {realizedPuts != null && (
                          <div style={{ color: realizedPuts >= 0 ? green : red, fontSize: '11px', paddingLeft: '10px' }}>
                            Puts: {realizedPuts >= 0 ? '+' : ''}{fmt(realizedPuts)}
                          </div>
                        )}
                        {stockPnl !== undefined && (
                          <div title={stockTooltip} style={{ color: stockPnl >= 0 ? green : red, cursor: stockTooltip ? 'help' : 'default' }}>
                            Stock: {stockPnl >= 0 ? '+' : ''}{fmt(stockPnl)}{stockEntry?.fromPrice && stockEntry?.toPrice ? <span style={{ color: textMid, fontWeight: '400' }}> (${stockEntry.fromPrice.toFixed(2)} → ${stockEntry.toPrice.toFixed(2)})</span> : stockEntry?.fromPrice ? <span style={{ color: textMid, fontWeight: '400' }}> (${stockEntry.fromPrice.toFixed(2)})</span> : null}
                          </div>
                        )}
                        {weekOffset === 0 && preMarketPrices[ticker] && (
                          <div style={{ color: textMid, fontSize: '10px' }}>
                            Pre: ${preMarketPrices[ticker].price.toFixed(2)}
                            {preMarketPrices[ticker].changePct != null && (
                              <span style={{ marginLeft: '4px', color: preMarketPrices[ticker].changePct >= 0 ? green : red }}>
                                {preMarketPrices[ticker].changePct >= 0 ? '+' : ''}{preMarketPrices[ticker].changePct.toFixed(2)}%
                              </span>
                            )}
                          </div>
                        )}
                        {unrealizedPnl !== undefined && (
                          <div style={{ color: unrealizedPnl >= 0 ? green : red }}>
                            Unrealized: {unrealizedPnl >= 0 ? '+' : ''}{fmt(unrealizedPnl)}
                          </div>
                        )}
                        {rp?.shortCall != null && <div style={{ color: '#f59e0b' }}>Rem Short Call: {fmt(rp.shortCall)}{rp.shortCallPositions?.length > 0 && ` (${rp.shortCallPositions.map(x => `$${x.strike} @ $${x.mark}`).join(' / ')})`}</div>}
                        {rp?.longPut != null && <div style={{ color: '#f59e0b' }}>Rem Long Put: {fmt(rp.longPut)}{rp.longPutPositions?.length > 0 && ` (${rp.longPutPositions.map(x => `$${x.strike} @ $${x.mark}`).join(' / ')})`}</div>}
                        {weekOffset === 0 && !isHistoricalView && <RSIBadge symbol={ticker} isDark={isDark} onClick={setChartTicker} />}
                        {combined !== null && (
                          <div style={{ color: combined >= 0 ? green : red, fontWeight: '700', borderTop: `1px solid ${border}`, paddingTop: '2px', marginTop: '2px' }}>
                            Net: {combined >= 0 ? '+' : ''}{fmt(combined)}
                          </div>
                        )}
                        {combined100 !== null && (
                          <div style={{ color: textMid, fontSize: '10px' }}>per 100sh: {combined100 >= 0 ? '+' : ''}{fmt(combined100)}</div>
                        )}
                        {combined !== null && rp != null && (rp.shortCall != null || rp.longPut != null) && (() => {
                          const remTotal = Math.round(((rp.shortCall ?? 0) * 100 - (rp.longPut ?? 0) * 100) * 100) / 100
                          const netRem = Math.round((combined + remTotal) * 100) / 100
                          return (
                            <div style={{ color: netRem >= 0 ? green : red, fontWeight: '700', fontSize: '11px' }}>
                              Net + Rem: {netRem >= 0 ? '+' : ''}{fmt(netRem)}
                            </div>
                          )
                        })()}
                        {combined !== null && rp?.shortCallPositions?.length > 0 && (() => {
                          const sc = Math.min(...rp.shortCallPositions.map(p => p.strike))
                          const sp1w = weekOffset === 0 ? stockPriceByTicker[ticker] : null
                          const sh = shares1w
                          if (!sp1w || !sh) return null
                          const val = Math.round((combined + (sc - sp1w) * sh) * 100) / 100
                          return <div style={{ color: val >= 0 ? green : red, fontSize: '11px' }}>Max: {val >= 0 ? '+' : ''}{fmt(val)}<span style={{ color: textMid }}> @${sc}</span></div>
                        })()}
                        {combined !== null && rp?.longPutPositions?.length > 0 && (() => {
                          const lp = Math.max(...rp.longPutPositions.map(p => p.strike))
                          const sp1w = weekOffset === 0 ? stockPriceByTicker[ticker] : null
                          const sh = shares1w
                          if (!sp1w || !sh) return null
                          const val = Math.round((combined + (lp - sp1w) * sh) * 100) / 100
                          return <div style={{ color: val >= 0 ? green : red, fontSize: '11px' }}>Floor: {val >= 0 ? '+' : ''}{fmt(val)}<span style={{ color: textMid }}> @${lp}</span></div>
                        })()}
                      </div>
                    </div>
                    {isExpanded && (
                      <div style={{
                        border: `1px solid ${border}`, borderTop: 'none',
                        borderRadius: '0 0 8px 8px',
                        background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.02)',
                        fontSize: '11px'
                      }}>
                        {trades.length > 3 && (
                          <div style={{ padding: '6px 10px', borderBottom: `1px solid ${border}` }}>
                            <input
                              value={tradeSearch}
                              onChange={e => setTradeSearch(e.target.value)}
                              onClick={e => e.stopPropagation()}
                              placeholder="Search trades (e.g. 285, Put, Call)…"
                              style={{
                                width: '100%', boxSizing: 'border-box',
                                background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                                border: `1px solid ${border}`, borderRadius: '4px',
                                color: text, fontSize: '11px', padding: '3px 7px', outline: 'none'
                              }}
                            />
                          </div>
                        )}
                        {(tradeSearch ? trades.filter(t => t.description?.toLowerCase().includes(tradeSearch.toLowerCase()) || t.transCode?.toLowerCase().includes(tradeSearch.toLowerCase())) : trades).map((t, i, arr) => (
                          <div key={i} style={{
                            padding: '5px 10px',
                            borderBottom: i < arr.length - 1 ? `1px solid ${border}` : 'none',
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
              {/* Other Stocks chip — accounts for the gap between card sum and Total Net */}
              {weekOffset === 0 && otherStockPnL !== 0 && (
                <div style={{ minWidth: '140px', flex: '1 1 140px', maxWidth: '260px' }}>
                  <div style={{
                    padding: '8px 12px', borderRadius: '8px',
                    background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                    border: `1px solid ${border}`, fontSize: '12px'
                  }}>
                    <div style={{ fontWeight: '700', color: text, marginBottom: '4px' }}>Other Stocks</div>
                    <div style={{ color: otherStockPnL >= 0 ? green : red }}>
                      Stock: {otherStockPnL >= 0 ? '+' : ''}{fmt(otherStockPnL)}
                    </div>
                    <div style={{ color: otherStockPnL >= 0 ? green : red, fontWeight: '700', borderTop: `1px solid ${border}`, paddingTop: '2px', marginTop: '2px' }}>
                      Net: {otherStockPnL >= 0 ? '+' : ''}{fmt(otherStockPnL)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          )
        })()}
        {byUnderlyingWeeks === -1 && Object.keys(nextWeekUnrealizedByTicker).length > 0 && (
          <div style={{ paddingTop: '12px', borderTop: `1px solid ${border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.03em', color: textMid }}>
                Next Week Open Positions
              </div>
              {(() => {
                const total = Object.values(nextWeekUnrealizedByTicker).reduce((s, v) => s + v, 0)
                return <div style={{ fontSize: '12px', fontWeight: '700', color: total >= 0 ? green : red }}>
                  Unrealized: {total >= 0 ? '+' : ''}{fmt(total)}
                </div>
              })()}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {Object.entries(nextWeekUnrealizedByTicker).sort((a, b) => a[0].localeCompare(b[0])).map(([ticker, unrealizedPnl]) => {
                const sp = stockPriceByTicker[ticker]
                return (
                  <div key={ticker} style={{ minWidth: '140px', flex: '1 1 140px', maxWidth: '260px' }}>
                    <div style={{
                      padding: '8px 12px', borderRadius: '8px',
                      background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                      border: `1px solid ${border}`, fontSize: '12px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '700', color: text }}>{ticker}</span>
                        {sp && <span style={{ fontSize: '11px', color: textMid }}>{fmt(sp)}</span>}
                      </div>
                      <div style={{ color: unrealizedPnl >= 0 ? green : red }}>
                        Unrealized: {unrealizedPnl >= 0 ? '+' : ''}{fmt(unrealizedPnl)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      </>}
      {activeTab === 'history' && <>
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
                  // Current week: use live realized+unrealized (same as WK hero card) instead of cash flow
                  const isCurrWeek = week.weekStart === data?.weekStart
                  const optionsPnL = isCurrWeek && hasPrices && !isHistoricalView
                    ? (data?.currentWeekRealizedTotal || 0) + totalUnrealizedPnl
                    : week.totalDelta
                  const stockDeltaTotal = week.stockDelta ? Object.values(week.stockDelta).reduce((s, v) => s + v, 0) : null
                  const stockTooltip = week.stockDelta ? Object.entries(week.stockDelta).map(([t, v]) => `${t}: ${v >= 0 ? '+' : ''}${fmt(v)}`).join(', ') : null
                  const otherDeltaTotal = week.otherStockDelta ? Object.values(week.otherStockDelta).reduce((s, v) => s + v, 0) : null
                  const otherTooltip = week.otherStockDelta ? Object.entries(week.otherStockDelta).map(([t, v]) => `${t}: ${v >= 0 ? '+' : ''}${fmt(v)}`).join(', ') : null
                  const net = optionsPnL + (stockDeltaTotal ?? 0) + (otherDeltaTotal ?? 0)
                  return (
                    <tr key={week.weekStart} style={{ borderBottom: `1px solid ${border}`, background: i % 2 === 0 ? 'transparent' : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)') }}>
                      <td style={{ padding: '10px 12px', color: text }}>
                        <span style={{ fontWeight: '600' }}>{fmtDate(monday)}</span>
                        <span style={{ color: textMid, marginLeft: '6px', fontSize: '12px' }}>&#8211; {fmtDate(friday)}</span>
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: '600', color: optionsPnL >= 0 ? green : red }}>
                        {optionsPnL >= 0 ? '+' : ''}{fmt(optionsPnL)}
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
                  {(() => {
                    const adjOptionsTotal = filteredWeeks.reduce((s, w) => {
                      const isCW = w.weekStart === data?.weekStart
                      return s + (isCW && hasPrices && !isHistoricalView
                        ? (data?.currentWeekRealizedTotal || 0) + totalUnrealizedPnl
                        : w.totalDelta)
                    }, 0)
                    const stockTotal = filteredWeeks.reduce((s, w) => w.stockDelta ? s + Object.values(w.stockDelta).reduce((a, b) => a + b, 0) : s, 0)
                    const otherTotal = filteredWeeks.reduce((s, w) => w.otherStockDelta ? s + Object.values(w.otherStockDelta).reduce((a, b) => a + b, 0) : s, 0)
                    const hasStock = filteredWeeks.some(w => w.stockDelta)
                    const hasOther = filteredWeeks.some(w => w.otherStockDelta)
                    const netTotal = adjOptionsTotal + stockTotal + otherTotal
                    return <>
                      <td style={{ padding: '10px 16px', fontWeight: '700', color: adjOptionsTotal >= 0 ? green : red }}>{adjOptionsTotal >= 0 ? '+' : ''}{fmt(adjOptionsTotal)}</td>
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

      </>}
      {activeTab === 'week' && <>
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
        {openPositions.length === 0 ? (
          <div style={{ fontSize: '13px', color: textMid }}>No open positions detected — upload your latest CSV to see open contracts.</div>
        ) : (() => {
          // Group by underlying ticker
          const grouped = {}
          openPositions.forEach(pos => {
            const t = pos.ticker || 'Unknown'
            if (!grouped[t]) grouped[t] = []
            grouped[t].push(pos)
          })
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([ticker, positions]) => {
                const isExpanded = !!expandedOpenPos[ticker]
                const tickerUnrealized = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)
                const hasPnl = positions.some(p => p.unrealizedPnl != null)
                const contractCount = positions.reduce((s, p) => s + (p.openContracts || 0), 0)
                const stockPrice = stockPriceByTicker[ticker] || positions[0]?.stockPrice
                return (
                  <div key={ticker}>
                    {/* Underlying header row */}
                    <div
                      onClick={() => setExpandedOpenPos(prev => ({ ...prev, [ticker]: !prev[ticker] }))}
                      style={{
                        padding: '8px 12px',
                        borderRadius: isExpanded ? '8px 8px 0 0' : '8px',
                        fontSize: '12px', cursor: 'pointer',
                        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                        border: `1px solid ${border}`,
                        borderBottom: isExpanded ? 'none' : undefined,
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: '700', fontSize: '13px', color: text }}>{ticker}</span>
                        {stockPrice ? <span style={{ fontSize: '11px', color: textMid }}>{fmt(stockPrice)}</span> : null}
                        <span style={{ fontSize: '11px', color: textMid }}>{contractCount} contract{contractCount !== 1 ? 's' : ''}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {hasPnl && (
                          <span style={{ fontWeight: '700', fontSize: '13px', color: tickerUnrealized >= 0 ? green : red }}>
                            {tickerUnrealized >= 0 ? '+' : ''}{fmt(tickerUnrealized)}
                          </span>
                        )}
                        <span style={{ color: textMid, fontSize: '10px' }}>{isExpanded ? '▲' : '▼'}</span>
                      </div>
                    </div>
                    {/* Expanded contracts */}
                    {isExpanded && (
                      <div style={{ border: `1px solid ${border}`, borderTop: 'none', borderRadius: '0 0 8px 8px', background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.02)' }}>
                        {positions.map((pos, i) => {
                          const hasPrice = pos.markPrice > 0
                          const pnlColor = pos.unrealizedPnl == null ? textMid : (pos.unrealizedPnl >= 0 ? green : red)
                          return (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: i < positions.length - 1 ? `1px solid ${border}` : 'none' }}>
                              <div>
                                <div style={{ fontWeight: '600', fontSize: '13px', color: text }}>
                                  ${pos.strike} {pos.optionType?.toUpperCase()}&nbsp;
                                  <span style={{ fontSize: '11px', fontWeight: '500', color: pos.isLong ? green : '#f59e0b' }}>{pos.isLong ? 'LONG' : 'SHORT'}</span>
                                </div>
                                <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>
                                  Exp {pos.expiry} · {pos.openContracts} contract{pos.openContracts !== 1 ? 's' : ''} · avg {fmt(pos.avgCostPerContract)}/contract
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontWeight: '700', fontSize: '13px', color: pnlColor }}>
                                  {pos.unrealizedPnl == null ? '—' : fmt(pos.unrealizedPnl)}
                                </div>
                                <div style={{ fontSize: '11px', color: textMid }}>
                                  mark {hasPrice ? fmt(pos.markPrice) : (posLoading ? '…' : 'N/A')}
                                </div>
                                {pos.remainingPremium != null && (
                                  <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '2px' }}>
                                    {pos.remainingPremiumLabel || 'Rem. Premium'}: {fmt(pos.remainingPremium)}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
        {livePositions?.expiredFiltered > 0 && (
          <div style={{ fontSize: '11px', color: textMid, marginTop: '8px' }}>
            {livePositions.expiredFiltered} expired contract{livePositions.expiredFiltered !== 1 ? 's' : ''} hidden — re-upload CSV to reconcile
          </div>
        )}
      </div>

      {/* What-If Analysis */}
      <div style={{ ...cardStyle, marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showWhatIf ? '12px' : '0' }}>
          <div>
            <div style={{ fontWeight: '700', fontSize: '14px', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em' }}>What If You'd Held?</div>
            {!showWhatIf && <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>Compare holding original positions vs actual trades for a selected week</div>}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {showWhatIf && (
              <>
                <select value={whatIfWeek || ''} onChange={e => {
                  const w = e.target.value || null
                  setWhatIfWeek(w)
                  setWhatIfData(null)
                  fetchWhatIf(w)
                }} style={{ fontSize: '11px', padding: '3px 6px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text }}>
                  <option value=''>Current Week</option>
                  {[...(data?.weeks || [])].sort((a, b) => b.weekStart.localeCompare(a.weekStart)).map(w => (
                    <option key={w.weekStart} value={w.weekStart}>
                      {new Date(w.weekStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </option>
                  ))}
                </select>
                <button onClick={() => fetchWhatIf()} disabled={whatIfLoading}
                  style={{ ...btnStyle(false), padding: '4px 12px', fontSize: '11px', opacity: whatIfLoading ? 0.6 : 1 }}>
                  {whatIfLoading ? '…' : '↻ Recalculate'}
                </button>
              </>
            )}
            <button onClick={() => { setShowWhatIf(v => !v); if (!whatIfData && !showWhatIf) fetchWhatIf() }}
              style={{ ...btnStyle(showWhatIf), padding: '4px 12px', fontSize: '11px' }}>
              {showWhatIf ? 'Hide' : 'Calculate ▶'}
            </button>
          </div>
        </div>
        {showWhatIf && whatIfError && <div style={{ fontSize: '12px', color: red }}>{whatIfError}</div>}
        {showWhatIf && whatIfLoading && <div style={{ fontSize: '12px', color: textMid }}>{whatIfWeek ? 'Looking up historical outcomes…' : 'Fetching current marks from Polygon…'}</div>}
        {showWhatIf && whatIfData && (() => {
          if (whatIfData.length === 0) return <div style={{ fontSize: '13px', color: textMid }}>No option trades found for this week.</div>
          const totalHold = Math.round(whatIfData.reduce((s, r) => s + r.holdPnl, 0) * 100) / 100
          const totalActual = Math.round(whatIfData.reduce((s, r) => s + r.actualCashFlow, 0) * 100) / 100
          const diff = Math.round((totalHold - totalActual) * 100) / 100
          // Group by ticker
          const byTicker = {}
          whatIfData.forEach(r => {
            if (!byTicker[r.ticker]) byTicker[r.ticker] = []
            byTicker[r.ticker].push(r)
          })
          return (
            <div>
              {/* Summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', border: `1px solid ${border}` }}>
                <div>
                  <div style={{ fontSize: '11px', color: textMid, marginBottom: '2px' }}>If Held</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '800', color: totalHold >= 0 ? green : red }}>{totalHold >= 0 ? '+' : ''}{fmt(totalHold)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: textMid, marginBottom: '2px' }}>Actual (cash flow)</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '800', color: totalActual >= 0 ? green : red }}>{totalActual >= 0 ? '+' : ''}{fmt(totalActual)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: textMid, marginBottom: '2px' }}>Difference</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '800', color: diff >= 0 ? green : red }}>{diff >= 0 ? '+' : ''}{fmt(diff)}</div>
                  <div style={{ fontSize: '10px', color: textMid }}>{diff >= 0 ? 'better to hold' : 'better to trade'}</div>
                </div>
              </div>
              {/* Per-ticker breakdown */}
              {Object.entries(byTicker).sort(([a], [b]) => a.localeCompare(b)).map(([ticker, rows]) => (
                <div key={ticker} style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '700', color: textMid, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px' }}>{ticker}</div>
                  {rows.map((r, i) => {
                    const diff = Math.round((r.holdPnl - r.actualCashFlow) * 100) / 100
                    const expLabel = new Date(r.expiry + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    return (
                      <div key={i} style={{
                        display: 'grid', gridTemplateColumns: '1fr 80px 80px 80px',
                        gap: '6px', alignItems: 'center',
                        padding: '7px 10px', borderRadius: '6px', marginBottom: '4px', fontSize: '12px',
                        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                        border: `1px solid ${border}`
                      }}>
                        <div>
                          <div style={{ fontWeight: '600', color: text }}>
                            ${r.strike} {r.optionType?.toUpperCase()} · exp {expLabel}
                            <span style={{ marginLeft: '6px', fontSize: '10px', color: r.isShort ? '#f59e0b' : green }}>{r.isShort ? 'SHORT' : 'LONG'}</span>
                          </div>
                          <div style={{ fontSize: '10px', color: textMid, marginTop: '2px' }}>
                            {r.openContracts}c opened @ {fmt(r.avgOpenPrice)}/c
                            {r.earlyClosedContracts > 0 && ` · ${r.earlyClosedContracts}c closed early`}
                            {r.outcomeCode ? ` · ${r.outcomeCode}` : r.expired ? ' · expired' : r.currentMark > 0 ? ` · mark ${fmt(r.currentMark)}` : ''}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '10px', color: textMid }}>If held</div>
                          <div style={{ fontWeight: '700', color: r.holdPnl >= 0 ? green : red }}>{r.holdPnl >= 0 ? '+' : ''}{fmt(r.holdPnl)}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '10px', color: textMid }}>Actual</div>
                          <div style={{ fontWeight: '700', color: r.actualCashFlow >= 0 ? green : red }}>{r.actualCashFlow >= 0 ? '+' : ''}{fmt(r.actualCashFlow)}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '10px', color: textMid }}>Δ</div>
                          <div style={{ fontWeight: '700', color: diff >= 0 ? green : red }}>{diff >= 0 ? '+' : ''}{fmt(diff)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )
        })()}
      </div>

      {/* Scenario Calculator */}
      {openPositions.length > 0 && (
        <div style={{ ...cardStyle, marginTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showScenario ? '12px' : '0' }}>
            <div>
              <div style={{ fontWeight: '700', fontSize: '14px', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scenario Calculator</div>
              {!showScenario && <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>Enter a final stock price to estimate total P&L at expiration</div>}
            </div>
            <button onClick={() => {
              setShowScenario(v => !v)
              if (!showScenario) {
                // Pre-fill with current stock prices per ticker
                const fills = {}
                openPositions.forEach(p => { if (!(p.ticker in fills)) fills[p.ticker] = stockPriceByTicker[p.ticker] || '' })
                setScenarioMarks(fills)
              }
            }} style={{ ...btnStyle(showScenario), padding: '4px 12px', fontSize: '11px' }}>
              {showScenario ? 'Hide' : 'Open Calculator ▶'}
            </button>
          </div>
          {showScenario && (() => {
            const tickers = [...new Set(openPositions.map(p => p.ticker))].sort()

            // Compute intrinsic value P&L per open position
            const rows = openPositions.map(p => {
              const stockPrice = Number(scenarioMarks[p.ticker] ?? stockPriceByTicker[p.ticker] ?? 0)
              const intrinsic = p.optionType === 'call'
                ? Math.max(0, stockPrice - p.strike)
                : Math.max(0, p.strike - stockPrice)
              const currentValue = intrinsic * 100 * p.openContracts
              const pnl = p.isLong
                ? currentValue - (p.avgCostPerContract * p.openContracts)
                : (p.avgCostPerContract * p.openContracts) - currentValue
              return { ...p, scenarioIntrinsic: intrinsic, scenarioPnl: Math.round(pnl * 100) / 100 }
            })

            const openPosPnl = Math.round(rows.reduce((s, r) => s + r.scenarioPnl, 0) * 100) / 100
            const alreadyRealized = data?.currentWeekRealizedTotal || 0
            const totalPnl = Math.round((openPosPnl + alreadyRealized) * 100) / 100

            return (
              <div>
                {/* Stock price inputs — one per ticker */}
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
                  {tickers.map(ticker => (
                    <div key={ticker} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '12px', fontWeight: '700', color: text }}>{ticker}</span>
                      <span style={{ fontSize: '11px', color: textMid }}>final price $</span>
                      <input
                        type='number'
                        min='0'
                        step='0.01'
                        value={scenarioMarks[ticker] !== undefined ? scenarioMarks[ticker] : ''}
                        onChange={e => setScenarioMarks(prev => ({ ...prev, [ticker]: e.target.value }))}
                        style={{
                          width: '80px', padding: '4px 8px', fontSize: '13px', borderRadius: '4px',
                          border: `1px solid ${border}`, background: surface, color: text, textAlign: 'right',
                          fontWeight: '700'
                        }}
                      />
                    </div>
                  ))}
                </div>

                {/* Summary totals */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', border: `1px solid ${border}` }}>
                    <div style={{ fontSize: '10px', color: textMid, fontWeight: '600', marginBottom: '3px' }}>Already Realized</div>
                    <div style={{ fontSize: '1rem', fontWeight: '700', color: alreadyRealized >= 0 ? green : red }}>{alreadyRealized >= 0 ? '+' : ''}{fmt(alreadyRealized)}</div>
                  </div>
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', border: `1px solid ${border}` }}>
                    <div style={{ fontSize: '10px', color: textMid, fontWeight: '600', marginBottom: '3px' }}>Open Positions @ Price</div>
                    <div style={{ fontSize: '1rem', fontWeight: '700', color: openPosPnl >= 0 ? green : red }}>{openPosPnl >= 0 ? '+' : ''}{fmt(openPosPnl)}</div>
                  </div>
                  <div style={{ padding: '8px 12px', borderRadius: '8px', background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', border: `2px solid ${totalPnl >= 0 ? green : red}` }}>
                    <div style={{ fontSize: '10px', color: textMid, fontWeight: '600', marginBottom: '3px' }}>Total P&L</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: '800', color: totalPnl >= 0 ? green : red }}>{totalPnl >= 0 ? '+' : ''}{fmt(totalPnl)}</div>
                  </div>
                </div>

                {/* Per-position breakdown */}
                {rows.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.ticker.localeCompare(b.ticker)).map((r, i) => {
                  const expLabel = new Date(r.expiry + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  return (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: '1fr 80px 90px',
                      gap: '8px', alignItems: 'center',
                      padding: '7px 10px', borderRadius: '6px', marginBottom: '4px', fontSize: '12px',
                      background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                      border: `1px solid ${border}`
                    }}>
                      <div>
                        <div style={{ fontWeight: '600', color: text }}>
                          {r.ticker} ${r.strike} {r.optionType?.toUpperCase()} · exp {expLabel}
                          <span style={{ marginLeft: '6px', fontSize: '10px', color: r.isLong ? green : '#f59e0b' }}>{r.isLong ? 'LONG' : 'SHORT'}</span>
                        </div>
                        <div style={{ fontSize: '10px', color: textMid, marginTop: '2px' }}>
                          {r.openContracts}c · cost basis {fmt(r.avgCostPerContract)}/c
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '10px', color: textMid }}>Intrinsic</div>
                        <div style={{ fontWeight: '600', color: text }}>{fmt(r.scenarioIntrinsic)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '10px', color: textMid }}>P&L</div>
                        <div style={{ fontWeight: '700', color: r.scenarioPnl >= 0 ? green : red }}>{r.scenarioPnl >= 0 ? '+' : ''}{fmt(r.scenarioPnl)}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}
      </>}
    </div>
  )
}
