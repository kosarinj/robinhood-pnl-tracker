import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

/**
 * One long call per 100 shares, for the week that matters.
 *
 * The window follows the trading week rather than a rolling seven days: Monday
 * to Thursday it asks about THIS week's expiry, and from Friday onward about
 * NEXT week's — once Friday arrives the current week's protection is expiring
 * that afternoon, so the useful question is already about the week ahead.
 *
 * Shares are floored: 250 shares needs 2 contracts, since a third would cover
 * stock that isn't there.
 */
export default function CallCoveragePanel({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [shortOnly, setShortOnly] = useState(false)

  useEffect(() => {
    const qs = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/call-coverage${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d) })
      .catch(e => setError(e.message))
  }, [broker])

  const card = {
    background: isDark ? '#1e293b' : '#fff',
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    borderRadius: 8, padding: 16, marginBottom: 16,
  }
  const th = {
    textAlign: 'right', padding: '6px 8px', fontSize: 11, fontWeight: 500,
    textTransform: 'uppercase', letterSpacing: '0.04em',
    color: isDark ? '#ffffff' : '#0f172a',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, whiteSpace: 'nowrap',
  }
  const td = {
    padding: '6px 8px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums', color: isDark ? '#e2e8f0' : '#0f172a',
  }
  const muted = isDark ? '#94a3b8' : '#64748b'

  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn't load coverage: {error}</div>
  if (!data) return <div style={card}>Loading coverage…</div>

  const { window: w, totals } = data
  const rows = shortOnly ? data.rows.filter(r => r.shortfall > 0) : data.rows
  const allCovered = totals.uncovered === 0

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: isDark ? '#ffffff' : '#0f172a' }}>Call Coverage</h3>
        <span style={{ fontSize: 12, color: muted }}>
          {w.label} · {fmtDate(w.weekStart)}–{fmtDate(w.weekEnd)} · one call per 100 shares
        </span>
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: muted, cursor: 'pointer' }}>
          <input type="checkbox" checked={shortOnly} onChange={e => setShortOnly(e.target.checked)} />
          Only show gaps
        </label>
      </div>

      {/* The headline is the gap, not the total: a number you can act on beats a
          number you have to interpret. */}
      <div style={{
        padding: '12px 14px', borderRadius: 6, marginBottom: 14,
        background: allCovered ? (isDark ? '#052e16' : '#f0fdf4') : (isDark ? '#450a0a' : '#fef2f2'),
        border: `1px solid ${allCovered ? '#22c55e' : '#ef4444'}`,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: allCovered ? '#22c55e' : '#ef4444' }}>
          {allCovered
            ? `Covered — all ${totals.needed} contracts in place`
            : `${totals.uncovered} contract${totals.uncovered === 1 ? '' : 's'} short across ${totals.tickersShort} ticker${totals.tickersShort === 1 ? '' : 's'}`}
        </div>
        <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>
          {totals.covered} of {totals.needed} needed, across {totals.positions} share positions of 100+
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
              <th style={th}>Shares</th>
              <th style={th} title="Shares divided by 100, rounded down.">Needed</th>
              <th style={th} title="Long calls held that expire inside this week.">Held</th>
              <th style={th}>Short by</th>
              <th style={{ ...th, textAlign: 'left' }}>Covering calls</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'left', color: muted }} colSpan={6}>
                {shortOnly ? 'No gaps — every position is covered.' : 'No share positions of 100 or more.'}
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.ticker} style={r.shortfall > 0 ? { background: isDark ? '#1c1917' : '#fffbeb' } : undefined}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{r.ticker}</td>
                <td style={td}>{r.shares}</td>
                <td style={td}>{r.needed}</td>
                <td style={{ ...td, color: r.covered >= r.needed ? '#22c55e' : undefined }}>{r.covered}</td>
                <td style={{ ...td, fontWeight: 700, color: r.shortfall > 0 ? '#ef4444' : muted }}>
                  {r.shortfall > 0 ? r.shortfall : '—'}
                </td>
                <td style={{ ...td, textAlign: 'left', fontSize: 11, color: muted }}>
                  {r.covering.length === 0
                    ? <span style={{ color: '#ef4444' }}>none this week</span>
                    : r.covering.map(c => `${c.contracts}× $${c.strike} ${fmtDate(c.expiry)}`).join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.extraCallsWithoutShares?.length > 0 && (
        <div style={{ fontSize: 11, color: muted, marginTop: 12, lineHeight: 1.5 }}>
          <strong style={{ color: isDark ? '#e2e8f0' : '#334155' }}>Also held this week, without 100+ shares behind them:</strong>{' '}
          {data.extraCallsWithoutShares.map(e => `${e.ticker} (${e.contracts})`).join(', ')}
          {' — '}not a problem, just not coverage.
        </div>
      )}

      <div style={{ fontSize: 11, color: muted, marginTop: 10, lineHeight: 1.5 }}>
        Checked on {fmtDate(w.checkedOn)}. Monday to Thursday this looks at the current week's expiry;
        from Friday it looks at the next one, since by then this week's protection is expiring that
        afternoon. A call expiring any day inside the week counts, not only the Friday.
      </div>
    </div>
  )
}
