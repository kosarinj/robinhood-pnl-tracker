import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { pairSpreads } from '../utils/pairSpreads'

const fmt = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return n < 0 ? `-$${abs}` : `$${abs}`
}
const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}
const r2 = n => Math.round(n * 100) / 100
const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = String(s).split('-')
  return `${Number(m)}/${Number(d)}`
}
const daysTo = (s) => {
  if (!s) return null
  const t = new Date(`${s}T16:00:00Z`).getTime() - Date.now()
  return Math.ceil(t / 86400000)
}

/**
 * Open verticals, valued as one position each.
 *
 * A spread only existed here after it closed: while it was open its two legs
 * sat apart in Open P&L, so the thing you actually put on — a credit, a width,
 * a defined worst case — had no row anywhere. Knowing a short 78 put is worth
 * -$267 tells you very little; knowing the 77/78 took $57.90 in, costs $93 to
 * get out of, and cannot lose more than $42.10 tells you the trade.
 *
 * Pairing is done here rather than on the server because the open-positions
 * endpoint already carries everything needed: both legs, their marks, their
 * cost and the underlying. Nothing on the server changes, so no figure
 * anywhere else can move.
 */
export default function SpreadsPanel({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [positions, setPositions] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSingles, setShowSingles] = useState(false)

  useEffect(() => {
    setLoading(true); setError(null)
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/options-pnl/open-positions${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d?.success) throw new Error(d?.error || 'Could not load open positions')
        setPositions(d.positions || [])
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [broker])

  const { spreads, singles } = useMemo(() => pairSpreads(positions), [positions])

  const totals = useMemo(() => spreads.reduce((t, s) => ({
    credit: r2(t.credit + s.credit),
    nowCost: r2(t.nowCost + s.nowCost),
    pnl: r2(t.pnl + s.pnl),
    maxLoss: r2(t.maxLoss + s.maxLoss),
    unpriced: t.unpriced + (s.priced ? 0 : 1),
  }), { credit: 0, nowCost: 0, pnl: 0, maxLoss: 0, unpriced: 0 }), [spreads])

  const text = isDark ? '#f1f5f9' : '#0f172a'
  const muted = isDark ? '#94a3b8' : '#64748b'
  const border = isDark ? '#334155' : '#e2e8f0'
  const card = {
    background: isDark ? '#1e2130' : '#ffffff', border: `1px solid ${border}`,
    borderRadius: 10, padding: '14px 16px', marginBottom: 16,
  }
  // Sentence case, not the small-caps used elsewhere: at this size the
  // uppercase + letterspacing was what made these unreadable — capitals strip
  // out the ascenders and descenders the eye uses to tell short words apart.
  //
  // Full text colour rather than the muted grey the other panels use for
  // headers. Dropping to 12px/weight-500 alone changed almost nothing, because
  // the size was never the real problem: grey-on-card is low contrast, and in
  // dark mode "lighter" is what more contrast looks like.
  const th = {
    textAlign: 'right', padding: '7px 8px', fontSize: 13, color: text, whiteSpace: 'nowrap',
    fontWeight: 600, borderBottom: `2px solid ${border}`,
  }
  const td = { textAlign: 'right', padding: '6px 8px', fontSize: 13, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }

  if (loading) return <div style={card}>Loading open spreads…</div>
  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn’t load spreads: {error}</div>

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: text }}>Open spreads</h3>
        <span style={{ fontSize: 12, color: muted }}>
          {spreads.length} vertical{spreads.length === 1 ? '' : 's'}
          {broker !== 'all' ? ` · ${broker}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12, color: muted }}>
            Open P&L{' '}
            <strong style={{ fontSize: 15, color: pnlColor(totals.pnl, isDark) }}>{fmt(totals.pnl)}</strong>
          </span>
          <span style={{ fontSize: 12, color: muted }}
                title="If every one of these went fully against you. The most these positions can lose, by construction — that is what a defined-risk trade buys you.">
            Worst case{' '}
            <strong style={{ fontSize: 15, color: '#ef4444' }}>{fmt(-totals.maxLoss)}</strong>
          </span>
        </span>
      </div>

      {spreads.length === 0 ? (
        <div style={{ fontSize: 13, color: muted }}>
          No open verticals — a spread here means a short and a long of the same underlying,
          expiry and type held at once.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Spread</th>
                <th style={{ ...th, textAlign: 'left' }}>Expires</th>
                <th style={th}>Qty</th>
                <th style={th} title="What you took in to open it, or paid if this is a debit spread.">Credit</th>
                <th style={th} title="What it would cost to close both legs at today's marks.">To close</th>
                <th style={th}>Open P&L</th>
                <th style={th} title="The most this can still make, and the most it can still lose. Fixed by the width of the strikes.">Max win / loss</th>
                <th style={{ ...th, textAlign: 'left' }}>Stock</th>
              </tr>
            </thead>
            <tbody>
              {spreads.map((s, i) => {
                const dte = daysTo(s.expiry)
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${border}` }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600, color: text }}>
                      {s.ticker}{' '}
                      <span style={{ color: muted, fontWeight: 400 }}>
                        {s.type === 'put' ? 'Put' : 'Call'} {s.lo}/{s.hi}
                      </span>
                      {!s.priced && <span style={{ color: '#f59e0b', fontSize: 10 }}> unpriced</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'left', color: muted }}>
                      {fmtDate(s.expiry)}
                      {dte != null && <span style={{ fontSize: 11 }}> · {dte <= 0 ? 'today' : `${dte}d`}</span>}
                    </td>
                    <td style={{ ...td, color: muted }}>{s.n}</td>
                    <td style={{ ...td, color: pnlColor(s.credit, isDark) }}>{fmt(s.credit)}</td>
                    <td style={{ ...td, color: text }}>{fmt(s.nowCost)}</td>
                    <td style={{ ...td, fontWeight: 700, color: pnlColor(s.pnl, isDark) }}>{fmt(s.pnl)}</td>
                    <td style={{ ...td, fontSize: 12 }}>
                      <span style={{ color: '#22c55e' }}>{fmt(s.maxProfit)}</span>
                      <span style={{ color: muted }}> / </span>
                      <span style={{ color: '#ef4444' }}>{fmt(-s.maxLoss)}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'left', fontSize: 12, color: muted }}>
                      {s.stock != null ? `$${s.stock.toFixed(2)}` : '—'}
                      {s.breached && (
                        <span style={{ color: '#f59e0b', fontWeight: 700 }}
                              title={`The short ${s.shortStrike} is in the money — this spread is working against you.`}>
                          {' '}· short {s.shortStrike} ITM
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
              <tr>
                <td colSpan={3} style={{ ...td, textAlign: 'left', color: muted, fontWeight: 600 }}>Total</td>
                <td style={{ ...td, fontWeight: 700, color: pnlColor(totals.credit, isDark) }}>{fmt(totals.credit)}</td>
                <td style={{ ...td, fontWeight: 700, color: text }}>{fmt(totals.nowCost)}</td>
                <td style={{ ...td, fontWeight: 800, color: pnlColor(totals.pnl, isDark) }}>{fmt(totals.pnl)}</td>
                <td style={{ ...td, fontWeight: 700, color: '#ef4444' }}>{fmt(-totals.maxLoss)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {singles.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
          <button onClick={() => setShowSingles(v => !v)}
            style={{ border: 'none', background: 'transparent', color: muted, cursor: 'pointer',
                     fontSize: 12, padding: 0 }}>
            {showSingles ? '▾' : '▸'} {singles.length} leg{singles.length === 1 ? '' : 's'} not in a spread
          </button>
          {showSingles && (
            <div style={{ marginTop: 6, fontSize: 12, color: muted, lineHeight: 1.7 }}>
              {singles.map((p, i) => (
                <div key={i}>
                  {p.ticker} {p.optionType === 'put' ? 'Put' : 'Call'} ${p.strike} · {fmtDate(p.expiry)}
                  {' · '}{p.isLong ? 'long' : 'short'} ×{p.remaining}
                  {!p.isLong && <strong style={{ color: '#f59e0b' }}> · uncovered by a long</strong>}
                  {p.unrealizedPnl != null && (
                    <span style={{ color: pnlColor(p.unrealizedPnl, isDark) }}> · {fmt(p.unrealizedPnl)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, color: muted, marginTop: 12, lineHeight: 1.5 }}>
        Each short is paired with the nearest long of the same underlying, expiry and type — the leg
        that actually caps the risk. Credit is what you took in; <em>to close</em> is what both legs
        would cost at today’s marks, so Open P&amp;L is the difference. Max win and loss are fixed by
        the width between the strikes and cannot change, which is the whole point of trading it as a
        spread rather than a naked short.
        {totals.unpriced > 0 && (
          <span style={{ color: '#f59e0b' }}> {totals.unpriced} spread(s) had a leg with no mark, so their value is incomplete.</span>
        )}
      </div>
    </div>
  )
}
