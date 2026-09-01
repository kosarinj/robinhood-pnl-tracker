import React, { useState, useEffect, useRef } from 'react'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Open option legs sitting on a gain, as a single pill on the Positions page.
 *
 * The question is "what could I sell back into the market right now", so the
 * measure is the contract's own price move — what it's worth now against what
 * was paid — not how far the strike is from the underlying. A leg can be deep
 * ITM and still be a loser to close, and a leg nowhere near the money can be up
 * $10 a share because volatility moved.
 *
 * Sign comes from the endpoint's unrealizedPnl, which already accounts for the
 * side: a long gains when the mark rises, a short when it falls. Per share, so
 * the threshold reads the way the contract is quoted — $10 a share is $1,000 a
 * contract.
 *
 * Renders nothing when nothing qualifies, which is the point: one line of real
 * estate when it matters, none when it doesn't.
 */
const DEFAULT_THRESHOLD = 10

export default function RollCandidatesAlert({ broker }) {
  const { isDark } = useTheme()
  const [rows, setRows] = useState([])
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const boxRef = useRef(null)

  const text = isDark ? '#e2e8f0' : '#1e293b'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const surface = isDark ? '#0f172a' : '#ffffff'
  const border = isDark ? '#334155' : '#e2e8f0'
  const GOOD = '#0ca30c'

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const qs = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
        const res = await fetch(`/api/options-pnl/open-positions${qs}`, { credentials: 'include' })
        const json = await res.json()
        if (cancelled) return
        setLoaded(true)
        // A failure here used to leave the pill absent, which looks identical to
        // "nothing qualifies" — the state that made this impossible to diagnose
        // from the screen. Say so instead.
        if (!json.success) { setErr(json.error || 'request failed'); setRows([]); return }
        setErr('')
        setRows(json.positions || [])
      } catch (e) {
        if (!cancelled) { setLoaded(true); setErr(e.message || 'could not load') }
      }
    }
    load()
    const t = setInterval(load, 120000)
    return () => { cancelled = true; clearInterval(t) }
  }, [broker])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Legs with no usable mark can't be judged either way. They used to vanish,
  // which made "why isn't X showing?" unanswerable from the screen — so they're
  // now listed separately instead of dropped.
  const unpriced = rows.filter(p => {
    const n = Math.abs(p.openContracts || 0)
    return n > 0 && (p.unrealizedPnl == null || !(p.markPrice > 0) && p.markSource !== 'intrinsic')
  })

  const winners = rows
    .map(p => {
      const n = Math.abs(p.openContracts || 0)
      // Intrinsic-marked legs are kept, and this matters most for the best
      // case there is: a short call that has gone worthless has no live quote,
      // falls back to intrinsic 0, and books the whole premium as profit.
      // Excluding it hid exactly the position most worth closing. The mark is
      // still an estimate, so it is labelled rather than dropped.
      if (!n || p.unrealizedPnl == null) return null
      const perShare = p.unrealizedPnl / (100 * n)
      // A hair of tolerance so a leg that reads $10.00 everywhere else isn't
      // held out by floating point.
      return perShare >= threshold - 0.005 ? { ...p, perShare, total: p.unrealizedPnl } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.perShare - a.perShare)

  if (err) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8,
        padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
        border: '1px solid #d03b3b', background: isDark ? '#3a0d0d' : '#fef2f2', color: '#d03b3b',
      }} title={`GET /api/options-pnl/open-positions failed: ${err}`}>
        option check unavailable — {err}
      </div>
    )
  }
  // Loaded, no open legs at all: nothing to say.
  if (loaded && rows.length === 0) return null
  if (winners.length === 0 && unpriced.length === 0) return null

  const usd = (n) => `$${Number(n).toFixed(2)}`
  const whole = (n) => `$${Math.round(n).toLocaleString()}`
  const shortExp = (e) => { const [, m, d] = (e || '').split('-'); return m ? `${parseInt(m)}/${parseInt(d)}` : '' }

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'inline-block', marginBottom: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Open legs worth at least this much more per share than you paid — candidates to close or roll"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
          border: `1px solid ${GOOD}`, background: isDark ? '#08300b' : '#f0fdf4',
          color: GOOD, fontSize: 12, fontWeight: 700,
        }}
      >
        {winners.length} leg{winners.length === 1 ? '' : 's'} up ${threshold}+/sh
        {unpriced.length > 0 && (
          <span style={{ color: '#d97706', fontWeight: 600 }}>· {unpriced.length} unpriced</span>
        )}
        <span style={{ fontWeight: 400, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
          background: surface, border: `1px solid ${border}`, borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 8, minWidth: 420,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: textMid }}>up at least</span>
            {[5, 10, 20].map(v => (
              <button key={v} onClick={() => setThreshold(v)}
                style={{
                  padding: '2px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${threshold === v ? GOOD : border}`,
                  background: threshold === v ? GOOD : 'transparent',
                  color: threshold === v ? '#fff' : textMid, fontWeight: 600,
                }}>${v}</button>
            ))}
            <span style={{ fontSize: 11, color: textMid }}>per share</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: textMid, fontSize: 10, textAlign: 'left' }}>
                <th style={{ padding: '2px 6px' }}>Contract</th>
                <th style={{ padding: '2px 6px' }}>Side</th>
                <th style={{ padding: '2px 6px', textAlign: 'right' }}>Paid → Now</th>
                <th style={{ padding: '2px 6px', textAlign: 'right' }}>+/sh</th>
                <th style={{ padding: '2px 6px', textAlign: 'right' }}>Total</th>
                <th style={{ padding: '2px 6px', textAlign: 'right' }}>Exp</th>
              </tr>
            </thead>
            <tbody>
              {winners.map(p => (
                <tr key={p.symbol} style={{ borderTop: `1px solid ${border}`, color: text }}>
                  <td style={{ padding: '3px 6px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {p.ticker} {p.strike}{p.optionType === 'call' ? 'C' : 'P'}
                    <span style={{ color: textMid, fontWeight: 400 }}> ×{Math.abs(p.openContracts)}</span>
                  </td>
                  <td style={{ padding: '3px 6px', color: p.isLong ? GOOD : '#d97706', fontWeight: 600 }}>
                    {p.isLong ? 'Long' : 'Short'}
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: textMid, whiteSpace: 'nowrap' }}>
                    {usd((p.avgCostPerContract || 0) / 100)} → {usd(p.markPrice)}
                    {p.markSource !== 'quote' && (
                      <span title={p.markSource === 'intrinsic'
                        ? 'No live quote — marked at intrinsic value, so an out-of-the-money short reads as worth ~$0'
                        : 'No live quote — Black-Scholes estimate'}
                        style={{ marginLeft: 4, fontSize: 9, color: '#d97706', fontWeight: 700 }}>est</span>
                    )}
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', fontWeight: 700, color: GOOD }}>
                    {usd(p.perShare)}
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', fontWeight: 700, color: GOOD }}>
                    {whole(p.total)}
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: textMid, whiteSpace: 'nowrap' }}>
                    {shortExp(p.expiry)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unpriced.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${border}` }}>
              <div style={{ fontSize: 10, color: '#d97706', fontWeight: 700, marginBottom: 3 }}>
                No usable price — can't be judged either way
              </div>
              {unpriced.map(p => (
                <div key={p.symbol} style={{ fontSize: 11, color: textMid, padding: '1px 6px' }}>
                  {p.ticker} {p.strike}{p.optionType === 'call' ? 'C' : 'P'} ×{Math.abs(p.openContracts)}
                  {' · '}{p.isLong ? 'Long' : 'Short'}
                  {' · '}no quote{p.stockPrice > 0 ? '' : ', no stock price either'}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: textMid, marginTop: 6 }}>
            Gain on the contract itself, per share — what closing it at the current mark would bank.
            A long gains as the mark rises, a short as it falls.
          </div>
        </div>
      )}
    </div>
  )
}
