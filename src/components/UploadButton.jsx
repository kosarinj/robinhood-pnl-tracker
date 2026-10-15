import React, { useEffect, useRef, useState } from 'react'

/**
 * The Upload CSV control, with the broker it applies to.
 *
 * The broker has to be chosen BEFORE the file dialog opens — the server parses
 * by broker, and running a Webull file through the Robinhood parser produces
 * plausible-looking wrong numbers rather than an error. So the selector sits
 * next to the button and the button label states which broker it will use.
 */

const BROKERS = [
  { key: 'robinhood', label: 'Robinhood' },
  { key: 'webull', label: 'Webull' },
  { key: 'schwab', label: 'Schwab' },
]

export default function UploadButton({ broker, onBrokerChange, onFile, refreshKey = 0, style = {} }) {
  const inputRef = useRef(null)
  // Latest trade date already stored per broker. Imports only add what isn't
  // stored yet, so an export starting a little before this date is enough.
  const [lastDates, setLastDates] = useState({})

  useEffect(() => {
    fetch('/api/brokers', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setLastDates(Object.fromEntries((d?.brokers || []).map(b => [b.broker, b.last_trade_date]))))
      .catch(() => {})
  }, [refreshKey])

  const lastDate = lastDates[broker]
  const lastDateLabel = lastDate
    ? new Date(`${lastDate}T00:00:00`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })
    : null

  const handleChange = (e) => {
    const file = e.target.files[0]
    if (file) onFile(file, broker)
    // Allow re-selecting the same file after switching broker
    e.target.value = ''
  }

  const label = BROKERS.find(b => b.key === broker)?.label || broker

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <select
        value={broker}
        onChange={e => onBrokerChange(e.target.value)}
        title="Which broker exported this file. The parsers differ — the wrong choice gives wrong numbers, not an error."
        style={{
          padding: '6px 8px', fontSize: 12, fontWeight: 600, borderRadius: 6,
          border: '1px solid rgba(128,128,128,0.4)', cursor: 'pointer',
          background: 'transparent', color: 'inherit',
        }}
      >
        {BROKERS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
      </select>

      <label className="upload-button" style={{ margin: 0 }}>
        📁 Upload {label} CSV
        <input ref={inputRef} type="file" accept=".csv" onChange={handleChange} style={{ display: 'none' }} />
      </label>

      {lastDateLabel && (
        <span
          title={`Trades through ${lastDateLabel} are already imported. Export from that date onward — overlap is fine, trades already stored are skipped.`}
          style={{ fontSize: 11, color: 'var(--textSecondary)', whiteSpace: 'nowrap' }}
        >
          through {lastDateLabel}
        </span>
      )}
    </span>
  )
}
