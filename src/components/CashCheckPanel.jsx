import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { getPref, subscribePrefs } from '../services/prefs'

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
// Same key and default the Positions table uses. Read rather than duplicated,
// so the two panels can never end up describing different periods — comparing a
// windowed figure against an all-time one is what made an afternoon of
// hand-reconciliation disagree for no real reason.
const LS_GLOBAL_KEY = 'ytdPanel_globalStart'
const DEFAULT_GLOBAL_START = '2026-03-15'

export default function CashCheckPanel({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [start, setStart] = useState(() => getPref(LS_GLOBAL_KEY, DEFAULT_GLOBAL_START))

  // Follow the table when its start date is changed.
  useEffect(() => subscribePrefs(() => {
    setStart(getPref(LS_GLOBAL_KEY, DEFAULT_GLOBAL_START))
  }), [])
  const [cash, setCash] = useState(null)
  const [ytd, setYtd] = useState([])
  const [error, setError] = useState(null)
  const [openOnly, setOpenOnly] = useState(true)
  const [query, setQuery] = useState('')

  // Open P&L and Stock P&L come from /api/options-pnl/ytd, the same source the
  // Positions table reads. The `pnlData` prop this first took is a different
  // dataset and carries neither field, so both columns rendered blank.
  useEffect(() => {
    const cq = new URLSearchParams({ start })
    if (broker && broker !== 'all') cq.set('broker', broker)
    const yq = new URLSearchParams({ startDate: start })
    if (broker && broker !== 'all') yq.set('broker', broker)
    Promise.all([
      fetch(`/api/options-cash?${cq}`, { credentials: 'include' }).then(r => r.json()),
      fetch(`/api/options-pnl/ytd?${yq}`, { credentials: 'include' }).then(r => r.json()),
    ]).then(([c, y]) => {
      if (c.error) throw new Error(c.error)
      setCash(c)
      setYtd(Array.isArray(y?.byUnderlying) ? y.byUnderlying : [])
    }).catch(e => setError(e.message))
  }, [broker, start])

  const rows = useMemo(() => {
    if (!cash) return []
    const byTicker = {}
    cash.forEach(c => { byTicker[c.ticker] = c })
    const tickers = new Set([
      ...cash.map(c => c.ticker),
      ...ytd.map(p => p.ticker).filter(Boolean),
    ])
    const out = []
    tickers.forEach(ticker => {
      const c = byTicker[ticker] || { optionsCash: 0, openShortCredit: 0, openLongCost: 0 }
      const p = ytd.find(x => x.ticker === ticker) || {}
      const openPnl = p.openUnrealizedPnL ?? 0
      const stockPnl = p.stockUnrealizedPnL ?? 0
      const total = c.optionsCash - c.openShortCredit + openPnl + stockPnl
      out.push({
        ticker,
        optionsCash: c.optionsCash,
        openShortCredit: c.openShortCredit,
        openLongCost: c.openLongCost,
        // Open means something is still on: shares held, or an option contract
        // still live. A ticker fully closed out has history but nothing running.
        hasOpen: (p.stockPosition > 0) || c.openShortCredit > 0 || c.openLongCost > 0,
        shares: p.stockPosition ?? 0,
        openPnl, stockPnl, total,
      })
    })
    let live = out.filter(r => r.optionsCash || r.openShortCredit || r.openPnl || r.stockPnl)
    if (openOnly) live = live.filter(r => r.hasOpen)
    const q = query.trim().toUpperCase()
    if (q) live = live.filter(r => r.ticker.includes(q))
    return live.sort((a, b) => a.ticker.localeCompare(b.ticker))
  }, [cash, ytd, openOnly, query])

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
    color: isDark ? '#ffffff' : '#0f172a',
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
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: isDark ? '#ffffff' : '#0f172a' }}>Cash Check</h3>
        <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
          since {start} · independent of Options Total — shares no cost basis or trade matching
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ position: 'relative' }}>
            <input type="text" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search ticker…"
              style={{
                fontSize: 12, padding: '5px 24px 5px 10px', borderRadius: 6, width: 150,
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: isDark ? '#0f172a' : '#fff',
                color: isDark ? '#e2e8f0' : '#0f172a',
              }} />
            {query && (
              <button onClick={() => setQuery('')} title="Clear"
                style={{
                  position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                  border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14,
                  lineHeight: 1, color: isDark ? '#64748b' : '#94a3b8', padding: '2px 4px',
                }}>×</button>
            )}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: isDark ? '#94a3b8' : '#64748b', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
            Open positions only
          </label>
        </div>
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
                {query ? `No ticker matches "${query}".` : (openOnly ? 'No open positions.' : 'Nothing to show.')}
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
                {/* Neutral on purpose: this is premium being MOVED, not lost. It
                    leaves Options cash because it isn't earned yet and returns
                    through Open P&L on the same short. Red would read as a cost
                    it never was; green would imply it helps the total. */}
                <td style={{ ...td, color: isDark ? '#94a3b8' : '#64748b' }}>
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
              <td style={{ ...footTd, color: isDark ? '#94a3b8' : '#64748b' }}>{fmt(-totals.openShortCredit)}</td>
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
