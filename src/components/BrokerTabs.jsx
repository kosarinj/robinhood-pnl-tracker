import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Broker selector for the dashboard.
 *
 * "All brokers" is the merged view. Note what merged means here: P&L is still
 * matched inside each broker separately (a sale at one can't close a lot at
 * another) and the finished numbers are added up. It is not one commingled
 * pool of lots.
 *
 * Renders nothing when only one broker has data — a lone tab is just noise.
 */

const LABELS = {
  all: 'All brokers',
  robinhood: 'Robinhood',
  webull: 'Webull',
  schwab: 'Schwab',
}

export default function BrokerTabs({ value, onChange, refreshKey = 0 }) {
  const { isDark } = useTheme()
  const [brokers, setBrokers] = useState(null)   // null = not loaded yet

  useEffect(() => {
    fetch('/api/brokers', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setBrokers(d?.brokers || []))
      .catch(() => setBrokers([]))
  }, [refreshKey])

  if (brokers === null) return null

  const border = isDark ? '#2d3748' : '#e2e8f0'
  const textMid = isDark ? '#94a3b8' : '#64748b'

  // With one broker there's nothing to switch between, but staying silent made
  // it look like the feature was missing. Say what the server actually has —
  // which also surfaces an import that didn't land.
  if (brokers.length < 2) {
    const only = brokers[0]
    return (
      <div style={{
        marginBottom: 16, padding: '7px 12px', fontSize: 12, color: textMid,
        background: isDark ? '#1e2130' : '#ffffff',
        border: `1px solid ${border}`, borderRadius: 10,
      }}>
        {only
          ? <>Showing <strong style={{ color: isDark ? '#e2e8f0' : '#1a202c' }}>{LABELS[only.broker] || only.broker}</strong> only
              {' '}({only.trade_count} trades). Upload another broker's CSV — using the dropdown
              next to the Upload button — and broker tabs will appear here.</>
          : <>No trades yet. Upload a CSV to get started.</>}
      </div>
    )
  }

  const tabs = [
    { key: 'all', count: brokers.reduce((s, b) => s + b.trade_count, 0) },
    ...brokers.map(b => ({ key: b.broker, count: b.trade_count })),
  ]

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      marginBottom: 16, padding: '8px 12px',
      background: isDark ? '#1e2130' : '#ffffff',
      border: `1px solid ${border}`, borderRadius: 10,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: textMid, textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 4 }}>
        Broker
      </span>
      {tabs.map(t => {
        const activeTab = value === t.key
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            title={t.key === 'all'
              ? 'Every broker combined. P&L is still matched within each broker, then summed.'
              : `Only ${LABELS[t.key] || t.key} trades`}
            style={{
              padding: '5px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              borderRadius: 6,
              border: `1px solid ${activeTab ? '#667eea' : border}`,
              background: activeTab ? '#667eea' : 'transparent',
              color: activeTab ? '#fff' : textMid,
            }}
          >
            {LABELS[t.key] || t.key}
            <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 500, fontSize: 11 }}>{t.count}</span>
          </button>
        )
      })}
    </div>
  )
}
