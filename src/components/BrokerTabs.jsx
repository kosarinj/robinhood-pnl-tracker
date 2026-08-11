import React, { useState, useEffect } from 'react'

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

/**
 * `inline` drops the card chrome so this can sit inside the context row under
 * the main tabs, rather than being its own panel floating in the page body.
 */
export default function BrokerTabs({ value, onChange, refreshKey = 0, inline = false }) {
  const [brokers, setBrokers] = useState(null)   // null = not loaded yet

  useEffect(() => {
    fetch('/api/brokers', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setBrokers(d?.brokers || []))
      .catch(() => setBrokers([]))
  }, [refreshKey])

  if (brokers === null) return null


  // With one broker there's nothing to switch between, but staying silent made
  // it look like the feature was missing. Say what the server actually has —
  // which also surfaces an import that didn't land.
  if (brokers.length < 2) {
    const only = brokers[0]
    return (
      <div style={inline ? { fontSize: 12, color: 'var(--textSecondary)' } : {
        marginBottom: 16, padding: '7px 12px', fontSize: 12, color: 'var(--textSecondary)',
        background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 10,
      }}>
        {only
          ? <>Showing <strong style={{ color: 'var(--text)' }}>{LABELS[only.broker] || only.broker}</strong> only
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
    <div style={inline ? {
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    } : {
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      marginBottom: 16, padding: '8px 12px',
      background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 10,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--textSecondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 4 }}>
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
              border: `1px solid ${activeTab ? 'var(--accent)' : 'var(--border)'}`,
              background: activeTab ? 'var(--accent)' : 'transparent',
              color: activeTab ? 'var(--accentText)' : 'var(--textSecondary)',
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
