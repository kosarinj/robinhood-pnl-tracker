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

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const green = '#22c55e'
  const red = '#ef4444'

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/options-pnl/history', { credentials: 'include' })
      const json = await res.json()
      if (json.success) setData(json)
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

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
  const totalStockPnL = Object.values(data?.weeklyStockPnL || {}).reduce((s, v) => s + v, 0)
  const otherStockPnL = data?.otherStockPnL || 0
  const netWeekPnL = (data?.currentWeekPnL || 0) + totalStockPnL + otherStockPnL

  return (
    <div style={{ color: text }}>
      {/* This Week Hero Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        {/* Options P&L */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${(data?.currentWeekPnL || 0) >= 0 ? green : red}` }}>
          <div style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: textMid, marginBottom: '6px' }}>This Week — Options</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: (data?.currentWeekPnL || 0) >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(data?.currentWeekPnL || 0)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>
            Realized: <span style={{ color: (data?.currentWeekRealizedTotal || 0) >= 0 ? green : red, fontWeight: '600' }}>{fmt(data?.currentWeekRealizedTotal || 0)}</span>
          </div>
        </div>
        {/* Stock P&L */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${totalStockPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: textMid, marginBottom: '6px' }}>This Week — Stock</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: totalStockPnL >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(totalStockPnL)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>Fri–Fri close · {Object.keys(data?.weeklyStockPnL || {}).length} positions</div>
        </div>
        {/* Other Stocks */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${otherStockPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: textMid, marginBottom: '6px' }}>This Week — Other Stocks</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: otherStockPnL >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(otherStockPnL)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>Fri–Fri close · {data?.otherStockCount || 0} positions</div>
        </div>
        {/* Net Total */}
        <div style={{ ...cardStyle, marginBottom: 0, borderLeft: `4px solid ${netWeekPnL >= 0 ? green : red}` }}>
          <div style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: textMid, marginBottom: '6px' }}>This Week — Net Total</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: netWeekPnL >= 0 ? green : red, lineHeight: 1 }}>
            {loading ? '…' : fmt(netWeekPnL)}
          </div>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '6px' }}>Options + all stocks</div>
        </div>
      </div>

      {/* Per-underlying breakdown + refresh */}
      <div style={{
        ...cardStyle,
        borderLeft: `4px solid ${(data?.currentWeekPnL || 0) >= 0 ? green : red}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: '700', color: text }}>By Underlying</div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: textMid }}>{data?.weekStart ? `Week of ${fmtDate(data.weekStart)}` : ''}</span>
            <button onClick={fetchData} style={{ ...btnStyle(false), padding: '6px 14px' }}>&#8635; Refresh</button>
          </div>
        </div>

        {/* Per-underlying breakdown for current week */}
        {data?.currentWeekByUnderlying && Object.keys(data.currentWeekByUnderlying).length > 0 && (
          <div style={{ paddingTop: '12px', borderTop: `1px solid ${border}` }}>
            <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: textMid, marginBottom: '8px' }}>
              This Week by Underlying
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {Object.entries(data.currentWeekByUnderlying).map(([ticker, optPnl]) => {
                const stockPnl = data.weeklyStockPnL?.[ticker]
                const combined = stockPnl !== undefined ? optPnl + stockPnl : null
                const trades = data.currentWeekTradesByUnderlying?.[ticker] || []
                const realizedPnl = data.currentWeekRealizedByUnderlying?.[ticker]
                const isExpanded = expandedTicker === ticker
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
                        <span style={{ fontWeight: '700', color: text }}>{ticker}</span>
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
                          <div style={{ color: stockPnl >= 0 ? green : red }}>
                            Stock: {stockPnl >= 0 ? '+' : ''}{fmt(stockPnl)}
                          </div>
                        )}
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
                            display: 'flex', justifyContent: 'space-between', gap: '8px'
                          }}>
                            <div style={{ color: textMid, flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                <span style={{ color: text, fontWeight: '600' }}>{t.transCode || t.action}</span>
                                <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
                                  background: t.isClosing ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
                                  color: t.isClosing ? green : textMid }}>
                                  {t.isClosing ? 'realized' : 'open'}
                                </span>
                                <span style={{ color: textMid }}>{t.date}</span>
                              </div>
                              <div style={{ wordBreak: 'break-word', lineHeight: '1.4' }}>{t.description}</div>
                            </div>
                            <div style={{ color: t.cashFlow >= 0 ? green : red, fontWeight: '700', whiteSpace: 'nowrap' }}>
                              {t.cashFlow >= 0 ? '+' : ''}{fmt(t.cashFlow)}
                            </div>
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
              <div style={{ fontSize: '11px', color: textMid, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{label}</div>
              <div style={{ fontSize: '1.2rem', fontWeight: '700', color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Weekly Table */}
      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: '700', fontSize: '14px' }}>Weekly Breakdown</span>
          <span style={{ fontSize: '12px', color: textMid }}>{filteredWeeks.length} week{filteredWeeks.length !== 1 ? 's' : ''}</span>
        </div>
        {loading && <div style={{ padding: '40px', textAlign: 'center', color: textMid }}>Loading…</div>}
        {error && <div style={{ padding: '20px', color: red }}>{error}</div>}
        {!loading && !error && filteredWeeks.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: textMid }}>No data for selected range</div>
        )}
        {!loading && filteredWeeks.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: isDark ? '#252b3b' : '#f8fafc' }}>
                  {['Week Of', 'Trades', 'Options P&L', 'Realized', 'Running Total'].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '700',
                      textTransform: 'uppercase', letterSpacing: '0.06em', color: textMid, borderBottom: `1px solid ${border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredWeeks.map((week, i) => {
                  const { monday, friday } = getMondayOfWeek(week.weekStart)
                  const isPos = week.totalDelta >= 0
                  return (
                    <tr key={week.weekStart} style={{ borderBottom: `1px solid ${border}`, background: i % 2 === 0 ? 'transparent' : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)') }}>
                      <td style={{ padding: '10px 16px', color: text }}>
                        <span style={{ fontWeight: '600' }}>{fmtDate(monday)}</span>
                        <span style={{ color: textMid, marginLeft: '6px', fontSize: '12px' }}>&#8211; {fmtDate(friday)}</span>
                      </td>
                      <td style={{ padding: '10px 16px', color: textMid }}>{week.tradeCount || week.days?.length || 0}</td>
                      <td style={{ padding: '10px 16px', fontWeight: '700', color: isPos ? green : red }}>
                        {isPos ? '+' : ''}{fmt(week.totalDelta)}
                      </td>
                      <td style={{ padding: '10px 16px', color: (week.realizedDelta || 0) >= 0 ? green : red }}>
                        {(week.realizedDelta || 0) >= 0 ? '+' : ''}{fmt(week.realizedDelta || 0)}
                      </td>
                      <td style={{ padding: '10px 16px', color: text }}>{fmt(week.runningTotal)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: isDark ? '#252b3b' : '#f8fafc', borderTop: `2px solid ${border}` }}>
                  <td style={{ padding: '10px 16px', fontWeight: '700', color: text }}>Total</td>
                  <td style={{ padding: '10px 16px', color: textMid }}>{filteredWeeks.reduce((s, w) => s + (w.tradeCount || 0), 0)} trades</td>
                  <td style={{ padding: '10px 16px', fontWeight: '700', color: rangeTotal >= 0 ? green : red }}>
                    {rangeTotal >= 0 ? '+' : ''}{fmt(rangeTotal)}
                  </td>
                  <td></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
