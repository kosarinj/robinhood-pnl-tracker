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
    return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`
  }
  return String(dateVal).split('T')[0]
}

// FIFO matching for long (BTO/Buy → STC/Sell) and short (STO → BTC) positions.
// For options in this app: quantity=1, price=total dollar amount.
function computeTransactions(trades, dateStr) {
  if (!dateStr) return []

  const bySymbol = {}
  trades.forEach(t => {
    const sym = t.symbol
    if (!bySymbol[sym]) bySymbol[sym] = []
    bySymbol[sym].push(t)
  })

  const results = []

  Object.entries(bySymbol).forEach(([symbol, symTrades]) => {
    const sorted = [...symTrades].sort((a, b) =>
      new Date(a.date || a.transDate) - new Date(b.date || b.transDate)
    )

    const buyQueue = []  // long positions: {quantity, price}
    const sellQueue = [] // short positions (STO): {quantity, price}

    sorted.forEach(trade => {
      const tradeDateStr = getDateStr(trade.date || trade.transDate)
      const isTarget = tradeDateStr === dateStr
      const tc = (trade.transCode || '').toUpperCase()

      if (tc === 'STO') {
        // Opening a short position — collect premium
        sellQueue.push({ quantity: trade.quantity, price: trade.price })

      } else if (tc === 'BTC') {
        // Closing a short position — match premium received vs cost to close
        let remaining = trade.quantity
        let totalPremium = 0
        while (remaining > 0 && sellQueue.length > 0) {
          const oldest = sellQueue[0]
          const matched = Math.min(oldest.quantity, remaining)
          totalPremium += oldest.price * matched
          remaining -= matched
          oldest.quantity -= matched
          if (oldest.quantity < 0.001) sellQueue.shift()
        }
        const matchedQty = trade.quantity - remaining
        if (isTarget && matchedQty > 0) {
          results.push({
            symbol, isOption: trade.isOption, description: trade.description,
            transCode: tc,
            sellValue: totalPremium,
            costBasis: trade.price * matchedQty,
            realizedPnL: totalPremium - trade.price * matchedQty,
            date: tradeDateStr
          })
        }

      } else if (trade.isBuy) {
        // BTO or regular Buy — add to long queue
        buyQueue.push({ quantity: trade.quantity, price: trade.price })

      } else {
        // STC or Sell — close long position via FIFO
        let remaining = trade.quantity
        let totalCost = 0
        while (remaining > 0 && buyQueue.length > 0) {
          const oldest = buyQueue[0]
          const matched = Math.min(oldest.quantity, remaining)
          totalCost += oldest.price * matched
          remaining -= matched
          oldest.quantity -= matched
          if (oldest.quantity < 0.001) buyQueue.shift()
        }
        const matchedQty = trade.quantity - remaining
        if (isTarget && matchedQty > 0) {
          results.push({
            symbol, isOption: trade.isOption, description: trade.description,
            transCode: tc,
            sellValue: trade.price * matchedQty,
            costBasis: totalCost,
            realizedPnL: trade.price * matchedQty - totalCost,
            date: tradeDateStr
          })
        }
      }
    })
  })

  return results.sort((a, b) => Math.abs(b.realizedPnL) - Math.abs(a.realizedPnL))
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
  const [selectedDate, setSelectedDate] = useState('')

  const allDates = useMemo(() => getDatesWithCloses(trades || []), [trades])
  const effectiveDate = selectedDate || allDates[0] || ''

  const transactions = useMemo(
    () => computeTransactions(trades || [], effectiveDate),
    [trades, effectiveDate]
  )

  const totalPnL = useMemo(
    () => transactions.reduce((sum, t) => sum + t.realizedPnL, 0),
    [transactions]
  )

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const rowAlt = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)'
  const rowBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
  const green = '#22c55e'
  const red = '#ef4444'
  const pnlColor = (n) => (n >= 0 ? green : red)

  const fmtDate = (s) => {
    if (!s) return '—'
    return new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    })
  }

  const hasData = trades && trades.length > 0

  return (
    <div style={{
      background: surface,
      border: `1px solid ${border}`,
      borderRadius: '12px',
      padding: '20px',
      marginBottom: '20px',
      color: text
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>Daily Realized P&amp;L</h2>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '3px' }}>
            {effectiveDate ? fmtDate(effectiveDate) : 'No data'}
            {transactions.length > 0 && ` · ${transactions.length} closed trade${transactions.length !== 1 ? 's' : ''}`}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {transactions.length > 0 && (
            <div style={{
              fontSize: '22px', fontWeight: '800',
              color: pnlColor(totalPnL),
              background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
              borderRadius: '8px', padding: '6px 16px'
            }}>
              {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
            </div>
          )}

          <input
            type="date"
            value={effectiveDate}
            onChange={e => setSelectedDate(e.target.value)}
            list="daily-realized-dates"
            style={{
              padding: '6px 10px', borderRadius: '6px',
              border: `1px solid ${border}`,
              background: surface, color: text,
              fontSize: '13px', cursor: 'pointer'
            }}
          />
          <datalist id="daily-realized-dates">
            {allDates.map(d => <option key={d} value={d} />)}
          </datalist>
        </div>
      </div>

      {/* Body */}
      {!hasData ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
          Upload a CSV to see daily realized P&amp;L
        </div>
      ) : transactions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
          No closed positions on {fmtDate(effectiveDate)}
          {allDates.length > 0 && effectiveDate !== allDates[0] && (
            <div style={{ marginTop: '10px' }}>
              <button
                onClick={() => setSelectedDate(allDates[0])}
                style={{
                  background: 'none', border: `1px solid ${border}`,
                  borderRadius: '6px', color: textMid,
                  padding: '5px 14px', fontSize: '12px', cursor: 'pointer'
                }}
              >
                Go to latest ({fmtDate(allDates[0])})
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${border}` }}>
                {[
                  ['Symbol / Description', 'left'],
                  ['Type', 'center'],
                  ['Proceeds', 'right'],
                  ['Cost Basis', 'right'],
                  ['Realized P&L', 'right']
                ].map(([h, align]) => (
                  <th key={h} style={{
                    padding: '8px 10px', textAlign: align,
                    color: text, fontWeight: '700',
                    fontSize: '13px', whiteSpace: 'nowrap'
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx, i) => (
                <tr
                  key={i}
                  style={{
                    background: i % 2 === 1 ? rowAlt : 'transparent',
                    borderBottom: `1px solid ${rowBorder}`
                  }}
                >
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
              ))}
            </tbody>
            {transactions.length > 1 && (
              <tfoot>
                <tr style={{ borderTop: `2px solid ${border}` }}>
                  <td colSpan={4} style={{
                    padding: '10px', fontWeight: '700',
                    color: textMid, fontSize: '12px', textTransform: 'uppercase'
                  }}>
                    Total · {transactions.length} trades
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
