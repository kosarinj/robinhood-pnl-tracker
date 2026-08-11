import React, { useState, useEffect, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
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

  // These buckets are keyed by the contract's EXPIRY week, not the week it was
  // traded (server: weekKey = getWeekStart(expiryDateStr)). So this is premium
  // per expiry, and a running cumulative total across it would be meaningless —
  // it isn't a time axis, and a LEAP expiring in 2028 sits at the far right.
  //
  // Drawn as what it is: premium by expiry week, with weeks still ahead marked
  // as not yet expired. Windowed around today so one long-dated contract can't
  // stretch the axis years out; anything outside is counted, not silently cut.
  const PAST_WEEKS = 16
  const FUTURE_WEEKS = 12
  const { byExpiry, outside, bookedTotal, aheadTotal } = useMemo(() => {
    if (!weeks?.length) return { byExpiry: [], outside: 0, bookedTotal: 0, aheadTotal: 0 }
    const today = new Date().toISOString().slice(0, 10)
    const ms = 7 * 24 * 3600 * 1000
    const now = new Date(today + 'T00:00:00').getTime()
    const lo = new Date(now - PAST_WEEKS * ms).toISOString().slice(0, 10)
    const hi = new Date(now + FUTURE_WEEKS * ms).toISOString().slice(0, 10)

    const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    const inRange = sorted.filter(w => w.weekStart >= lo && w.weekStart <= hi)
    let booked = 0, ahead = 0
    sorted.forEach(w => {
      const v = Number(w.totalDelta) || 0
      if (w.weekStart <= today) booked += v; else ahead += v
    })
    return {
      byExpiry: inRange.map(w => ({
        week: w.weekStart,
        label: shortDate(w.weekStart),
        premium: Math.round((Number(w.totalDelta) || 0) * 100) / 100,
        expired: w.weekStart <= today,
      })),
      outside: sorted.length - inRange.length,
      bookedTotal: Math.round(booked * 100) / 100,
      aheadTotal: Math.round(ahead * 100) / 100,
    }
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
  if (!byExpiry.length) return null

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

      {/* ── Premium by expiry week ─────────────────────────────────────────
          Solid = expired, so the premium is booked. Outlined = still open. The
          two are genuinely different things and shouldn't read as one series. */}
      <div className="floating-panel" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <h3 style={title}>Premium by expiry week</h3>
          <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                         color: bookedTotal >= 0 ? tokens.chartPositive : tokens.chartNegative }}>
            {moneySigned(bookedTotal)}
          </span>
        </div>
        <div style={sub}>
          Booked · {moneySigned(aheadTotal)} still open
        </div>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={byExpiry} margin={{ top: 14, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={tokens.chartGrid} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: tokens.chartText }}
                   axisLine={false} tickLine={false} minTickGap={18} />
            <YAxis tick={{ fontSize: 10, fill: tokens.chartText }} axisLine={false} tickLine={false}
                   width={54} tickFormatter={money} />
            <ReferenceLine y={0} stroke={tokens.border} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: 'var(--textSecondary)', fontSize: 11 }}
              cursor={{ fill: tokens.surfaceHover }}
              formatter={(v, _n, p) => [
                `${moneySigned(v)} ${p?.payload?.expired ? '(expired)' : '(still open)'}`, 'Premium',
              ]}
              labelFormatter={(l, p) => `Expiring week of ${p?.[0]?.payload?.week || l}`}
            />
            <Bar dataKey="premium" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
              {byExpiry.map(d => {
                const c = d.premium >= 0 ? tokens.chartPositive : tokens.chartNegative
                return (
                  <Cell key={d.week}
                        fill={d.expired ? c : 'transparent'}
                        stroke={c} strokeWidth={d.expired ? 0 : 1.5} />
                )
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 10.5, color: 'var(--textSecondary)', marginTop: -4, lineHeight: 1.45 }}>
          Grouped by the week each contract <strong>expires</strong>, not when it was traded.
          Solid bars have expired; outlined ones are still open.
          {outside > 0 && ` ${outside} week${outside !== 1 ? 's' : ''} outside this window not shown.`}
        </div>
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
