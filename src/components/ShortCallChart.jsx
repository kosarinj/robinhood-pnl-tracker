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
  // Validated status steps. Paired with a label wherever they appear, so colour
  // never carries the meaning on its own.
  const GOOD = '#0ca30c'
  const CRIT = '#d03b3b'

  const rawSeries = data?.series || []
  const contracts = Math.abs(entry?.contracts || 1)
  const premiumPerShare = data?.premiumPerShare || 0
  // Dollars kept if bought back at that day's estimated price — the figure the
  // strategy turns on, and the one the old chart made you infer from the gap
  // between two differently-scaled lines.
  const series = rawSeries.map(p => ({
    ...p,
    kept: p.callPrice != null && premiumPerShare > 0
      ? Math.round((premiumPerShare - p.callPrice) * 100 * contracts * 100) / 100
      : null,
  }))
  const showCall = data?.optionModeled && series.some((p) => p.callPrice != null)
  const latestKept = [...series].reverse().find(p => p.kept != null)?.kept ?? 0
  // Everything collected — the most this position can make, reached only if the
  // call expires worthless.
  const maxKept = Math.round(premiumPerShare * 100 * contracts * 100) / 100
  const pctCollected = maxKept > 0 ? Math.round((latestKept / maxKept) * 100) : null

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
            {/* Premium kept — the headline, on its own scale.
                This replaced a dual-axis chart that drew the stock and the call
                price against two different y-scales. With two scales, where the
                lines cross and how their slopes compare are artifacts of the
                scaling rather than facts about the position, so the picture
                couldn't be read literally. Two single-axis charts sharing an
                x-axis say the same thing and can be. */}
            {showCall && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: text }}>Premium kept</span>
                  <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                                 color: latestKept >= 0 ? GOOD : CRIT }}>
                    {latestKept >= 0 ? '+' : '−'}${Math.abs(Math.round(latestKept)).toLocaleString()}
                    {pctCollected != null && (
                      <span style={{ fontSize: 12, fontWeight: 600, color: textMid, marginLeft: 6 }}>
                        {pctCollected}% of ${Math.round(maxKept).toLocaleString()}
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: textMid, marginBottom: 4 }}>
                  What you'd keep buying it back at each day's estimated price. Decay pushes it up
                  toward the ceiling; a rally pulls it down, and below zero it costs more to close
                  than you sold it for.
                </div>
                <div style={{ width: '100%', height: '190px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={series} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: textMid }} minTickGap={28} />
                      <YAxis tick={{ fontSize: 11, fill: textMid }} width={62}
                             tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`} domain={['auto', 'auto']} />
                      <Tooltip content={<KeptTooltip contracts={contracts} />} />
                      {/* The ceiling: what's kept if it expires worthless. The
                          line can only climb toward this, so the remaining gap
                          IS the decay still to be collected — which is the
                          thing worth judging by eye. */}
                      <ReferenceLine y={maxKept} stroke={GOOD} strokeDasharray="6 4"
                        label={{ value: `max $${Math.round(maxKept).toLocaleString()} — expires worthless`,
                                 position: 'insideTopRight', fill: GOOD, fontSize: 10 }} />
                      <ReferenceLine y={0} stroke={textMid} strokeDasharray="4 3"
                        label={{ value: 'break-even — worth what you sold it for', position: 'insideBottomLeft', fill: textMid, fontSize: 10 }} />
                      <Line type="monotone" dataKey="kept" name="Premium kept" stroke={GOOD}
                            strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            {/* Stock, on its own scale, sharing the x-axis above. */}
            <div style={{ fontSize: 12, fontWeight: 700, color: text, marginTop: 16 }}>Stock price</div>
            <div style={{ width: '100%', height: '190px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 6, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: textMid }} minTickGap={28} />
                  <YAxis tick={{ fontSize: 11, fill: textMid }} tickFormatter={(v) => `$${v}`}
                         domain={['auto', 'auto']} width={56} />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={data.strike} stroke={textMid} strokeDasharray="5 4"
                    label={{ value: `strike $${data.strike}`, position: 'insideTopRight', fill: textMid, fontSize: 10 }} />
                  <Line type="monotone" dataKey="stock" name="Stock price" stroke={STOCK}
                        strokeWidth={2} dot={false} isAnimationActive={false} />
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

/**
 * Tooltip for the premium-kept line.
 *
 * Names the figure and its direction in words, so the reading doesn't depend on
 * knowing that up is good — which is the opposite of the intuition for a price
 * chart sitting directly beneath it.
 */
function KeptTooltip({ active, payload, label, contracts }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  if (p.kept == null) return null
  return (
    <div style={{
      background: 'var(--surface, #fff)', border: '1px solid var(--border, #e2e8f0)',
      borderRadius: 6, padding: '8px 10px', fontSize: 12, color: 'var(--text, #1e293b)',
    }}>
      <div style={{ color: 'var(--textSecondary, #64748b)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700 }}>
        {p.kept >= 0 ? 'Keeping ' : 'Down '}${Math.abs(Math.round(p.kept)).toLocaleString()}
      </div>
      <div style={{ color: 'var(--textSecondary, #64748b)', fontSize: 11, marginTop: 2 }}>
        buy back at ${p.callPrice?.toFixed(2)}/sh × {contracts} contract{contracts === 1 ? '' : 's'}
      </div>
    </div>
  )
}
