import React, { useState, useEffect } from 'react'

/**
 * Dividend schedule for the shares you hold.
 *
 * Declared payments come straight from Polygon; the rest of the year is
 * projected from each name's last payment and frequency and is labelled
 * "est." so a guess never reads as a declaration. A short call on a name going
 * ex soon is flagged: that is the day before which it can be assigned early,
 * the holder taking the shares to collect the dividend.
 */

const fmtDate = (iso) => {
  if (!iso) return '—'
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const money = (n, digits = 0) =>
  `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

const RANGES = [['90', 'Next 90 days'], ['365', 'Next 12 months']]

export default function DividendSchedulePanel({ broker = 'all' }) {
  const [data, setData] = useState(null)
  const [range, setRange] = useState('90')

  useEffect(() => {
    let alive = true
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/dividend-schedule${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (alive) setData(d?.success ? d : { error: d?.error || 'failed' }) })
      .catch(e => { if (alive) setData({ error: e.message }) })
    return () => { alive = false }
  }, [broker])

  if (!data) return null
  const card = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '14px 16px', marginBottom: 20, color: 'var(--text)',
  }
  if (data.error) {
    return <div className="floating-panel" style={{ ...card, fontSize: 12.5, color: 'var(--textSecondary)' }}>
      Dividend schedule unavailable: {data.error}</div>
  }

  const today = data.today
  const daysTo = (iso) => Math.round((new Date(iso + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000)
  const limit = Number(range)
  const shown = data.events.filter(e => daysTo(e.exDate) <= limit || (e.payDate && e.exDate < today))
  const total = shown.reduce((a, e) => a + e.expected, 0)
  const year = data.events.reduce((a, e) => a + e.expected, 0)

  const stat = (label, value, sub) => (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--textSecondary)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--textSecondary)' }}>{sub}</div>}
    </div>
  )
  const th = { padding: '6px 8px', fontSize: 11, fontWeight: 600, color: 'var(--textSecondary)', textAlign: 'right', whiteSpace: 'nowrap' }
  const td = { padding: '6px 8px', fontSize: 12.5, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }

  return (
    <div className="floating-panel" style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }}>Dividend schedule</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(([k, label]) => (
            <button key={k} onClick={() => setRange(k)} style={{
              fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${range === k ? 'var(--accent)' : 'var(--border)'}`,
              background: range === k ? 'var(--accent)' : 'transparent',
              color: range === k ? 'var(--accentText)' : 'var(--textSecondary)',
            }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 12 }}>
        {stat(range === '90' ? 'Coming, next 90 days' : 'Coming, next 12 months', money(total), `${shown.length} payment${shown.length !== 1 ? 's' : ''}`)}
        {stat('Next 12 months (est.)', money(year), `${data.payers.length} of ${data.checked} holdings pay`)}
        {stat(`Received ${today.slice(0, 4)}`, money(data.receivedYtd), 'from your imports')}
      </div>

      {data.unavailable && (
        <div style={{ fontSize: 11.5, color: 'var(--warning)', marginBottom: 8 }}>{data.unavailable}</div>
      )}

      {shown.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>
          {data.payers.length ? 'No ex-dates in this window.' : 'None of your holdings pay a dividend.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
                <th style={th} title="Own the shares before this date to get the dividend">Ex-date</th>
                <th style={th}>Pay date</th>
                <th style={th}>Per share</th>
                <th style={th}>Shares</th>
                <th style={th}>Expected</th>
                <th style={{ ...th, textAlign: 'left' }}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(e => {
                const d = daysTo(e.exDate)
                const risk = e.shortCalls && d >= 0 && d <= 14
                return (
                  <tr key={`${e.ticker}-${e.exDate}`} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{e.ticker}</td>
                    <td style={td}>
                      {fmtDate(e.exDate)}
                      {d >= 0 && d <= 7 && <span style={{ fontSize: 10, color: 'var(--warning)', fontWeight: 700 }}> {d === 0 ? 'today' : `${d}d`}</span>}
                    </td>
                    <td style={{ ...td, color: 'var(--textSecondary)' }}>{fmtDate(e.payDate)}</td>
                    <td style={td}>{money(e.amount, e.amount < 1 ? 4 : 2)}</td>
                    <td style={{ ...td, color: 'var(--textSecondary)' }}>{e.shares.toLocaleString()}</td>
                    <td style={{ ...td, fontWeight: 700, color: 'var(--positive)' }}>{money(e.expected, 2)}</td>
                    <td style={{ ...td, textAlign: 'left', fontSize: 11 }}>
                      {e.status === 'estimated' && <span style={{ color: 'var(--textSecondary)' }}
                        title="Not declared yet — projected from the last payment and how often it pays">est.</span>}
                      {e.status === 'special' && <span style={{ color: 'var(--accent)' }}>special</span>}
                      {risk && <span style={{ color: 'var(--severity)', fontWeight: 700, marginLeft: 6 }}
                        title="You're short calls on this name. If the dividend is worth more than a call's remaining time value, it can be assigned the day before the ex-date and you'd miss the dividend and lose the shares.">
                        short calls — early assignment risk</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--textSecondary)', marginTop: 8 }}>
        Expected = today's shares × per-share amount. "est." payments aren't declared yet and assume the last amount repeats.
      </div>
    </div>
  )
}
