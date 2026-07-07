import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const DEFAULT_GLOBAL_START = '2026-03-15'
const LS_GLOBAL_KEY = 'ytdPanel_globalStart'
const LS_SYMBOL_KEY = 'ytdPanel_symbolDates'
const LS_COST_KEY = 'ytdPanel_costOverrides'
const LS_HIDDEN_KEY = 'ytdPanel_hiddenTickers'

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
  const [costOverrides, setCostOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_COST_KEY) || '{}') } catch { return {} }
  })
  const [editingCost, setEditingCost] = useState(null)
  const [costDraft, setCostDraft] = useState('')
  const [sortField, setSortField] = useState('ticker')
  const [sortDir, setSortDir] = useState('asc')
  const [livePrices, setLivePrices] = useState({})
  const [stockHoldings, setStockHoldings] = useState({})
  const [stockDebug, setStockDebug] = useState(null)
  const [search, setSearch] = useState('')
  const [hiddenTickers, setHiddenTickers] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_HIDDEN_KEY) || '[]') } catch { return [] }
  })
  const [showHiddenList, setShowHiddenList] = useState(false)

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

  // Fetch stock holdings + cost overrides from server on mount
  const fetchStockHoldings = () => {
    fetch('/api/stock-positions-with-prices', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        setStockDebug(json)
        if (json.success && json.holdings.length > 0) {
          const map = {}
          json.holdings.forEach(h => { map[h.symbol] = h })
          setStockHoldings(map)
          const prices = {}
          json.holdings.forEach(h => { if (h.currentPrice > 0) prices[h.symbol] = h.currentPrice })
          setLivePrices(prices)
        }
      })
      .catch(e => setStockDebug({ error: e.message }))
  }

  const fetchCostOverrides = () => {
    const localData = (() => { try { return JSON.parse(localStorage.getItem(LS_COST_KEY) || '{}') } catch { return {} } })()
    fetch('/api/stock-cost-overrides', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        if (!json.success) return
        const serverData = json.overrides || {}
        if (Object.keys(serverData).length > 0) {
          // Server has data — use it as source of truth
          setCostOverrides(serverData)
          localStorage.setItem(LS_COST_KEY, JSON.stringify(serverData))
        } else if (Object.keys(localData).length > 0) {
          // Server empty (e.g. after redeploy) but localStorage has data — restore to server
          setCostOverrides(localData)
          Object.entries(localData).forEach(([symbol, avgCost]) => {
            fetch(`/api/stock-cost-overrides/${symbol}`, {
              method: 'PUT', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ avgCost })
            }).catch(() => {})
          })
        }
      })
      .catch(() => {})
  }

  useEffect(() => { fetchStockHoldings(); fetchCostOverrides() }, [])

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

  const saveCostOverride = async (ticker, value) => {
    const num = parseFloat(value)
    if (!num || num <= 0) return
    const rounded = Math.round(num * 100) / 100
    const updated = { ...costOverrides, [ticker]: rounded }
    setCostOverrides(updated)
    localStorage.setItem(LS_COST_KEY, JSON.stringify(updated))
    setEditingCost(null)
    try {
      await fetch(`/api/stock-cost-overrides/${ticker}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avgCost: rounded })
      })
    } catch (e) {
      console.error('Failed to persist cost override:', e)
    }
  }

  const clearCostOverride = async (ticker) => {
    const updated = { ...costOverrides }
    delete updated[ticker]
    setCostOverrides(updated)
    localStorage.setItem(LS_COST_KEY, JSON.stringify(updated))
    setEditingCost(null)
    try {
      await fetch(`/api/stock-cost-overrides/${ticker}`, { method: 'DELETE', credentials: 'include' })
    } catch (e) {
      console.error('Failed to delete cost override:', e)
    }
  }

  const hideTicker = (t) => {
    const updated = [...new Set([...hiddenTickers, t])]
    setHiddenTickers(updated)
    localStorage.setItem(LS_HIDDEN_KEY, JSON.stringify(updated))
  }

  const restoreTicker = (t) => {
    const updated = hiddenTickers.filter(x => x !== t)
    setHiddenTickers(updated)
    localStorage.setItem(LS_HIDDEN_KEY, JSON.stringify(updated))
    if (updated.length === 0) setShowHiddenList(false)
  }

  const restoreAllTickers = () => {
    setHiddenTickers([])
    localStorage.setItem(LS_HIDDEN_KEY, '[]')
    setShowHiddenList(false)
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

  const q = search.trim().toUpperCase()
  const hiddenSet = new Set(hiddenTickers)
  const rows = (data?.byUnderlying || []).filter(r =>
    !hiddenSet.has(r.ticker) && (!q || (r.ticker || '').toUpperCase().includes(q)))
  const sorted = [...rows].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1
    const av = a[sortField], bv = b[sortField]
    if (typeof av === 'string' || typeof bv === 'string') {
      return mul * String(av ?? '').localeCompare(String(bv ?? ''))
    }
    return mul * ((av ?? 0) - (bv ?? 0))
  })

  const totals = rows.reduce((acc, r) => {
    const sh = stockHoldings[r.ticker]
    const fb = pnlLookup[r.ticker]
    const pos = (sh?.position > 0 ? sh.position : null) ?? (fb?.position > 0 ? fb.position : null) ?? (r.stockPosition > 0 ? r.stockPosition : null)
    const computedCost = (sh?.avgCost > 0 ? sh.avgCost : null) ?? (fb?.avgCost > 0 ? fb.avgCost : null) ?? (r.stockAvgCost > 0 ? r.stockAvgCost : null)
    const avgCost = costOverrides[r.ticker] || computedCost
    const price = (sh?.currentPrice > 0 ? sh.currentPrice : null) ?? (livePrices[r.ticker] > 0 ? livePrices[r.ticker] : null) ?? (r.stockCurrentPrice > 0 ? r.stockCurrentPrice : null)
    const stockUnrealized = (pos > 0 && avgCost > 0 && price > 0)
      ? Math.round(pos * (price - avgCost) * 100) / 100
      : 0
    const stockPnL = stockUnrealized + (r.stockRealizedPnL || 0)
    return {
      realizedShortCalls: acc.realizedShortCalls + (r.realizedShortCalls || 0),
      realizedLongCalls: acc.realizedLongCalls + (r.realizedLongCalls || 0),
      realizedShortPuts: acc.realizedShortPuts + (r.realizedShortPuts || 0),
      realizedLongPuts: acc.realizedLongPuts + (r.realizedLongPuts || 0),
      totalRealized: acc.totalRealized + (r.totalRealized || 0),
      openPremium: acc.openPremium + (r.openPremium || 0),
      openUnrealizedPnL: acc.openUnrealizedPnL + (r.openUnrealizedPnL || 0),
      stockUnrealizedPnL: acc.stockUnrealizedPnL + stockPnL,
      net: acc.net + (r.totalRealized || 0) + stockPnL,
      dayPnl: acc.dayPnl + (r.dayPnl || 0)
    }
  }, { realizedShortCalls: 0, realizedLongCalls: 0, realizedShortPuts: 0, realizedLongPuts: 0, totalRealized: 0, openPremium: 0, openUnrealizedPnL: 0, stockUnrealizedPnL: 0, net: 0, dayPnl: 0 })

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
            onClick={() => { fetchData(); fetchStockHoldings() }}
            style={{
              padding: '5px 12px', borderRadius: '6px', border: 'none',
              background: '#3b82f6', color: 'white', fontSize: '12px',
              fontWeight: '600', cursor: 'pointer'
            }}
          >
            Refresh
          </button>
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search ticker…"
            style={{
              padding: '5px 26px 5px 10px', borderRadius: '6px', border: `1px solid ${border}`,
              background: surface, color: text, fontSize: '13px', width: '160px'
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} title="Clear"
              style={{ position: 'absolute', right: '6px', border: 'none', background: 'transparent',
                color: textMid, cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: 0 }}>×</button>
          )}
        </div>
        {hiddenTickers.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowHiddenList(v => !v)}
              style={{ padding: '5px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: textMid, fontSize: '12px', cursor: 'pointer' }}>
              🚫 {hiddenTickers.length} hidden ▾
            </button>
            {showHiddenList && (
              <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: '4px', zIndex: 20, background: surface, border: `1px solid ${border}`, borderRadius: '8px', padding: '8px', minWidth: '180px', maxWidth: '260px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
                  {hiddenTickers.map(t => (
                    <button key={t} onClick={() => restoreTicker(t)} title={`Restore ${t}`}
                      style={{ padding: '2px 7px', borderRadius: '4px', border: `1px solid ${border}`, background: isDark ? '#252d3d' : '#f1f5f9', color: text, fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>
                      {t} ✕
                    </button>
                  ))}
                </div>
                <button onClick={restoreAllTickers}
                  style={{ width: '100%', padding: '5px', borderRadius: '4px', border: 'none', background: '#3b82f6', color: 'white', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>
                  Show all
                </button>
              </div>
            )}
          </div>
        )}
        <span style={{ fontSize: '12px', color: textMid }}>
          Click a date cell to set a per-symbol start date · hover a row to hide it
        </span>
        {stockDebug && (
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
            background: stockDebug.holdings?.length > 0 ? '#22c55e22' : '#f59e0b22',
            color: stockDebug.holdings?.length > 0 ? '#22c55e' : '#f59e0b' }}>
            Stock: {stockDebug.holdings?.length > 0
              ? `${stockDebug.holdings.length} holdings loaded`
              : `0 holdings — ${JSON.stringify(stockDebug.debug || stockDebug.error || 'no data').slice(0,120)}`}
          </span>
        )}
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
        <div style={{ overflowX: 'auto', position: 'relative', borderRadius: '10px', border: `1px solid ${border}` }}>
          <table className="ytd-panel-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '13px', background: surface }}>
            <colgroup>
              <col style={{ width: '44px' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...thStyle('ticker'), textAlign: 'left', padding: '10px 4px', position: 'sticky', left: 0, zIndex: 2, background: sortField === 'ticker' ? (isDark ? '#1a2035' : '#f0f4ff') : (isDark ? '#151929' : '#f8fafc'), boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}` }} onClick={() => toggleSort('ticker')}>Ticker<SortIcon field="ticker" /></th>
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
                    title="Credit collected on currently-open SHORT options (covered calls / cash-secured puts). Long options are not netted in.">
                  Open Premium<SortIcon field="openPremium" />
                </th>
                <th style={thStyle('openUnrealizedPnL')} onClick={() => toggleSort('openUnrealizedPnL')}
                    title="Unrealized P&L on open short options: premium collected minus current cost to buy them back (live option prices)">
                  Open P&L<SortIcon field="openUnrealizedPnL" />
                </th>
                <th style={{ ...thStyle(null), cursor: 'default', borderLeft: `1px solid ${border}` }} title="Shares held">Shares</th>
                <th style={{ ...thStyle(null), cursor: 'default' }} title="Average cost per share">Avg Cost</th>
                <th style={{ ...thStyle(null), cursor: 'default' }} title="Current stock price">Stock Price</th>
                <th style={{ ...thStyle('stockPnL') }} onClick={() => toggleSort('stockPnL')}
                    title="Stock P&L = realized (buy/sell gains) + unrealized (open shares)">
                  Stock P&L<SortIcon field="stockPnL" />
                </th>
                <th style={{ ...thStyle('net'), borderLeft: `2px solid ${border}` }} onClick={() => toggleSort('net')}
                    title="Options Total (realized) + Stock P&L. Open Premium is excluded — it isn't marked to market.">
                  Net<SortIcon field="net" />
                </th>
                <th style={{ ...thStyle(null), cursor: 'default', borderLeft: `1px solid ${border}` }}
                    title="Net + Open P&L — marks open short options to market on top of Net.">
                  Net + Open P&L
                </th>
                <th style={{ ...thStyle('dayPnl'), borderLeft: `1px solid ${border}` }} onClick={() => toggleSort('dayPnl')}
                    title="Today's mark-to-market move: shares × stock's move since yesterday's close, plus open short options × 100 × their move since yesterday's close.">
                  Day P&L<SortIcon field="dayPnl" />
                </th>
                <th style={{ ...thStyle(null), cursor: 'default', borderLeft: `1px solid ${border}` }}
                    title="How much better (or worse) options+stock did than just holding the shares, as a % of the stock result's size: (Net+Open − Stock) ÷ |Stock|. Positive = options added value (bigger = more); negative = options detracted. Consistent across gains and losses.">
                  vs Stock %
                </th>
                <th style={{ ...thStyle(null), textAlign: 'center', cursor: 'default', borderLeft: `1px solid ${border}` }}>Start Date</th>
                <th style={{ ...thStyle('weeklyChangePct'), borderLeft: `1px solid ${border}` }} onClick={() => toggleSort('weeklyChangePct')}
                    title="Stock price change over the past ~week (5 trading days)">
                  Wk %<SortIcon field="weeklyChangePct" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const isEditing = editingSymbol === row.ticker
                const effectiveDate = symbolDates[row.ticker] || globalStart
                const hasOverride = !!symbolDates[row.ticker]
                const tickerBg = i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff')
                return (
                  <tr
                    key={row.ticker}
                    style={{ borderBottom: `1px solid ${border}`, background: i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff') }}
                    onMouseEnter={e => e.currentTarget.style.background = rowHover}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff')}
                  >
                    <td style={{ padding: '10px 4px', fontWeight: '700', color: text, letterSpacing: '0.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', left: 0, zIndex: 1, background: tickerBg, boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}` }}>
                      {row.ticker}
                      <button
                        className="ytd-hide"
                        onClick={(e) => { e.stopPropagation(); hideTicker(row.ticker) }}
                        title={`Hide ${row.ticker} from view`}
                        style={{ position: 'absolute', top: '50%', right: '1px', transform: 'translateY(-50%)', width: '15px', height: '15px', padding: 0, lineHeight: '13px', textAlign: 'center', border: 'none', borderRadius: '50%', cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: '#fff', background: '#ef4444' }}
                      >×</button>
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
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: pnlColor(row.openUnrealizedPnL, isDark) }}
                        title={row.openUnrealizedPnL != null ? 'Premium collected/paid − current cost to close open options' : 'No live option price available'}>
                      {row.openUnrealizedPnL != null ? fmt(row.openUnrealizedPnL) : '—'}
                    </td>
                    {/* Stock columns + Net */}
                    {(() => {
                      const sh = stockHoldings[row.ticker]
                      const fb = pnlLookup[row.ticker]
                      const pos = (sh?.position > 0 ? sh.position : null) ?? (fb?.position > 0 ? fb.position : null) ?? (row.stockPosition > 0 ? row.stockPosition : null)
                      const computedCost = (sh?.avgCost > 0 ? sh.avgCost : null) ?? (fb?.avgCost > 0 ? fb.avgCost : null) ?? (row.stockAvgCost > 0 ? row.stockAvgCost : null)
                      const hasManualCost = !!costOverrides[row.ticker]
                      const avgCost = costOverrides[row.ticker] || computedCost
                      const price = (sh?.currentPrice > 0 ? sh.currentPrice : null) ?? (livePrices[row.ticker] > 0 ? livePrices[row.ticker] : null) ?? (row.stockCurrentPrice > 0 ? row.stockCurrentPrice : null)
                      const stockUnrealized = (pos > 0 && avgCost > 0 && price > 0)
                        ? Math.round(pos * (price - avgCost) * 100) / 100
                        : 0
                      const stockRealized = row.stockRealizedPnL || 0
                      const hasStock = (pos > 0 && avgCost > 0 && price > 0) || row.stockRealizedPnL != null
                      const stockPnl = hasStock ? Math.round((stockUnrealized + stockRealized) * 100) / 100 : null
                      const net = Math.round(((row.totalRealized || 0) + (stockPnl || 0)) * 100) / 100
                      const netPlusOpen = Math.round((net + (row.openUnrealizedPnL || 0)) * 100) / 100
                      // Out-performance vs holding the shares: how much better/worse the
                      // options+stock result is than stock-only, as a % of the stock result's size.
                      // +% = options added value; −% = options detracted. Always intuitive across signs.
                      const vsStockPct = (stockPnl != null && stockPnl !== 0) ? Math.round(((netPlusOpen - stockPnl) / Math.abs(stockPnl)) * 1000) / 10 : null
                      const optionsHelped = stockPnl != null && netPlusOpen >= stockPnl
                      const isCostEditing = editingCost === row.ticker
                      return (<>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: textMid, borderLeft: `1px solid ${border}` }}>
                          {pos != null && pos > 0 ? pos.toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                          {isCostEditing ? (
                            <div style={{ display: 'flex', gap: '3px', justifyContent: 'flex-end', alignItems: 'center' }}>
                              <input
                                type="number" step="0.01" value={costDraft}
                                onChange={e => setCostDraft(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') saveCostOverride(row.ticker, costDraft); if (e.key === 'Escape') setEditingCost(null) }}
                                autoFocus
                                style={{ width: '72px', padding: '2px 5px', borderRadius: '4px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '12px', textAlign: 'right' }}
                              />
                              <button onClick={() => saveCostOverride(row.ticker, costDraft)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#22c55e', color: 'white', fontSize: '11px', cursor: 'pointer' }}>✓</button>
                              <button onClick={() => setEditingCost(null)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#94a3b8', color: 'white', fontSize: '11px', cursor: 'pointer' }}>✗</button>
                              {hasManualCost && <button onClick={() => clearCostOverride(row.ticker)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#ef4444', color: 'white', fontSize: '11px', cursor: 'pointer' }}>Reset</button>}
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditingCost(row.ticker); setCostDraft(avgCost?.toFixed(2) || '') }}
                              style={{ background: 'transparent', border: `1px solid ${hasManualCost ? '#f59e0b' : 'transparent'}`,
                                padding: '2px 6px', borderRadius: '4px', cursor: 'pointer',
                                color: hasManualCost ? '#f59e0b' : textMid, fontSize: '12px', fontWeight: hasManualCost ? '600' : '400' }}
                              title={hasManualCost ? `Manual override: $${avgCost} (click to edit, Reset to clear)` : `Computed: $${avgCost?.toFixed(2) || '—'} (click to override)`}
                            >
                              {avgCost ? fmt(avgCost) : '—'}{hasManualCost ? ' ✎' : ''}
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: text }}>
                          {price ? fmt(price) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: pnlColor(stockPnl, isDark) }}
                            title={`Realized (buy/sell): ${fmt(stockRealized)}  ·  Unrealized (open shares): ${fmt(stockUnrealized)}`}>
                          {stockPnl != null ? fmt(stockPnl) : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', fontSize: '14px', color: pnlColor(net, isDark), borderLeft: `2px solid ${border}` }}
                            title="Options Total (realized) + Stock P&L">
                          {fmt(net)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', fontSize: '14px', color: pnlColor(netPlusOpen, isDark), borderLeft: `1px solid ${border}` }}
                            title={`Net (${fmt(net)}) + Open P&L (${row.openUnrealizedPnL != null ? fmt(row.openUnrealizedPnL) : '—'})`}>
                          {fmt(netPlusOpen)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: pnlColor(row.dayPnl, isDark), borderLeft: `1px solid ${border}` }}
                            title={row.dayPnl != null
                              ? `Today's move (since yesterday's close): stock ${row.dayStockPnl != null ? fmt(row.dayStockPnl) : '—'}${row.dayStockChangePct != null ? ` (${row.dayStockChangePct >= 0 ? '+' : ''}${row.dayStockChangePct}%)` : ''} + options ${row.dayOptionPnl != null ? fmt(row.dayOptionPnl) : '—'}`
                              : 'No prior-day close available yet'}>
                          {row.dayPnl != null ? `${row.dayPnl >= 0 ? '+' : ''}${fmt(row.dayPnl)}` : '—'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: vsStockPct == null ? textMid : pnlColor(optionsHelped ? 1 : -1, isDark), borderLeft: `1px solid ${border}` }}
                            title={vsStockPct == null ? 'No stock P&L to compare against' : `Options+stock did ${vsStockPct >= 0 ? 'better' : 'worse'} than holding the shares by ${fmt(Math.round((netPlusOpen - stockPnl) * 100) / 100)} (${vsStockPct >= 0 ? '+' : ''}${vsStockPct.toFixed(1)}% of the $${Math.abs(Math.round(stockPnl))} stock move). Net+Open ${fmt(netPlusOpen)} vs Stock ${fmt(stockPnl)}.`}>
                          {vsStockPct != null ? `${vsStockPct >= 0 ? '+' : ''}${vsStockPct.toFixed(1)}%` : '—'}
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
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: pnlColor(row.weeklyChangePct, isDark), borderLeft: `1px solid ${border}` }}
                        title={row.weeklyChange != null ? `${row.weeklyChange >= 0 ? '+' : ''}$${row.weeklyChange.toFixed(2)} over ~1 week` : ''}>
                      {row.weeklyChangePct != null ? `${row.weeklyChangePct >= 0 ? '+' : ''}${row.weeklyChangePct.toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${border}`, background: headerBg }}>
                <td style={{ padding: '10px 4px', fontWeight: '700', color: text, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', left: 0, zIndex: 1, background: isDark ? '#151929' : '#f8fafc', boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}` }}
                    title={`Total (${rows.length})`}>
                  Σ {rows.length}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedShortCalls, isDark), fontWeight: '700' }}>{fmt(totals.realizedShortCalls)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedLongCalls, isDark), fontWeight: '700' }}>{fmt(totals.realizedLongCalls)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedShortPuts, isDark), fontWeight: '700' }}>{fmt(totals.realizedShortPuts)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.realizedLongPuts, isDark), fontWeight: '700' }}>{fmt(totals.realizedLongPuts)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.totalRealized, isDark), fontWeight: '700', fontSize: '15px' }}>{fmt(totals.totalRealized)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.openPremium, isDark), fontWeight: '700' }}>{fmt(totals.openPremium)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.openUnrealizedPnL, isDark), fontWeight: '700' }}>{fmt(totals.openUnrealizedPnL)}</td>
                <td colSpan={3} style={{ padding: '10px 12px', borderLeft: `1px solid ${border}` }} />
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.stockUnrealizedPnL, isDark), fontWeight: '700' }}>{fmt(totals.stockUnrealizedPnL)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.net, isDark), fontWeight: '700', fontSize: '15px', borderLeft: `2px solid ${border}` }}>{fmt(totals.net)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.net + totals.openUnrealizedPnL, isDark), fontWeight: '700', fontSize: '15px', borderLeft: `1px solid ${border}` }}>{fmt(totals.net + totals.openUnrealizedPnL)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: pnlColor(totals.dayPnl, isDark), fontWeight: '700', fontSize: '15px', borderLeft: `1px solid ${border}` }}>{totals.dayPnl != null ? `${totals.dayPnl >= 0 ? '+' : ''}${fmt(totals.dayPnl)}` : '—'}</td>
                {(() => {
                  const npo = totals.net + totals.openUnrealizedPnL
                  const sp = totals.stockUnrealizedPnL
                  const pct = (sp !== 0) ? Math.round(((npo - sp) / Math.abs(sp)) * 1000) / 10 : null
                  return (
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: '700', color: pct == null ? textMid : pnlColor(npo >= sp ? 1 : -1, isDark), borderLeft: `1px solid ${border}` }}
                        title={pct == null ? '' : `Options contributed ${fmt(Math.round((npo - sp) * 100) / 100)} vs holding stock alone`}>
                      {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                    </td>
                  )
                })()}
                <td style={{ borderLeft: `1px solid ${border}` }} />
                <td style={{ borderLeft: `1px solid ${border}` }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
