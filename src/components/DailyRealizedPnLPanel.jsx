import React, { useState, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '$0.00'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const getDateStr = (dateVal) => {
  if (!dateVal) return ''
  if (typeof dateVal === 'string') return dateVal.split('T')[0].split(' ')[0]
  if (dateVal instanceof Date) {
    return dateVal.toISOString().split('T')[0]
  }
  return String(dateVal).split('T')[0]
}

const getTodayStr = () => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

const getWeekStartStr = () => {
  const n = new Date()
  const day = n.getDay()
  n.setDate(n.getDate() - (day === 0 ? 6 : day - 1))
  return getDateStr(n)
}

const getMonthStartStr = () => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
}

// Extract the parent ticker for search matching (e.g. "AAPL" from "AAPL 01/15/2026 $200 Call")
function getUnderlying(tx) {
  if (!tx.isOption) return tx.symbol
  const m = (tx.description || tx.symbol || '').match(/^([A-Z]+)/)
  return m ? m[1] : tx.symbol
}

// FIFO matching over a date range — returns one row per closing transaction.
function computeTransactions(trades, fromDate, toDate) {
  if (!fromDate || !toDate) return []

  const bySymbol = {}
  trades.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = []
    bySymbol[t.symbol].push(t)
  })

  const results = []

  Object.entries(bySymbol).forEach(([symbol, symTrades]) => {
    const isOpening = (t) => {
      const tc = (t.transCode || '').toUpperCase()
      return tc === 'BTO' || tc.includes('BUY') || tc === 'STO'
    }
    const sorted = [...symTrades].sort((a, b) => {
      const dateA = new Date(a.date || a.transDate)
      const dateB = new Date(b.date || b.transDate)
      if (dateA.getTime() !== dateB.getTime()) return dateA - dateB
      return (isOpening(a) ? 0 : 1) - (isOpening(b) ? 0 : 1)
    })

    const buyQueue = []   // long positions
    const sellQueue = []  // short (STO) positions

    sorted.forEach(trade => {
      const tDate = getDateStr(trade.date || trade.transDate)
      const inRange = tDate >= fromDate && tDate <= toDate
      const tc = (trade.transCode || '').toUpperCase()

      if (tc === 'STO') {
        sellQueue.push({ quantity: trade.quantity, price: trade.price })

      } else if (tc === 'BTC') {
        let rem = trade.quantity, premium = 0
        while (rem > 0 && sellQueue.length > 0) {
          const o = sellQueue[0]
          const m = Math.min(o.quantity, rem)
          premium += o.price * m
          rem -= m; o.quantity -= m
          if (o.quantity < 0.001) sellQueue.shift()
        }
        const matched = trade.quantity - rem
        if (inRange && matched > 0) {
          results.push({
            symbol, isOption: trade.isOption, description: trade.description,
            transCode: tc, date: tDate,
            sellValue: premium,
            costBasis: trade.price * matched,
            realizedPnL: premium - trade.price * matched,
          })
        }

      } else if (trade.isBuy) {
        buyQueue.push({ quantity: trade.quantity, price: trade.price })

      } else {
        let rem = trade.quantity, cost = 0
        while (rem > 0 && buyQueue.length > 0) {
          const o = buyQueue[0]
          const m = Math.min(o.quantity, rem)
          cost += o.price * m
          rem -= m; o.quantity -= m
          if (o.quantity < 0.001) buyQueue.shift()
        }
        const matched = trade.quantity - rem
        if (inRange && matched > 0) {
          results.push({
            symbol, isOption: trade.isOption, description: trade.description,
            transCode: tc, date: tDate,
            sellValue: trade.price * matched,
            costBasis: cost,
            realizedPnL: trade.price * matched - cost,
          })
        }
      }
    })
  })

  // Sort: date descending, then by |P&L| descending within each day
  return results.sort((a, b) =>
    b.date !== a.date
      ? b.date.localeCompare(a.date)
      : Math.abs(b.realizedPnL) - Math.abs(a.realizedPnL)
  )
}

function getDatesWithCloses(trades) {
  const dates = new Set()
  trades.forEach(t => {
    const tc = (t.transCode || '').toUpperCase()
    if (!t.isBuy || tc === 'BTC') {
      const d = getDateStr(t.date || t.transDate)
      if (d) dates.add(d)
    }
  })
  return [...dates].sort().reverse()
}

export default function DailyRealizedPnLPanel({ trades }) {
  const { isDark } = useTheme()

  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [search, setSearch] = useState('')

  const allDates = useMemo(() => getDatesWithCloses(trades || []), [trades])
  const latestDate = allDates[0] || ''
  const earliestDate = allDates[allDates.length - 1] || ''

  // Fall back to latest date when nothing is selected
  const effectiveFrom = fromDate || latestDate
  const effectiveTo = toDate || latestDate
  const isMultiDay = effectiveFrom !== effectiveTo

  // Detect which quick button is active
  const today = getTodayStr()
  const weekStart = getWeekStartStr()
  const monthStart = getMonthStartStr()
  const activeQuick = useMemo(() => {
    if (!fromDate && !toDate) return 'latest'
    if (fromDate === today && toDate === today) return 'today'
    if (fromDate === weekStart && toDate === today) return 'week'
    if (fromDate === monthStart && toDate === today) return 'mtd'
    if (fromDate === earliestDate && toDate === latestDate) return 'all'
    return null
  }, [fromDate, toDate, today, weekStart, monthStart, earliestDate, latestDate])

  const allTransactions = useMemo(
    () => computeTransactions(trades || [], effectiveFrom, effectiveTo),
    [trades, effectiveFrom, effectiveTo]
  )

  const filteredTransactions = useMemo(() => {
    const q = search.trim().toUpperCase()
    if (!q) return allTransactions
    return allTransactions.filter(tx => {
      const underlying = getUnderlying(tx)
      return (
        underlying.includes(q) ||
        tx.symbol.toUpperCase().includes(q) ||
        (tx.description || '').toUpperCase().includes(q)
      )
    })
  }, [allTransactions, search])

  const totalPnL = useMemo(
    () => filteredTransactions.reduce((s, t) => s + t.realizedPnL, 0),
    [filteredTransactions]
  )

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const rowAlt = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)'
  const rowBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
  const sepBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'
  const green = '#22c55e'
  const red = '#ef4444'
  const pnlColor = (n) => (n >= 0 ? green : red)

  const fmtDate = (s) => {
    if (!s) return '—'
    return new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    })
  }

  const fmtDateShort = (s) => {
    if (!s) return '—'
    return new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric'
    })
  }

  const inputStyle = {
    padding: '6px 10px', borderRadius: '6px',
    border: `1px solid ${border}`,
    background: surface, color: text,
    fontSize: '13px'
  }

  const quickBtnStyle = (key) => ({
    padding: '5px 11px', fontSize: '12px', fontWeight: '600',
    borderRadius: '6px', cursor: 'pointer',
    border: `1px solid ${activeQuick === key ? '#667eea' : border}`,
    background: activeQuick === key
      ? (isDark ? 'rgba(102,126,234,0.2)' : 'rgba(102,126,234,0.12)')
      : 'transparent',
    color: activeQuick === key ? '#667eea' : textMid,
  })

  const hasData = trades && trades.length > 0

  return (
    <div style={{
      background: surface, border: `1px solid ${border}`,
      borderRadius: '12px', padding: '20px', marginBottom: '20px', color: text
    }}>
      {/* ── Title + Total ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>Realized P&amp;L</h2>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '3px' }}>
            {isMultiDay
              ? `${fmtDateShort(effectiveFrom)} – ${fmtDateShort(effectiveTo)}`
              : effectiveFrom ? fmtDate(effectiveFrom) : 'No data'}
            {filteredTransactions.length > 0 &&
              ` · ${filteredTransactions.length} trade${filteredTransactions.length !== 1 ? 's' : ''}${search ? ' (filtered)' : ''}`}
          </div>
        </div>

        {filteredTransactions.length > 0 && (
          <div style={{
            fontSize: '22px', fontWeight: '800', color: pnlColor(totalPnL),
            background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
            borderRadius: '8px', padding: '6px 16px'
          }}>
            {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
          </div>
        )}
      </div>

      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
        {/* Search */}
        <input
          type="text"
          placeholder="Search underlying…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, minWidth: '160px', flex: '1 1 160px' }}
        />

        {/* Date range */}
        <input
          type="date"
          value={effectiveFrom}
          onChange={e => { setFromDate(e.target.value); if (!toDate) setToDate(e.target.value) }}
          style={{ ...inputStyle, cursor: 'pointer' }}
        />
        <span style={{ color: textMid, fontSize: '12px' }}>to</span>
        <input
          type="date"
          value={effectiveTo}
          onChange={e => setToDate(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        />

        {/* Quick buttons */}
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {hasData && (
            <button style={quickBtnStyle('latest')} onClick={() => { setFromDate(''); setToDate('') }}>
              Latest
            </button>
          )}
          <button style={quickBtnStyle('today')} onClick={() => { setFromDate(today); setToDate(today) }}>
            Today
          </button>
          <button style={quickBtnStyle('week')} onClick={() => { setFromDate(weekStart); setToDate(today) }}>
            Week
          </button>
          <button style={quickBtnStyle('mtd')} onClick={() => { setFromDate(monthStart); setToDate(today) }}>
            MTD
          </button>
          {hasData && earliestDate && (
            <button style={quickBtnStyle('all')} onClick={() => { setFromDate(earliestDate); setToDate(latestDate) }}>
              All
            </button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      {!hasData ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
          Upload a CSV to see realized P&amp;L
        </div>
      ) : filteredTransactions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
          {search
            ? `No trades matching "${search}" in this range`
            : `No closed positions in this date range`}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${border}` }}>
                {[
                  ['Symbol / Description', 'left'],
                  ['Type', 'center'],
                  ['Proceeds', 'right'],
                  ['Cost Basis', 'right'],
                  ['Realized P&L', 'right']
                ].map(([h, align]) => (
                  <th key={h} style={{
                    padding: '8px 10px', textAlign: align,
                    color: '#ffffff', fontWeight: '700', fontSize: '13px', whiteSpace: 'nowrap'
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTransactions.map((tx, i) => {
                const prevDate = i > 0 ? filteredTransactions[i - 1].date : null
                const showSep = isMultiDay && tx.date !== prevDate

                // Subtotal for this date group (for the separator)
                let groupTotal = null
                if (showSep) {
                  groupTotal = filteredTransactions
                    .filter(t => t.date === tx.date)
                    .reduce((s, t) => s + t.realizedPnL, 0)
                }

                return (
                  <React.Fragment key={i}>
                    {showSep && (
                      <tr>
                        <td colSpan={5} style={{
                          padding: '8px 10px 5px',
                          background: sepBg,
                          borderTop: i > 0 ? `1px solid ${border}` : 'none'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '12px', fontWeight: '700', color: textMid }}>
                              {fmtDate(tx.date)}
                            </span>
                            {groupTotal !== null && (
                              <span style={{ fontSize: '12px', fontWeight: '700', color: pnlColor(groupTotal) }}>
                                {groupTotal >= 0 ? '+' : ''}{fmt(groupTotal)}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr style={{
                      background: i % 2 === 1 ? rowAlt : 'transparent',
                      borderBottom: `1px solid ${rowBorder}`
                    }}>
                      <td style={{ padding: '10px' }}>
                        <div style={{ fontWeight: '600', fontSize: '13px', lineHeight: 1.3 }}>
                          {tx.isOption ? tx.description : tx.symbol}
                        </div>
                        <div style={{ fontSize: '10px', color: textMid, marginTop: '2px' }}>
                          {tx.transCode}
                        </div>
                      </td>

                      <td style={{ padding: '10px', textAlign: 'center' }}>
                        <span style={{
                          fontSize: '11px', fontWeight: '600',
                          padding: '2px 8px', borderRadius: '4px',
                          background: tx.isOption
                            ? (isDark ? 'rgba(147,51,234,0.2)' : 'rgba(147,51,234,0.1)')
                            : (isDark ? 'rgba(59,130,246,0.2)' : 'rgba(59,130,246,0.1)'),
                          color: tx.isOption ? '#a855f7' : '#3b82f6'
                        }}>
                          {tx.isOption ? 'Option' : 'Stock'}
                        </span>
                      </td>

                      <td style={{ padding: '10px', textAlign: 'right', color: textMid }}>
                        {fmt(tx.sellValue)}
                      </td>

                      <td style={{ padding: '10px', textAlign: 'right', color: textMid }}>
                        {fmt(tx.costBasis)}
                      </td>

                      <td style={{ padding: '10px', textAlign: 'right', fontWeight: '700' }}>
                        <span style={{ color: pnlColor(tx.realizedPnL) }}>
                          {tx.realizedPnL >= 0 ? '+' : ''}{fmt(tx.realizedPnL)}
                        </span>
                      </td>
                    </tr>
                  </React.Fragment>
                )
              })}
            </tbody>
            {filteredTransactions.length > 1 && (
              <tfoot>
                <tr style={{ borderTop: `2px solid ${border}` }}>
                  <td colSpan={4} style={{
                    padding: '10px', fontWeight: '700',
                    color: textMid, fontSize: '12px'
                  }}>
                    Total · {filteredTransactions.length} trade{filteredTransactions.length !== 1 ? 's' : ''}
                    {search && ` · filtered by "${search}"`}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', fontWeight: '800', fontSize: '15px' }}>
                    <span style={{ color: pnlColor(totalPnL) }}>
                      {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  )
}
