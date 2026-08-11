import React, { useState, useEffect, useMemo } from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell, LabelList,
} from 'recharts'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Dashboard charts: where the P&L has gone, and who moved it.
 *
 * Both read /api/options-pnl/history, which is already broker-scoped, so they
 * follow the broker tab like everything else.
 *
 * Colour note: the green/red pair measures ΔE 7.8 (light) / 6.1 (dark) under
 * deuteranopia — inside the 6–8 floor band, which is only legal with a second
 * encoding. That's why every bar carries a signed value label: the sign, not the
 * hue, is what says gain or loss. Chart marks also use their own tokens rather
 * than the text positive/negative, which sit too light for fills on dark.
 */

const money = (n) => {
  const v = Number(n) || 0
  const abs = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
  return `${v < 0 ? '−' : ''}$${abs}`
}
const moneySigned = (n) => `${(Number(n) || 0) >= 0 ? '+' : '−'}$${Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const shortDate = (iso) => {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${parseInt(m)}/${parseInt(d)}`
}

export default function DashboardCharts({ broker = 'all' }) {
  const { tokens } = useTheme()
  const [weeks, setWeeks] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/options-pnl/history${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d?.success) throw new Error(d?.error || 'Failed to load')
        setWeeks(Array.isArray(d.weeks) ? d.weeks : [])
        setError('')
      })
      .catch(e => { setError(e.message); setWeeks([]) })
  }, [broker])

  // Running total, oldest week first — the shape of the account over time.
  const curve = useMemo(() => {
    if (!weeks?.length) return []
    const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    let run = 0
    return sorted.map(w => {
      run += Number(w.totalDelta) || 0
      return { week: w.weekStart, label: shortDate(w.weekStart), cumulative: Math.round(run * 100) / 100, delta: Number(w.totalDelta) || 0 }
    })
  }, [weeks])

  // Biggest movers, by absolute size — the tail of tiny names says nothing.
  const byTicker = useMemo(() => {
    if (!weeks?.length) return []
    const totals = {}
    weeks.forEach(w => {
      Object.entries(w.byUnderlying || {}).forEach(([t, v]) => {
        totals[t] = (totals[t] || 0) + (Number(v) || 0)
      })
    })
    return Object.entries(totals)
      .map(([ticker, pnl]) => ({ ticker, pnl: Math.round(pnl * 100) / 100 }))
      .filter(r => Math.abs(r.pnl) >= 1)
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .slice(0, 8)
      .sort((a, b) => b.pnl - a.pnl)
  }, [weeks])

  if (weeks === null) return null
  if (error) return null
  if (!curve.length) return null

  const last = curve[curve.length - 1]?.cumulative ?? 0
  const up = last >= 0
  const curveColor = up ? tokens.chartPositive : tokens.chartNegative

  const card = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '16px 16px 10px', color: 'var(--text)',
  }
  const title = { margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }
  const sub = { fontSize: 11, color: 'var(--textSecondary)', textTransform: 'uppercase', letterSpacing: '0.11em' }

  const tooltipStyle = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, fontSize: 12, color: 'var(--text)', padding: '6px 10px',
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginBottom: 20 }}>

      {/* ── Cumulative P&L ── single series, so no legend: the title names it ── */}
      <div className="floating-panel" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <h3 style={title}>Cumulative P&amp;L</h3>
          <span style={{ fontSize: 18, fontWeight: 700, color: curveColor, fontVariantNumeric: 'tabular-nums' }}>
            {moneySigned(last)}
          </span>
        </div>
        <div style={sub}>{curve.length} week{curve.length !== 1 ? 's' : ''}</div>
        <ResponsiveContainer width="100%" height={190}>
          <AreaChart data={curve} margin={{ top: 14, right: 8, bottom: 0, left: -12 }}>
            <defs>
              <linearGradient id="pnlfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={curveColor} stopOpacity={0.22} />
                <stop offset="100%" stopColor={curveColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={tokens.chartGrid} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: tokens.chartText }}
                   axisLine={false} tickLine={false} minTickGap={22} />
            <YAxis tick={{ fontSize: 10, fill: tokens.chartText }} axisLine={false} tickLine={false}
                   width={54} tickFormatter={money} />
            <ReferenceLine y={0} stroke={tokens.border} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: 'var(--textSecondary)', fontSize: 11 }}
              cursor={{ stroke: tokens.textSecondary, strokeDasharray: '3 3' }}
              formatter={(v, _n, p) => [
                `${moneySigned(v)}  (week ${moneySigned(p?.payload?.delta)})`, 'Cumulative',
              ]}
              labelFormatter={(l, p) => `Week of ${p?.[0]?.payload?.week || l}`}
            />
            <Area type="monotone" dataKey="cumulative" stroke={curveColor} strokeWidth={2}
                  fill="url(#pnlfill)"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* ── By underlying ── signed labels carry gain/loss, not the hue alone ── */}
      <div className="floating-panel" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <h3 style={title}>Biggest movers</h3>
          <span style={{ fontSize: 11, color: 'var(--textSecondary)' }}>
            {byTicker.length} of {new Set(weeks.flatMap(w => Object.keys(w.byUnderlying || {}))).size}
          </span>
        </div>
        <div style={sub}>P&amp;L by underlying</div>
        {byTicker.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--textSecondary)', fontSize: 12 }}>
            No option activity in this period.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={byTicker} layout="vertical" margin={{ top: 12, right: 54, bottom: 0, left: 4 }}>
              <CartesianGrid stroke={tokens.chartGrid} strokeDasharray="2 4" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: tokens.chartText }}
                     axisLine={false} tickLine={false} tickFormatter={money} />
              <YAxis type="category" dataKey="ticker" width={52}
                     tick={{ fontSize: 11, fill: tokens.text, fontWeight: 600 }}
                     axisLine={false} tickLine={false} />
              <ReferenceLine x={0} stroke={tokens.border} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: 'var(--textSecondary)', fontSize: 11 }}
                cursor={{ fill: tokens.surfaceHover }}
                formatter={(v) => [moneySigned(v), 'P&L']}
              />
              <Bar dataKey="pnl" radius={[0, 4, 4, 0]} barSize={13} isAnimationActive={false}>
                {byTicker.map(r => (
                  <Cell key={r.ticker} fill={r.pnl >= 0 ? tokens.chartPositive : tokens.chartNegative} />
                ))}
                {/* The secondary encoding the colour pair requires. */}
                <LabelList dataKey="pnl" position="right" formatter={moneySigned}
                           style={{ fontSize: 10, fill: tokens.textSecondary, fontVariantNumeric: 'tabular-nums' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
