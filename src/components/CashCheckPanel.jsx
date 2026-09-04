import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmt = (n) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}

/**
 * An independent check on the Positions table.
 *
 * Built the way you'd check it by hand: the cash that actually moved through
 * options, less the credit still sitting in open shorts, plus Open P&L, plus the
 * stock's mark minus its cost. Five terms, one total.
 *
 * The value is that it shares NO machinery with Options Total — no cost basis,
 * no LIFO matching, no settlement direction. Every discrepancy chased on
 * 2026-09-03 lived in the matching, and none of it can reach these numbers. So
 * when this and the Positions table agree, the agreement means something.
 *
 * Open longs are carried at cost (their current value is not added). On cheap
 * OTM contracts that is a small understatement, and it keeps the arithmetic to
 * terms that can be checked against a brokerage statement without a model.
 */
export default function CashCheckPanel({ pnlData = [], broker = 'all' }) {
  const { isDark } = useTheme()
  const [cash, setCash] = useState(null)
  const [error, setError] = useState(null)
  const [hideEmpty, setHideEmpty] = useState(true)

  useEffect(() => {
    const qs = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/options-cash${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setCash(d) })
      .catch(e => setError(e.message))
  }, [broker])

  const rows = useMemo(() => {
    if (!cash) return []
    const byTicker = {}
    cash.forEach(c => { byTicker[c.ticker] = c })
    const tickers = new Set([
      ...cash.map(c => c.ticker),
      ...pnlData.map(p => p.ticker).filter(Boolean),
    ])
    const out = []
    tickers.forEach(ticker => {
      const c = byTicker[ticker] || { optionsCash: 0, openShortCredit: 0, openLongCost: 0 }
      const p = pnlData.find(x => x.ticker === ticker) || {}
      const openPnl = p.openUnrealizedPnL ?? 0
      const stockPnl = p.stockUnrealizedPnL ?? 0
      const total = c.optionsCash - c.openShortCredit + openPnl + stockPnl
      out.push({
        ticker,
        optionsCash: c.optionsCash,
        openShortCredit: c.openShortCredit,
        openLongCost: c.openLongCost,
        openPnl, stockPnl, total,
      })
    })
    const live = hideEmpty
      ? out.filter(r => r.optionsCash || r.openShortCredit || r.openPnl || r.stockPnl)
      : out
    return live.sort((a, b) => a.total - b.total)
  }, [cash, pnlData, hideEmpty])

  const totals = useMemo(() => rows.reduce((a, r) => ({
    optionsCash: a.optionsCash + r.optionsCash,
    openShortCredit: a.openShortCredit + r.openShortCredit,
    openPnl: a.openPnl + r.openPnl,
    stockPnl: a.stockPnl + r.stockPnl,
    total: a.total + r.total,
  }), { optionsCash: 0, openShortCredit: 0, openPnl: 0, stockPnl: 0, total: 0 }), [rows])

  const card = {
    background: isDark ? '#1e293b' : '#fff',
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    borderRadius: 8, padding: 16, marginBottom: 16,
  }
  const th = {
    textAlign: 'right', padding: '6px 8px', fontSize: 11, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.04em',
    color: isDark ? '#94a3b8' : '#64748b',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, whiteSpace: 'nowrap',
  }
  const td = {
    padding: '6px 8px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums', color: isDark ? '#e2e8f0' : '#0f172a',
  }
  const footTd = { ...td, fontWeight: 700, borderTop: `2px solid ${isDark ? '#334155' : '#e2e8f0'}` }

  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn't load the cash check: {error}</div>
  if (!cash) return <div style={card}>Loading cash check…</div>

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: isDark ? '#f1f5f9' : '#0f172a' }}>Cash Check</h3>
        <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
          independent of Options Total — shares no cost basis or trade matching
        </span>
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: isDark ? '#94a3b8' : '#64748b', cursor: 'pointer' }}>
          <input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} />
          Hide empty
        </label>
      </div>

      <div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', marginBottom: 12 }}>
        Options cash − open short credit + Open P&amp;L + Stock P&amp;L
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
              <th style={th} title="Every option amount summed: BTO and BTC out, STO and STC in. Expiries need no term — a bought option that expired worthless already has its cost in the BTO line.">Options cash</th>
              <th style={th} title="Premium collected on short options you still hold. Cash in hand, but not earned until the contract closes or expires — so it comes out here and returns through Open P&L.">Open short credit</th>
              <th style={th} title="Mark-to-market on open option positions.">Open P&amp;L</th>
              <th style={th} title="Shares held x (price now - cost). Unrealized only.">Stock P&amp;L</th>
              <th style={th}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'left', color: isDark ? '#64748b' : '#94a3b8' }} colSpan={6}>
                Nothing to show.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.ticker}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>
                  {r.ticker}
                  {r.openLongCost > 0 && (
                    <span title={`${fmt(r.openLongCost)} of open long options are carried at cost, not marked`}
                      style={{ marginLeft: 6, fontSize: 10, color: isDark ? '#64748b' : '#94a3b8' }}>
                      +{fmt(r.openLongCost)} at cost
                    </span>
                  )}
                </td>
                <td style={{ ...td, color: pnlColor(r.optionsCash, isDark) }}>{fmt(r.optionsCash)}</td>
                <td style={{ ...td, color: pnlColor(-r.openShortCredit, isDark) }}>
                  {r.openShortCredit ? fmt(-r.openShortCredit) : '—'}
                </td>
                <td style={{ ...td, color: pnlColor(r.openPnl, isDark) }}>{r.openPnl ? fmt(r.openPnl) : '—'}</td>
                <td style={{ ...td, color: pnlColor(r.stockPnl, isDark) }}>{r.stockPnl ? fmt(r.stockPnl) : '—'}</td>
                <td style={{ ...td, fontWeight: 700, color: pnlColor(r.total, isDark) }}>{fmt(r.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...footTd, textAlign: 'left' }}>Total</td>
              <td style={{ ...footTd, color: pnlColor(totals.optionsCash, isDark) }}>{fmt(totals.optionsCash)}</td>
              <td style={{ ...footTd, color: pnlColor(-totals.openShortCredit, isDark) }}>{fmt(-totals.openShortCredit)}</td>
              <td style={{ ...footTd, color: pnlColor(totals.openPnl, isDark) }}>{fmt(totals.openPnl)}</td>
              <td style={{ ...footTd, color: pnlColor(totals.stockPnl, isDark) }}>{fmt(totals.stockPnl)}</td>
              <td style={{ ...footTd, color: pnlColor(totals.total, isDark) }}>{fmt(totals.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', marginTop: 10, lineHeight: 1.5 }}>
        Open long options are carried at cost — their current value isn't added, so a ticker holding
        cheap bought contracts reads slightly low by the amount noted beside its name. Stock P&amp;L is
        unrealized only; shares you've sold are not in this total.
      </div>
    </div>
  )
}
