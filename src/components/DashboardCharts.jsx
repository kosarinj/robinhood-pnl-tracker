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
    // Same basis as the Options YTD panel deliberately. These charts sit beside
    // that panel and get read against it, so a silent difference in cost basis
    // reads as one of them being broken. Account P&L above is where the
    // broker-comparable figure lives, and it needs no basis at all.
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
  // What each open position is worth to you RIGHT NOW:
  //   stock   = shares x (price - your cost basis, override honoured)
  //   options = open option P&L, which for a short call is usually negative and
  //             offsets the stock gain it was sold against
  //
  // Deliberately NOT a period measure. The previous version valued the shares
  // you hold today against the price at the start of the period, so a position
  // opened last week showed the stock's whole move for the period as if you'd
  // held it throughout — MRVL read +$3,700 on shares bought near today's price.
  // Doing periods properly needs per-lot dates; until then this answers the
  // question that can be answered exactly.
  const { data, closedCount } = useMemo(() => {
    if (!rows?.length) return { data: [], closedCount: 0 }
    const open = rows.filter(isOpen)
    const mapped = open.map(r => {
      const stock = Number(r.stockUnrealizedPnL) || 0
      const options = Number(r.openUnrealizedPnL) || 0
      // Net + Open, matching the Options YTD panel's column of that name:
      // realized options + realized stock + unrealized stock + open options.
      // The bar used to carry unrealized only, so it disagreed with the panel
      // by exactly the realized part — a real difference in what was being
      // measured, on top of the basis difference, and nothing said so.
      const realizedOptions = Number(r.totalRealized) || 0
      const realizedStock = Number(r.stockRealizedPnL) || 0
      return {
        ticker: r.ticker,
        stock: Math.round(stock * 100) / 100,
        options: Math.round(options * 100) / 100,
        realized: Math.round((realizedOptions + realizedStock) * 100) / 100,
        net: Math.round((realizedOptions + realizedStock + stock + options) * 100) / 100,
        shares: Number(r.stockPosition) || 0,
        costUsed: r.stockCostUsed ?? null,
        overrideUsed: !!r.stockCostIsOverride,
      }
    })
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

  if (rows === null) return null
  if (!top.length) {
    return (
      <div className="floating-panel" style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '14px 16px', marginBottom: 20, color: 'var(--textSecondary)', fontSize: 12.5,
      }}>
        No open positions to chart
        {closedCount > 0 ? ` — ${closedCount} closed position${closedCount !== 1 ? 's' : ''} are excluded.` : '.'}
      </div>
    )
  }

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
          <h3 style={title}>Net + Open P&amp;L by position</h3>
          <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                         color: totals.net >= 0 ? tokens.chartPositive : tokens.chartNegative }}>
            {moneySigned(totals.net)}
          </span>
        </div>
        <div style={{ ...sub, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>
            Realized + unrealized stock + open options — the Options YTD panel's Net + Open
            {closedCount > 0 && ` · ${closedCount} closed hidden`}
          </span>

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
                       `${moneySigned(v)}  (realized ${moneySigned(p?.payload?.realized)}, unrealized stock ${moneySigned(p?.payload?.stock)}, open options ${moneySigned(p?.payload?.options)})`,
                       'Net + Open P&L',
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
          <h3 style={title}>{hasOptions ? 'Stock vs open options' : 'Stock P&L'}</h3>
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
