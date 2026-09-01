import React, { useState, useEffect, useRef } from 'react'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Deep-in-the-money open option legs, as a single pill on the Positions page.
 *
 * With enough contracts open, the ones worth acting on stop being findable by
 * eye — a roll candidate is a leg that has gone far enough ITM that its
 * extrinsic value is mostly gone, and spotting that means comparing every
 * strike to its underlying by hand.
 *
 * So: a count, and nothing else, until it's clicked. It renders nothing at all
 * when no leg qualifies, which is most days, and takes one line when it does.
 *
 * Depth is measured against the strike, not against P&L — a short call $12 ITM
 * is a roll candidate whether or not the overall position is green.
 */
const DEFAULT_THRESHOLD = 10

export default function DeepItmAlert({ broker }) {
  const { isDark } = useTheme()
  const [rows, setRows] = useState([])
  const [open, setOpen] = useState(false)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const boxRef = useRef(null)

  const text = isDark ? '#e2e8f0' : '#1e293b'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const surface = isDark ? '#0f172a' : '#ffffff'
  const border = isDark ? '#334155' : '#e2e8f0'
  const WARN = '#d97706'

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const qs = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
        const res = await fetch(`/api/options-pnl/open-positions${qs}`, { credentials: 'include' })
        const json = await res.json()
        if (cancelled || !json.success) return
        setRows(json.positions || [])
      } catch { /* a missing alert must not break the page under it */ }
    }
    load()
    // Cheap enough to follow the underlying: the whole point is catching a leg
    // that went ITM while you were looking elsewhere.
    const t = setInterval(load, 120000)
    return () => { cancelled = true; clearInterval(t) }
  }, [broker])

  // Close on an outside click, so the popover behaves like a menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const deep = rows
    .map(p => {
      const px = p.stockPrice
      if (!(px > 0) || !(p.strike > 0)) return null
      const depth = p.optionType === 'call' ? px - p.strike : p.strike - px
      return depth >= threshold ? { ...p, depth } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.depth - a.depth)

  if (deep.length === 0) return null

  const fmt = (n) => `$${Math.abs(n).toFixed(2)}`
  const shortExp = (e) => { const [, m, d] = (e || '').split('-'); return m ? `${parseInt(m)}/${parseInt(d)}` : '' }

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'inline-block', marginBottom: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Open option legs far enough in the money to be worth rolling"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
          border: `1px solid ${WARN}`, background: isDark ? '#3b2a08' : '#fffbeb',
          color: WARN, fontSize: 12, fontWeight: 700,
        }}
      >
        {deep.length} leg{deep.length === 1 ? '' : 's'} over ${threshold} ITM
        <span style={{ fontWeight: 400, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
          background: surface, border: `1px solid ${border}`, borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 8, minWidth: 340,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: textMid }}>at least</span>
            {[5, 10, 20].map(v => (
              <button key={v} onClick={() => setThreshold(v)}
                style={{
                  padding: '2px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${threshold === v ? WARN : border}`,
                  background: threshold === v ? WARN : 'transparent',
                  color: threshold === v ? '#fff' : textMid, fontWeight: 600,
                }}>${v}</button>
            ))}
            <span style={{ fontSize: 11, color: textMid }}>in the money</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: textMid, fontSize: 10, textAlign: 'left' }}>
                <th style={{ padding: '2px 6px' }}>Contract</th>
                <th style={{ padding: '2px 6px' }}>Side</th>
                <th style={{ padding: '2px 6px', textAlign: 'right' }}>ITM by</th>
                <th style={{ padding: '2px 6px', textAlign: 'right' }}>Exp</th>
              </tr>
            </thead>
            <tbody>
              {deep.map(p => (
                <tr key={p.symbol} style={{ borderTop: `1px solid ${border}`, color: text }}>
                  <td style={{ padding: '3px 6px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {p.ticker} {p.strike}{p.optionType === 'call' ? 'C' : 'P'}
                    <span style={{ color: textMid, fontWeight: 400 }}> ×{Math.abs(p.openContracts)}</span>
                  </td>
                  <td style={{ padding: '3px 6px', color: p.isLong ? '#0ca30c' : WARN, fontWeight: 600 }}>
                    {p.isLong ? 'Long' : 'Short'}
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', fontWeight: 700 }}>
                    {fmt(p.depth)}
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: textMid, whiteSpace: 'nowrap' }}>
                    {shortExp(p.expiry)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: textMid, marginTop: 6 }}>
            Distance from the strike to the underlying. Calls count up, puts count down.
          </div>
        </div>
      )}
    </div>
  )
}
