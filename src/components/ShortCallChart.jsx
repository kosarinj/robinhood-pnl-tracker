import React, { useState, useEffect } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts'

const fmtUSD = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`
const shortDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${parseInt(m)}/${parseInt(d)}`
}

// Modal: underlying stock price vs the MODELED short-call price since the sale
// date. The call line is a Black–Scholes reconstruction (no historical option
// quotes on the data plan) — clearly labeled as an estimate.
export default function ShortCallChart({ entry, onClose, isDark }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetch(`/api/short-calls/${entry.id}/history`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.success) setData(j); else setError(j.error || 'Failed to load') })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [entry.id])

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const grid = isDark ? '#2d3748' : '#eef2f7'
  const STOCK = '#3b82f6'
  const CALL = '#f59e0b'

  const series = data?.series || []
  const showCall = data?.optionModeled && series.some((p) => p.callPrice != null)

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null
    const row = payload[0]?.payload || {}
    return (
      <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: '8px', padding: '8px 12px', fontSize: '12px', color: text }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }}>{label}</div>
        <div style={{ color: STOCK }}>Stock: {fmtUSD(row.stock)}</div>
        {row.callPrice != null && <div style={{ color: CALL }}>Call (est): {fmtUSD(row.callPrice)}</div>}
      </div>
    )
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: surface, borderRadius: '12px', padding: '22px', width: '92%', maxWidth: '960px', maxHeight: '90vh', overflow: 'auto', border: `1px solid ${border}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '4px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '20px', color: text }}>
              {entry.ticker} ${entry.strike} Call — Option vs Stock
            </h2>
            <div style={{ fontSize: '12px', color: textMid, marginTop: '2px' }}>
              Since sold {shortDate(data?.saleDate || '')} · expires {shortDate(data?.expiry || '')}
              {data?.sigma != null && <> · anchored IV {(data.sigma * 100).toFixed(0)}%</>}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', width: '30px', height: '30px', fontSize: '16px', cursor: 'pointer', flexShrink: 0 }}
          >×</button>
        </div>

        {loading && <div style={{ padding: '60px', textAlign: 'center', color: textMid }}>Loading chart…</div>}
        {error && <div style={{ padding: '30px', textAlign: 'center', color: '#ef4444' }}>{error}</div>}

        {!loading && !error && series.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: textMid, fontSize: '13px' }}>
            No price history available for this contract.
          </div>
        )}

        {!loading && !error && series.length > 0 && (
          <>
            <div style={{ width: '100%', height: '420px', marginTop: '12px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke={grid} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: textMid }} minTickGap={28} />
                  <YAxis
                    yAxisId="stock"
                    tick={{ fontSize: 11, fill: STOCK }}
                    tickFormatter={(v) => `$${v}`}
                    domain={['auto', 'auto']}
                    width={56}
                  />
                  {showCall && (
                    <YAxis
                      yAxisId="call"
                      orientation="right"
                      tick={{ fontSize: 11, fill: CALL }}
                      tickFormatter={(v) => `$${v}`}
                      domain={['auto', 'auto']}
                      width={52}
                    />
                  )}
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />

                  {/* Strike (on the stock axis) */}
                  <ReferenceLine yAxisId="stock" y={data.strike} stroke={textMid} strokeDasharray="5 4"
                    label={{ value: `strike $${data.strike}`, position: 'insideTopRight', fill: textMid, fontSize: 10 }} />

                  {/* Premium you sold for (on the call axis) — call above it = losing */}
                  {showCall && data.premiumPerShare > 0 && (
                    <ReferenceLine yAxisId="call" y={data.premiumPerShare} stroke={CALL} strokeDasharray="5 4"
                      label={{ value: `sold $${data.premiumPerShare}`, position: 'insideBottomRight', fill: CALL, fontSize: 10 }} />
                  )}

                  <Line yAxisId="stock" type="monotone" dataKey="stock" name="Stock price" stroke={STOCK} strokeWidth={2} dot={false} />
                  {showCall && (
                    <Line yAxisId="call" type="monotone" dataKey="callPrice" name="Call price (est)" stroke={CALL} strokeWidth={2} dot={false} strokeDasharray="4 2" />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div style={{ fontSize: '11px', color: textMid, marginTop: '10px', lineHeight: 1.5 }}>
              {showCall ? (
                <>📈 <strong style={{ color: STOCK }}>Blue</strong> = underlying stock (left axis). <strong style={{ color: CALL }}>Amber dashed</strong> = modeled call price (right axis).
                The call line is a <strong>Black–Scholes estimate</strong> — implied vol is fixed at what you sold for, then repriced against each day's stock close (the data plan has no historical option quotes). When the amber line is <em>below</em> the "sold" marker, the position is winning on the option.</>
              ) : (
                <>Showing the underlying stock only. To model the call price line, set this entry's <strong>Stock @ Sale</strong> (underlying close on the sale date) in the tracker so the option's implied vol can be anchored.</>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
