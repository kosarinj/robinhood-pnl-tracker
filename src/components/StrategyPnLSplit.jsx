import React from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmt = (n) => {
  if (!n && n !== 0) return '$0.00'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

export default function StrategyPnLSplit({ pnlData }) {
  const { isDark } = useTheme()
  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const green = '#22c55e'
  const red = '#ef4444'
  const purple = '#667eea'

  // Compute directly from pnlData prop (already available in App)
  const withOptions = pnlData.filter(r => (r.optionsCount || 0) > 0)
  const pureStocks = pnlData.filter(r => (r.optionsCount || 0) === 0)

  const sumDailyPnL = (arr) => arr.reduce((s, r) => s + (r.dailyPnL || 0), 0)
  const sumOptionsPnL = (arr) => arr.reduce((s, r) => s + (r.optionsPnL || 0), 0)

  const withOptDailyPnL = sumDailyPnL(withOptions)
  const pureDailyPnL = sumDailyPnL(pureStocks)
  const optionsPnL = sumOptionsPnL(withOptions)

  const cardStyle = (accentColor) => ({
    background: surface,
    border: `1px solid ${border}`,
    borderLeft: `4px solid ${accentColor}`,
    borderRadius: '12px',
    padding: '18px 22px',
    flex: 1,
    minWidth: '200px'
  })

  if (!pnlData.length) return null

  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.07em', color: textMid, marginBottom: '10px' }}>
        Strategy Performance &#8212; Today
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {/* Strategy stocks */}
        <div style={cardStyle(purple)}>
          <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: purple, marginBottom: '8px' }}>
            Strategy Stocks ({withOptions.length})
          </div>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '11px', color: textMid, marginBottom: '3px' }}>Stock Daily P&amp;L</div>
              <div style={{ fontSize: '1.1rem', fontWeight: '700', color: withOptDailyPnL >= 0 ? green : red }}>{fmt(withOptDailyPnL)}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: textMid, marginBottom: '3px' }}>Options P&amp;L</div>
              <div style={{ fontSize: '1.1rem', fontWeight: '700', color: optionsPnL >= 0 ? green : red }}>{fmt(optionsPnL)}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: textMid, marginBottom: '3px' }}>Combined</div>
              <div style={{ fontSize: '1.1rem', fontWeight: '700', color: (withOptDailyPnL + optionsPnL) >= 0 ? green : red }}>
                {fmt(withOptDailyPnL + optionsPnL)}
              </div>
            </div>
          </div>
          <div style={{ marginTop: '8px', fontSize: '11px', color: textMid }}>
            {withOptions.map(r => r.symbol).join(', ')}
          </div>
        </div>
        {/* Pure stocks */}
        {pureStocks.length > 0 && (
          <div style={cardStyle('#06b6d4')}>
            <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#06b6d4', marginBottom: '8px' }}>
              Pure Stock Positions ({pureStocks.length})
            </div>
            <div>
              <div style={{ fontSize: '11px', color: textMid, marginBottom: '3px' }}>Daily P&amp;L</div>
              <div style={{ fontSize: '1.1rem', fontWeight: '700', color: pureDailyPnL >= 0 ? green : red }}>{fmt(pureDailyPnL)}</div>
            </div>
            <div style={{ marginTop: '8px', fontSize: '11px', color: textMid }}>
              {pureStocks.map(r => r.symbol).join(', ')}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
