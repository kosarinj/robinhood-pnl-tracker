import React, { useRef } from 'react'

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
]

export default function UploadButton({ broker, onBrokerChange, onFile, style = {} }) {
  const inputRef = useRef(null)

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
    </span>
  )
}
