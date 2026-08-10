import React, { useRef, useState } from 'react'

// Each broker exports a different file, so the picker doubles as a hint about
// which export to grab — picking the wrong one is the most likely mistake.
const BROKERS = [
  { key: 'robinhood', label: 'Robinhood', hint: 'Account statement / activity CSV' },
  { key: 'webull', label: 'Webull', hint: 'Orders Records export' },
]

function CSVUpload({ onFileUpload }) {
  const fileInputRef = useRef(null)
  const [broker, setBroker] = useState('robinhood')

  const handleFileChange = (event) => {
    const file = event.target.files[0]
    if (file) {
      if (!file.name.endsWith('.csv')) {
        alert('Please upload a CSV file')
        return
      }
      onFileUpload(file, broker)
    }
    // Let the same file be re-selected (e.g. after switching broker)
    event.target.value = ''
  }

  const handleClick = () => {
    fileInputRef.current.click()
  }

  const active = BROKERS.find(b => b.key === broker)

  return (
    <div className="upload-section">
      <h2>Upload Trades</h2>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 10 }}>
        {BROKERS.map(b => (
          <button
            key={b.key}
            onClick={() => setBroker(b.key)}
            style={{
              padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              borderRadius: 6,
              border: `1px solid ${broker === b.key ? '#667eea' : 'rgba(128,128,128,0.4)'}`,
              background: broker === b.key ? '#667eea' : 'transparent',
              color: broker === b.key ? '#fff' : 'inherit',
            }}
          >{b.label}</button>
        ))}
      </div>

      <p>{active.hint}</p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <button onClick={handleClick}>
        Choose {active.label} CSV
      </button>
    </div>
  )
}

export default CSVUpload
