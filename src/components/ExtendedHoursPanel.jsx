import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Pre/post market option marks.
 *
 * Robinhood moves the stock leg outside regular hours but leaves option marks
 * frozen at the 4pm close, so a mixed book reads inconsistently in the AM/PM.
 * The server reprices each contract with Black-Scholes on the extended-hours
 * underlying, holding the vol calibrated to that contract's own closing mark.
 *
 * Everything shown here is a model ESTIMATE, not a tradeable quote — the header
 * and the per-row flags say so, because the numbers look precise and aren't.
 */

const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '$0.00'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}
const signed = (n) => `${n >= 0 ? '+' : ''}${fmt(n)}`

const SESSION_LABEL = {
  pre: 'Pre-market',
  post: 'After hours',
  regular: 'Market open',
  closed: 'Market closed',
  unknown: '',
}

export default function ExtendedHoursPanel() {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const r = await fetch('/api/extended-hours', { credentials: 'include' })
      const d = await r.json()
      if (!r.ok || d.success === false) throw new Error(d.error || 'Failed to load')
      setData(d)
      setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // Extended-hours prints are sparse; once a minute is plenty.
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [])

  const positions = data?.positions || []
  const totalChange = useMemo(
    () => positions.reduce((s, p) => s + (p.changePerContract || 0), 0),
    [positions]
  )

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const rowBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
  const green = '#22c55e'
  const red = '#ef4444'
  const amber = '#f59e0b'
  const pnlColor = (n) => (n >= 0 ? green : red)

  const card = {
    background: surface, border: `1px solid ${border}`,
    borderRadius: '12px', padding: '20px', marginBottom: '20px', color: text,
  }

  // Hide entirely during regular hours — the real marks are live then, and a
  // model estimate sitting next to them would just be confusing.
  if (!loading && data?.session === 'regular') return null
  if (loading) return null
  if (error) {
    return (
      <div className="floating-panel" style={card}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Extended-hours options</h2>
        <div style={{ fontSize: '13px', color: red, marginTop: '8px' }}>{error}</div>
      </div>
    )
  }

  if (!positions.length) {
    return (
      <div className="floating-panel" style={card}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Extended-hours options</h2>
        <div style={{ fontSize: '13px', color: textMid, marginTop: '6px' }}>
          {data?.note || 'Nothing to estimate right now.'}
        </div>
      </div>
    )
  }

  const th = {
    textAlign: 'right', padding: '7px 8px', fontSize: '11px', fontWeight: 700,
    color: textMid, textTransform: 'uppercase', letterSpacing: '0.03em',
    borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap',
  }
  const td = { textAlign: 'right', padding: '8px', fontSize: '13px', borderBottom: `1px solid ${rowBorder}`, whiteSpace: 'nowrap' }

  const anyEarnings = positions.some(p => p.earningsTonight)
  const anyStaleIv = positions.some(p => p.staleIv)
  const anyNoTrade = positions.some(p => p.noExtendedTrade)

  return (
    <div className="floating-panel" style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>
            Extended-hours options
            <span style={{
              marginLeft: '8px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em',
              color: amber, border: `1px solid ${amber}`, borderRadius: '4px', padding: '2px 5px',
              verticalAlign: 'middle',
            }}>ESTIMATE</span>
          </h2>
          <div style={{ fontSize: '12px', color: textMid, marginTop: '3px' }}>
            {SESSION_LABEL[data?.session] || ''} · {positions.length} contract{positions.length !== 1 ? 's' : ''} ·
            {' '}modelled from the underlying, not quoted
          </div>
        </div>
        <div style={{
          fontSize: '22px', fontWeight: 800, color: pnlColor(totalChange),
          background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
          borderRadius: '8px', padding: '6px 16px',
        }}>
          {signed(totalChange)}
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Contract</th>
              <th style={th}>Underlying</th>
              <th style={th}>Move</th>
              <th style={th}>Close mark</th>
              <th style={th}>Est. mark</th>
              <th style={th}>Est. change</th>
            </tr>
          </thead>
          <tbody>
            {positions.map(p => (
              <tr key={p.symbol}>
                <td style={{ ...td, textAlign: 'left' }}>
                  <div style={{ fontWeight: 600 }}>{p.symbol}</div>
                  <div style={{ fontSize: '11px', color: textMid, display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <span>IV {(p.sigma * 100).toFixed(1)}%</span>
                    {p.earningsTonight && <span style={{ color: red, fontWeight: 700 }}>earnings tonight</span>}
                    {p.staleIv && <span style={{ color: amber }}>IV from {p.ivDate}</span>}
                    {p.noExtendedTrade && <span style={{ color: amber }}>no extended trade</span>}
                    {p.largeMove && !p.earningsTonight && <span style={{ color: amber }}>large move</span>}
                  </div>
                </td>
                <td style={td}>
                  {fmt(p.underlyingNow)}
                  <div style={{ fontSize: '11px', color: textMid }}>from {fmt(p.underlyingClose)}</div>
                </td>
                <td style={{ ...td, color: pnlColor(p.underlyingMovePct) }}>
                  {p.underlyingMovePct >= 0 ? '+' : ''}{p.underlyingMovePct.toFixed(2)}%
                </td>
                <td style={{ ...td, color: textMid }}>{fmt(p.closeMark)}</td>
                <td style={{ ...td, fontWeight: 600 }}>{fmt(p.estMark)}</td>
                <td style={{ ...td, fontWeight: 700, color: pnlColor(p.changePerContract) }}>
                  {signed(p.changePerContract)}
                  <div style={{ fontSize: '11px', color: textMid, fontWeight: 400 }}>
                    {signed(p.changePerShare)}/sh
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: '11px', color: textMid, marginTop: '12px', lineHeight: 1.5 }}>
        Black-Scholes repriced on the extended-hours underlying, holding each contract's
        closing implied volatility constant. Sign convention is the contract's value —
        for a short position your P&amp;L is the opposite.
        {anyEarnings && (
          <div style={{ color: red, marginTop: '4px' }}>
            Earnings tonight on one or more names: implied vol collapses after the print,
            and this model holds it fixed, so those estimates can be well off.
          </div>
        )}
        {anyStaleIv && !anyEarnings && (
          <div style={{ marginTop: '4px' }}>
            Some vols are from an earlier session — the estimate drifts as they age.
          </div>
        )}
        {anyNoTrade && (
          <div style={{ marginTop: '4px' }}>
            Where no extended-hours trade has printed yet, the underlying falls back to the close.
          </div>
        )}
      </div>
    </div>
  )
}
