import { useState, useEffect } from 'react'
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'

const RSI_OVERSOLD = 30
const RSI_OVERBOUGHT = 70

function rsiColor(rsi) {
  if (rsi == null) return '#888'
  if (rsi <= RSI_OVERSOLD) return '#22c55e'
  if (rsi >= RSI_OVERBOUGHT) return '#ef4444'
  return '#94a3b8'
}

function rsiLabel(rsi) {
  if (rsi == null) return ''
  if (rsi <= RSI_OVERSOLD) return 'Oversold'
  if (rsi >= RSI_OVERBOUGHT) return 'Overbought'
  if (rsi >= 50) return 'Bullish'
  return 'Bearish'
}

function stochColor(k) {
  if (k == null) return '#888'
  if (k >= 80) return '#ef4444'   // overbought → consider puts
  if (k <= 20) return '#22c55e'   // oversold
  return '#94a3b8'
}

function stochLabel(k, d) {
  if (k == null) return ''
  const state = k >= 80 ? 'Overbought' : k <= 20 ? 'Oversold' : 'Neutral'
  const cross = d != null
    ? (k > d ? ' ↑ bullish cross' : k < d ? ' ↓ bearish cross' : '')
    : ''
  return `${state}${cross}`
}

export function RSIBadge({ symbol, isDark, onClick }) {
  const [indicators, setIndicators] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!symbol) return
    setLoading(true)
    fetch(`/api/stock-indicators/${symbol}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setIndicators(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [symbol])

  const rsi = indicators?.rsi
  const stoch = indicators?.stoch
  const rColor = rsiColor(rsi)
  const sColor = stochColor(stoch?.k)

  const title = [
    `RSI ${rsi ?? '?'} · ${rsiLabel(rsi)}`,
    stoch ? `Stoch K:${stoch.k} D:${stoch.d} · ${stochLabel(stoch.k, stoch.d)}` : '',
    'Click for intraday chart'
  ].filter(Boolean).join(' | ')

  return (
    <span
      onClick={e => { e.stopPropagation(); onClick && onClick(symbol) }}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        fontSize: '10px', cursor: 'pointer',
        background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
        borderRadius: '4px', padding: '1px 6px', marginLeft: '4px',
        border: `1px solid ${rColor}33`, userSelect: 'none'
      }}
    >
      {loading ? <span style={{ color: '#888' }}>…</span> : <>
        <span style={{ color: rColor }}>RSI {rsi ?? '?'}</span>
        {stoch?.k != null && <>
          <span style={{ color: '#555', fontSize: '9px' }}>|</span>
          <span style={{ color: sColor }}>K{stoch.k}</span>
          {stoch.d != null && <span style={{ color: sColor, opacity: 0.7, fontSize: '9px' }}>/D{stoch.d}</span>}
        </>}
      </>}
    </span>
  )
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '8px 10px', fontSize: '11px', color: '#e2e8f0' }}>
      <div style={{ marginBottom: '4px', color: '#94a3b8' }}>{label}</div>
      {d?.close != null && <div>Price: <b>${d.close.toFixed(2)}</b></div>}
      {d?.vwap != null && <div style={{ color: '#f59e0b' }}>VWAP: <b>${d.vwap.toFixed(2)}</b></div>}
      {d?.volume != null && <div style={{ color: '#94a3b8' }}>Vol: {(d.volume / 1000).toFixed(0)}K</div>}
    </div>
  )
}

export default function IntradayChart({ symbol, onClose, isDark }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!symbol) return
    setLoading(true)
    setError(null)
    fetch(`/api/stock-indicators/${symbol}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) setData(d)
        else setError(d.error)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [symbol])

  const bg = isDark ? '#0f172a' : '#ffffff'
  const surface = isDark ? '#1e293b' : '#f8fafc'
  const border = isDark ? '#334155' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1e293b'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const green = '#22c55e'
  const red = '#ef4444'
  const amber = '#f59e0b'

  const rsi = data?.rsi
  const rsiCol = rsiColor(rsi)

  // Thin the x-axis labels — show every 60 min
  const intraday = data?.intraday || []
  const tickIndices = new Set()
  intraday.forEach((b, i) => {
    const min = new Date(b.time).getMinutes()
    if (min === 0 || min === 30) tickIndices.add(i)
  })

  // Price domain with 0.5% padding
  const closes = intraday.map(b => b.close).filter(Boolean)
  const vwaps = intraday.map(b => b.vwap).filter(Boolean)
  const allPrices = [...closes, ...vwaps]
  const minP = allPrices.length ? Math.min(...allPrices) * 0.998 : 'auto'
  const maxP = allPrices.length ? Math.max(...allPrices) * 1.002 : 'auto'

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '16px'
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: bg, border: `1px solid ${border}`, borderRadius: '12px',
          width: '100%', maxWidth: '760px', maxHeight: '90vh',
          overflow: 'auto', padding: '20px'
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <span style={{ fontWeight: '800', fontSize: '18px', color: text }}>{symbol}</span>
            {data?.currentPrice && (
              <span style={{ fontSize: '14px', color: textMid, marginLeft: '10px' }}>${data.currentPrice.toFixed(2)}</span>
            )}
            {rsi != null && (
              <span style={{
                marginLeft: '10px', fontSize: '12px', fontWeight: '700',
                color: rsiCol, background: `${rsiCol}22`, borderRadius: '4px', padding: '2px 7px'
              }}>
                RSI {rsi} · {rsiLabel(rsi)}
              </span>
            )}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: textMid, fontSize: '20px', padding: '0 4px', lineHeight: 1
          }}>✕</button>
        </div>

        {/* Stats row */}
        {data && (
          <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
            {data.dayHigh != null && <div style={{ color: textMid }}>Day High: <b style={{ color: green }}>${data.dayHigh.toFixed(2)}</b></div>}
            {data.dayLow != null && <div style={{ color: textMid }}>Day Low: <b style={{ color: red }}>${data.dayLow.toFixed(2)}</b></div>}
            {data.currentVwap != null && <div style={{ color: textMid }}>VWAP: <b style={{ color: amber }}>${data.currentVwap.toFixed(2)}</b></div>}
            {data.ema9 != null && <div style={{ color: textMid }}>EMA9: <b style={{ color: '#818cf8' }}>${data.ema9.toFixed(2)}</b></div>}
            {data.ema21 != null && <div style={{ color: textMid }}>EMA21: <b style={{ color: '#c084fc' }}>${data.ema21.toFixed(2)}</b></div>}
          </div>
        )}

        {loading && <div style={{ textAlign: 'center', padding: '40px', color: textMid }}>Loading…</div>}
        {error && <div style={{ color: red, padding: '20px' }}>Error: {error}</div>}

        {!loading && !error && intraday.length > 0 && (
          <>
            {/* Price + VWAP chart */}
            <div style={{ fontSize: '11px', color: textMid, marginBottom: '4px' }}>Today — 5 min bars</div>
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={intraday} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1e293b' : '#f1f5f9'} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: textMid }}
                  tickLine={false}
                  interval="preserveStartEnd"
                  tickFormatter={(v, i) => tickIndices.has(i) ? v : ''}
                />
                <YAxis
                  domain={[minP, maxP]}
                  tick={{ fontSize: 10, fill: textMid }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `$${v.toFixed(0)}`}
                  width={48}
                />
                <Tooltip content={<CustomTooltip />} />
                {/* VWAP as dashed amber line */}
                <Line type="monotone" dataKey="vwap" stroke={amber} strokeWidth={1.5} dot={false} strokeDasharray="4 2" name="VWAP" isAnimationActive={false} />
                {/* Price as solid blue line */}
                <Line type="monotone" dataKey="close" stroke="#60a5fa" strokeWidth={2} dot={false} name="Price" isAnimationActive={false} />
                {/* EMA9/21 as reference lines if available */}
                {data.ema9 && <ReferenceLine y={data.ema9} stroke="#818cf8" strokeDasharray="3 3" strokeWidth={1} label={{ value: `EMA9`, position: 'right', fontSize: 9, fill: '#818cf8' }} />}
                {data.ema21 && <ReferenceLine y={data.ema21} stroke="#c084fc" strokeDasharray="3 3" strokeWidth={1} label={{ value: `EMA21`, position: 'right', fontSize: 9, fill: '#c084fc' }} />}
              </ComposedChart>
            </ResponsiveContainer>

            {/* RSI chart */}
            {rsi != null && (
              <>
                <div style={{ fontSize: '11px', color: textMid, marginTop: '12px', marginBottom: '4px' }}>
                  RSI (14-day) = <span style={{ color: rsiCol, fontWeight: '700' }}>{rsi}</span>
                  <span style={{ marginLeft: '8px', color: rsiCol }}>{rsiLabel(rsi)}</span>
                </div>
                {/* Simple RSI gauge bar */}
                <div style={{ position: 'relative', height: '20px', background: isDark ? '#1e293b' : '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{
                    position: 'absolute', left: '30%', right: '30%', top: 0, bottom: 0,
                    background: isDark ? '#334155' : '#e2e8f0'
                  }} />
                  <div style={{
                    position: 'absolute', left: 0, top: '25%', bottom: '25%', width: '1px',
                    background: red, opacity: 0.5
                  }} />
                  <div style={{
                    position: 'absolute', right: 0, top: '25%', bottom: '25%', width: '1px',
                    background: green, opacity: 0.5
                  }} />
                  <div style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: `${Math.min(Math.max(rsi, 0), 100)}%`,
                    transform: 'translateX(-50%)',
                    width: '3px', background: rsiCol, borderRadius: '2px'
                  }} />
                  {/* Labels */}
                  <span style={{ position: 'absolute', left: '4px', top: '50%', transform: 'translateY(-50%)', fontSize: '9px', color: red, opacity: 0.7 }}>30</span>
                  <span style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', fontSize: '9px', color: green, opacity: 0.7 }}>70</span>
                </div>
              </>
            )}
          </>
        )}

        {!loading && !error && intraday.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px', color: textMid }}>
            No intraday data available (market may be closed)
          </div>
        )}

        <div style={{ marginTop: '12px', fontSize: '10px', color: textMid, textAlign: 'right' }}>
          Click outside to close · Data via Yahoo Finance
        </div>
      </div>
    </div>
  )
}
