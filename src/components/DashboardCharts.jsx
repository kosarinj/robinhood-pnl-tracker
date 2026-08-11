import React, { useState, useEffect, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell, Legend,
} from 'recharts'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Dashboard charts.
 *
 * Built on /api/options-pnl/ytd rather than the options history endpoint,
 * because that one carries only option activity — at a stocks-only broker both
 * charts came up empty. The YTD rows carry stock AND option figures per ticker,
 * so these work whichever broker tab is selected.
 *
 * Colour, all measured with the palette validator rather than judged by eye:
 *  - gain/loss uses chartPositive/chartNegative — ΔE 7.8 light, 6.1 dark under
 *    deuteranopia, inside the floor band, so every bar carries a signed label
 *    and the sign (not the hue) is what says gain or loss.
 *  - stock vs options uses its own categorical pair at ΔE 26.1, comfortably
 *    clear, and is a different hue family from gain/loss so the two encodings
 *    never get confused.
 *  - all four sit in the right lightness band for their surface; the theme's
 *    text positive/negative are too light to use as fills on dark.
 */

const money = (n) => {
  const v = Number(n) || 0
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
const moneySigned = (n) => `${(Number(n) || 0) >= 0 ? '+' : '−'}$${Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export default function DashboardCharts({ broker = 'all' }) {
  const { tokens } = useTheme()
  const [rows, setRows] = useState(null)

  useEffect(() => {
    const params = new URLSearchParams()
    if (broker && broker !== 'all') params.set('broker', broker)
    const qs = params.toString()
    fetch(`/api/options-pnl/ytd${qs ? `?${qs}` : ''}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setRows(d?.success && Array.isArray(d.byUnderlying) ? d.byUnderlying : []))
      .catch(() => setRows([]))
  }, [broker])

  // Open positions only. A name fully exited earlier in the year still carries
  // realized P&L and would otherwise sit near the top of "biggest movers" — but
  // it isn't moving anything now, and there's nothing to act on.
  //
  // Open means shares held, or an option position still on: a live option mark,
  // premium outstanding, or a theta projection (which only exists for contracts
  // that haven't expired).
  const isOpen = (r) => (
    (Number(r.stockPosition) || 0) > 0 ||
    r.openUnrealizedPnL != null ||
    (Number(r.openPremium) || 0) !== 0 ||
    Object.keys(r.openProjected || {}).length > 0
  )

  // Per ticker: what the stock did, what the options did, and the sum. Stock is
  // realized + unrealized so a name held but not sold still shows its position.
  const { data, closedCount } = useMemo(() => {
    if (!rows?.length) return { data: [], closedCount: 0 }
    const open = rows.filter(isOpen)
    const mapped = open.map(r => {
      const options = Number(r.totalRealized) || 0
      const stock = (Number(r.stockUnrealizedPnL) || 0) + (Number(r.stockRealizedPnL) || 0)
      return { ticker: r.ticker, stock: Math.round(stock * 100) / 100, options: Math.round(options * 100) / 100, net: Math.round((stock + options) * 100) / 100 }
    }).filter(d => Math.abs(d.net) >= 1 || Math.abs(d.stock) >= 1 || Math.abs(d.options) >= 1)
    return { data: mapped, closedCount: rows.length - open.length }
  }, [rows])

  const top = useMemo(
    () => [...data].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 8).sort((a, b) => b.net - a.net),
    [data]
  )

  const totals = useMemo(() => ({
    stock: Math.round(data.reduce((s, d) => s + d.stock, 0) * 100) / 100,
    options: Math.round(data.reduce((s, d) => s + d.options, 0) * 100) / 100,
    net: Math.round(data.reduce((s, d) => s + d.net, 0) * 100) / 100,
  }), [data])

  if (rows === null || !top.length) return null

  // Only worth splitting stock from options where options actually exist.
  const hasOptions = data.some(d => Math.abs(d.options) >= 1)

  const card = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '16px 16px 10px', color: 'var(--text)',
  }
  const title = { margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }
  const sub = { fontSize: 11, color: 'var(--textSecondary)', textTransform: 'uppercase', letterSpacing: '0.11em' }
  const tip = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, fontSize: 12, color: 'var(--text)', padding: '6px 10px',
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginBottom: 20 }}>

      {/* ── Net by position ── one series, so no legend; sign carried by the label ── */}
      <div className="floating-panel" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <h3 style={title}>Biggest movers</h3>
          <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                         color: totals.net >= 0 ? tokens.chartPositive : tokens.chartNegative }}>
            {moneySigned(totals.net)}
          </span>
        </div>
        <div style={sub}>
          Open positions · {top.length} of {data.length}
          {closedCount > 0 && ` · ${closedCount} closed hidden`}
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={top} layout="vertical" margin={{ top: 12, right: 58, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={tokens.chartGrid} strokeDasharray="2 4" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: tokens.chartText }}
                   axisLine={false} tickLine={false} tickFormatter={money} />
            <YAxis type="category" dataKey="ticker" width={52}
                   tick={{ fontSize: 11, fill: tokens.text, fontWeight: 600 }}
                   axisLine={false} tickLine={false} />
            <ReferenceLine x={0} stroke={tokens.border} />
            <Tooltip contentStyle={tip} cursor={{ fill: tokens.surfaceHover }}
                     labelStyle={{ color: 'var(--textSecondary)', fontSize: 11 }}
                     formatter={(v, _n, p) => [
                       `${moneySigned(v)}  (stock ${moneySigned(p?.payload?.stock)}, options ${moneySigned(p?.payload?.options)})`,
                       'Net',
                     ]} />
            <Bar dataKey="net" radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={false}
                 label={{ position: 'right', formatter: moneySigned,
                          style: { fontSize: 10, fill: tokens.textSecondary } }}>
              {top.map(d => (
                <Cell key={d.ticker} fill={d.net >= 0 ? tokens.chartPositive : tokens.chartNegative} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Where it came from ── two series, so a legend is always present ── */}
      <div className="floating-panel" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <h3 style={title}>{hasOptions ? 'Stock vs options' : 'Stock P&L'}</h3>
          <span style={{ fontSize: 12, color: 'var(--textSecondary)', fontVariantNumeric: 'tabular-nums' }}>
            {hasOptions
              ? `${moneySigned(totals.stock)} stock · ${moneySigned(totals.options)} options`
              : `${moneySigned(totals.stock)} total`}
          </span>
        </div>
        <div style={sub}>
          {hasOptions ? 'Open positions · where the P&L came from' : 'Open positions · no option activity at this broker'}
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={top} margin={{ top: 12, right: 8, bottom: 0, left: -12 }}
                    barGap={2}>
            <CartesianGrid stroke={tokens.chartGrid} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="ticker" tick={{ fontSize: 10, fill: tokens.chartText }}
                   axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: tokens.chartText }} axisLine={false} tickLine={false}
                   width={54} tickFormatter={money} />
            <ReferenceLine y={0} stroke={tokens.border} />
            <Tooltip contentStyle={tip} cursor={{ fill: tokens.surfaceHover }}
                     labelStyle={{ color: 'var(--textSecondary)', fontSize: 11 }}
                     formatter={(v, n) => [moneySigned(v), n]} />
            {hasOptions && (
              <Legend verticalAlign="top" height={22} iconType="square" iconSize={9}
                      wrapperStyle={{ fontSize: 11, color: 'var(--textSecondary)' }} />
            )}
            <Bar dataKey="stock" name="Stock" fill={tokens.chartSeriesStock}
                 radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            {hasOptions && (
              <Bar dataKey="options" name="Options" fill={tokens.chartSeriesOptions}
                   radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
