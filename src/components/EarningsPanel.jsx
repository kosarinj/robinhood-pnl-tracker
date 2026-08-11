import React, { useState, useEffect } from 'react'

/**
 * Upcoming earnings for what you actually hold.
 *
 * Deliberately close by: earnings is the one scheduled event that reliably
 * breaks the other estimates in this app. The Extended Hours panel holds
 * implied vol constant overnight, which is exactly wrong through a print, and
 * the theta projection assumes the underlying stands still. A name reporting
 * this week is a reason to distrust both.
 */

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

const urgency = (days) => {
  if (days <= 1) return { label: days === 0 ? 'Today' : 'Tomorrow', tone: 'var(--severity)', strong: true }
  if (days <= 7) return { label: `${days} days`, tone: 'var(--warning)', strong: true }
  return { label: `${days} days`, tone: 'var(--textSecondary)', strong: false }
}

export default function EarningsPanel({ broker = 'all' }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/earnings${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (alive) { setData(d?.success ? d : null); setLoading(false) } })
      .catch(() => { if (alive) { setData(null); setLoading(false) } })
    return () => { alive = false }
  }, [broker])

  if (loading || !data) return null
  const { upcoming = [], noDate = [], checked = 0 } = data
  if (!checked) return null

  return (
    <div className="floating-panel" style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px', marginBottom: 20, color: 'var(--text)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }}>
          Upcoming earnings
        </h3>
        <span style={{ fontSize: 11, color: 'var(--textSecondary)' }}>
          {upcoming.length} of {checked} holdings
        </span>
      </div>

      {upcoming.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>
          Nothing scheduled for your holdings.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {upcoming.map(r => {
            const u = urgency(r.daysAway)
            return (
              <div key={r.ticker} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 8px', borderRadius: 5,
                // A severity stripe, so the imminent ones read before the text does.
                boxShadow: u.strong ? `inset 2px 0 0 ${u.tone}` : 'none',
                background: u.strong ? 'var(--surfaceHover)' : 'transparent',
              }}>
                <span style={{ fontWeight: 700, fontSize: 13, minWidth: 52 }}>{r.ticker}</span>
                <span style={{ fontSize: 12, color: 'var(--textSecondary)', flex: 1 }}>
                  {fmtDate(r.earningsDate)}
                </span>
                {r.hasOptions && (
                  <span
                    title="You have open options on this name. Implied vol collapses after a print, and both the extended-hours estimate and the theta projection hold vol constant — treat them with suspicion through earnings."
                    style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '1px 5px',
                      borderRadius: 3, border: '1px solid var(--border)', color: 'var(--textSecondary)',
                    }}
                  >OPT</span>
                )}
                {r.shares > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--textSecondary)', fontVariantNumeric: 'tabular-nums' }}>
                    {r.shares.toLocaleString()} sh
                  </span>
                )}
                <span style={{
                  fontSize: 11.5, fontWeight: u.strong ? 700 : 500, color: u.tone,
                  minWidth: 62, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                }}>{u.label}</span>
              </div>
            )
          })}
        </div>
      )}

      {noDate.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--textSecondary)', marginTop: 9, lineHeight: 1.45 }}>
          No date published for {noDate.slice(0, 8).join(', ')}
          {noDate.length > 8 ? ` +${noDate.length - 8} more` : ''} — usually means they've just
          reported, not that the lookup failed.
        </div>
      )}
    </div>
  )
}
