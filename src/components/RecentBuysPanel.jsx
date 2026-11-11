import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmt = (n) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

const qtyFmt = (q) => (Math.round(q * 100) / 100).toLocaleString('en-US')

const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}

/**
 * Each name's three latest stock buys, and whether they have since been sold.
 *
 * Sales are matched to buys on the server (getStockBuyLots): share for share,
 * within the broker, to the newest buy the sale made money on, then the newest
 * buy at all. Options are left out entirely, but a call assignment is a stock
 * sale and counts as one.
 */
export default function RecentBuysPanel({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [heldOnly, setHeldOnly] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setData(null); setError(null)
    const qs = new URLSearchParams({ n: '3' })
    if (broker && broker !== 'all') qs.set('broker', broker)
    fetch(`/api/recent-buys?${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (!d.success) throw new Error(d.error || 'Could not load'); setData(d) })
      .catch(e => setError(e.message))
  }, [broker])

  const tickers = useMemo(() => {
    if (!data) return []
    let t = data.tickers
    if (heldOnly) t = t.filter(x => x.position > 0)
    const q = query.trim().toUpperCase()
    if (q) t = t.filter(x => x.symbol.includes(q))
    return t.slice().sort((a, b) => (b.lastBuy || '').localeCompare(a.lastBuy || '') || a.symbol.localeCompare(b.symbol))
  }, [data, heldOnly, query])

  const card = {
    background: isDark ? '#1e293b' : '#fff',
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    borderRadius: 8, padding: 16, marginBottom: 16,
  }
  const th = {
    textAlign: 'right', padding: '6px 8px', fontSize: 11, fontWeight: 500,
    textTransform: 'uppercase', letterSpacing: '0.04em',
    color: isDark ? '#e2e8f0' : '#475569',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, whiteSpace: 'nowrap',
  }
  const td = {
    padding: '5px 8px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums', color: isDark ? '#e2e8f0' : '#0f172a',
  }
  const muted = isDark ? '#94a3b8' : '#64748b'
  const rule = `1px solid ${isDark ? '#334155' : '#e2e8f0'}`

  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn't load recent buys: {error}</div>
  if (!data) return <div style={card}>Loading recent buys…</div>

  const status = (lot) => {
    const sold = lot.qty - lot.left
    if (sold <= 1e-6) return <span style={{ color: '#22c55e', fontWeight: 600 }}>Held</span>
    const last = lot.sales[lot.sales.length - 1]
    const avgSale = lot.sales.reduce((a, s) => a + s.qty * s.price, 0) / sold
    const gain = (avgSale - lot.price) * sold
    const what = lot.left <= 0 ? 'Sold' : `Sold ${qtyFmt(sold)} of ${qtyFmt(lot.qty)}`
    const title = lot.sales.map(s => `${fmtDate(s.date)}: ${qtyFmt(s.qty)} @ ${fmt(s.price)}${s.code ? ` (${s.code})` : ''}`).join('\n')
    return (
      <span title={title} style={{ color: muted }}>
        {what} · {lot.sales.length > 1 ? `avg ${fmt(avgSale)}` : `${fmt(last.price)} on ${fmtDate(last.date)}`}
        <span style={{ marginLeft: 6, fontWeight: 600, color: pnlColor(gain, isDark) }}>{gain >= 0 ? '+' : ''}{fmt(gain)}</span>
      </span>
    )
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: isDark ? '#ffffff' : '#0f172a' }}>Recent Buys</h3>
        <span style={{ fontSize: 12, color: muted }}>last 3 stock buys per name · newest activity first</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ticker…"
            style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 6, width: 130,
              border: rule, background: isDark ? '#0f172a' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a',
            }} />
          {[[true, 'Held'], [false, 'All']].map(([k, label]) => (
            <button key={label} onClick={() => setHeldOnly(k)}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: rule,
                background: heldOnly === k ? (isDark ? '#334155' : '#e2e8f0') : 'transparent',
                color: isDark ? '#e2e8f0' : '#0f172a',
              }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
              <th style={{ ...th, textAlign: 'left' }}>Bought</th>
              {broker === 'all' && <th style={{ ...th, textAlign: 'left' }}>Broker</th>}
              <th style={th}>Shares</th>
              <th style={th}>Price</th>
              <th style={th} title="Today's price against the buy price, on the shares from this buy still held.">Now vs buy</th>
              <th style={{ ...th, textAlign: 'left' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {tickers.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'left', color: muted }} colSpan={7}>
                {query ? `No ticker matches "${query}".` : 'No stock buys to show.'}
              </td></tr>
            )}
            {tickers.map(t => t.recent.map((lot, i) => {
              const up = t.price != null ? t.price - lot.price : null
              return (
                <tr key={lot.id} style={{ borderTop: i === 0 ? rule : 'none' }}>
                  <td style={{ ...td, textAlign: 'left', verticalAlign: 'top' }}>
                    {i === 0 && (
                      <>
                        <span style={{ fontWeight: 700 }}>{t.symbol}</span>
                        <span style={{ marginLeft: 8, fontSize: 11, color: muted }}>
                          {t.price != null ? fmt(t.price) : '—'}{t.position > 0 ? ` · ${qtyFmt(t.position)} sh` : ' · none held'}
                        </span>
                      </>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'left', color: muted }}>{fmtDate(lot.date)}</td>
                  {broker === 'all' && <td style={{ ...td, textAlign: 'left', color: muted, fontSize: 12 }}>{lot.broker}</td>}
                  <td style={td}>{qtyFmt(lot.qty)}</td>
                  <td style={td}>{fmt(lot.price)}</td>
                  <td style={{ ...td, color: lot.left > 0 ? pnlColor(up, isDark) : muted }}>
                    {up == null ? '—' : lot.left > 0
                      ? <>{up >= 0 ? '+' : ''}{(up / lot.price * 100).toFixed(1)}%<span style={{ fontSize: 11, marginLeft: 6 }}>{up >= 0 ? '+' : ''}{fmt(up * lot.left)}</span></>
                      : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'left', fontSize: 12 }}>{status(lot)}</td>
                </tr>
              )
            }))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: muted, marginTop: 10, lineHeight: 1.5 }}>
        Stock only. A sale is matched share for share to the newest buy at the same broker that it made money on,
        then to the newest buy at all, so selling or being assigned on 100 shares only marks 100 shares as sold.
        Hover a status to see each sale.
      </div>
    </div>
  )
}
