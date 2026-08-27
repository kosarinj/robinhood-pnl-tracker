import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import ShortCallChart from './ShortCallChart'

const fmt = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

const pnlColor = (n, isDark) => {
  if (n == null) return isDark ? '#94a3b8' : '#64748b'
  if (n > 0) return '#22c55e'
  if (n < 0) return '#ef4444'
  return isDark ? '#94a3b8' : '#64748b'
}

const stockMoveColor = (n, isDark) => {
  // For short calls, stock moving up is bad (increases call value), moving down is good
  if (n == null) return isDark ? '#94a3b8' : '#64748b'
  if (n > 0) return '#ef4444'
  if (n < 0) return '#22c55e'
  return isDark ? '#94a3b8' : '#64748b'
}

export default function ShortCallTracker({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [editingId, setEditingId] = useState(null)
  // Drill-down into the individual sales behind a row. short_call_entries
  // collapses same-day fills, so the trades are the only place the separate
  // sales survive.
  const [expandedId, setExpandedId] = useState(null)
  const [fills, setFills] = useState({ loading: false, data: null, error: null })
  const [editClose, setEditClose] = useState('')
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildMsg, setRebuildMsg] = useState(null)
  const [showClosed, setShowClosed] = useState(false)
  const [search, setSearch] = useState('')
  const [chartEntry, setChartEntry] = useState(null)

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const headerBg = isDark ? '#151929' : '#f8fafc'

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
      const res = await fetch(`/api/short-calls${q}`, { credentials: 'include' })
      const json = await res.json()
      if (json.success) setData(json)
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Refetches on broker change as well as on the timer, so the tracker follows
  // the broker tab like the Positions panel does.
  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(iv)
  }, [broker])

  const saveUnderlyingClose = async (id, price) => {
    try {
      await fetch(`/api/short-calls/${id}/underlying-close`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlyingClose: parseFloat(price) })
      })
      setEditingId(null)
      fetchData()
    } catch (e) {
      alert('Failed to save: ' + e.message)
    }
  }

  const handleRebuild = async () => {
    if (!window.confirm('Re-scan all historical STO call trades and populate the tracker? This may take a moment.')) return
    setRebuilding(true)
    setRebuildMsg(null)
    try {
      const res = await fetch('/api/short-calls/rebuild', { method: 'POST', credentials: 'include' })
      const json = await res.json()
      if (json.success) {
        setRebuildMsg(`Populated ${json.populated} entries (${json.skipped} skipped)`)
        fetchData()
      } else {
        setRebuildMsg('Error: ' + json.error)
      }
    } catch (e) {
      setRebuildMsg('Error: ' + e.message)
    } finally {
      setRebuilding(false)
    }
  }

  const sq = search.trim().toUpperCase()
  const entries = (data?.entries || [])
    .filter(e => !sq || (e.ticker || '').toUpperCase().includes(sq))
    .sort((a, b) =>
      (a.ticker || '').localeCompare(b.ticker || '') ||
      (a.expiry || '').localeCompare(b.expiry || '') ||
      (a.strike || 0) - (b.strike || 0)
    )
  const openEntries = entries.filter(e => e.isOpen)
  const closedEntries = entries.filter(e => !e.isOpen)
  const filtered = showClosed ? entries : openEntries

  const thStyle = {
    padding: '9px 10px', textAlign: 'right', fontSize: '11px', fontWeight: '600',
    color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em',
    background: headerBg, borderBottom: `2px solid ${border}`, whiteSpace: 'nowrap'
  }

  const toggleFills = async (entry) => {
    if (expandedId === entry.id) { setExpandedId(null); return }
    setExpandedId(entry.id)
    setFills({ loading: true, data: null, error: null })
    try {
      const r = await fetch(`/api/short-calls/${entry.id}/trades`, { credentials: 'include' })
      const d = await r.json()
      setFills(d?.success
        ? { loading: false, data: d, error: null }
        : { loading: false, data: null, error: d?.error || 'Could not load' })
    } catch (e) {
      setFills({ loading: false, data: null, error: 'Could not load' })
    }
  }

  const renderRow = (entry, i) => {
    const isEditing = editingId === entry.id
    const dteBadgeColor = entry.daysToExpiry > 21 ? '#22c55e' : entry.daysToExpiry > 7 ? '#f59e0b' : entry.daysToExpiry >= 0 ? '#ef4444' : '#94a3b8'

    // Highlight by the option's own P&L: premium sold − current call price (per share).
    // Profitable (green) when the call is cheaper to buy back than you sold it for;
    // underwater (red) when it now costs more. Neutral when there's no current price.
    const optGain = entry.thetaGain
    const hasGain = optGain != null && entry.currentOptionPrice != null
    const profitable = hasGain && optGain > 0
    const losing = hasGain && optGain < 0
    const rowBg = profitable ? (isDark ? '#13301e' : '#f0fdf4')
      : losing ? (isDark ? '#3a1d24' : '#fff1f2')
      : (i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff'))
    const accent = profitable ? '#22c55e' : losing ? '#ef4444' : null

    return (
      <React.Fragment key={entry.id}>
      <tr style={{ borderBottom: `1px solid ${border}`, background: rowBg, boxShadow: accent ? `inset 3px 0 0 ${accent}` : undefined }}>
        <td
          onClick={() => setChartEntry(entry)}
          title="View option vs stock price chart"
          style={{ padding: '9px 8px', fontWeight: '700', color: '#3b82f6', cursor: 'pointer', position: 'sticky', left: 0, zIndex: 1, width: '60px', minWidth: '60px', maxWidth: '60px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: rowBg, boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}` }}
        >{entry.ticker} 📈</td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: text }}>
          ${entry.strike}
          {entry.spread && (
            <div style={{ fontSize: '10px', color: textMid, fontWeight: 500, whiteSpace: 'nowrap' }}
              title={`Long $${entry.spread.strike} call × ${entry.spread.contracts} caps this short.` +
                (entry.spread.sameExpiry ? '' : ` NOTE: it expires ${entry.spread.expiry}, not with the short leg.`) +
                (entry.spread.fullyCovered ? '' : ' Only part of the short position is covered — the rest is uncapped.') +
                ` Width $${entry.spread.width}, cost ${fmt(entry.spread.longCost)}.`}>
              <span style={{ color: '#3b82f6', fontWeight: 700 }}>
                {entry.spread.fullyCovered ? 'SPREAD' : 'PARTIAL'}
              </span>
              {' '}▲${entry.spread.strike}
              {!entry.spread.sameExpiry && <span style={{ color: '#f59e0b' }}> ⚠</span>}
            </div>
          )}
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: textMid }}>{fmtDate(entry.expiry)}</td>
        <td style={{ padding: '9px 10px', textAlign: 'center' }}>
          <span style={{ padding: '2px 7px', borderRadius: '10px', fontSize: '11px', fontWeight: '700', background: dteBadgeColor + '22', color: dteBadgeColor }}>
            {entry.isExpired ? 'Exp' : `${entry.daysToExpiry}d`}
          </span>
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'center', color: textMid }}>
          {entry.contracts}
          {/* Only worth offering where there can be something to see. One
              contract is one fill, so an expander there would always disappoint. */}
          {/* Offered when there's more than one contract OR more than one sale —
              a two-contract position bought in one fill has nothing to show,
              while two separate sales of one contract each certainly does. */}
          {((entry.contracts || 1) > 1 || (entry.saleCount || 1) > 1) && (
            <button
              onClick={() => toggleFills(entry)}
              title="Show the individual sales behind this position"
              style={{ marginLeft: 5, padding: '0 5px', fontSize: 12, lineHeight: 1.3,
                       border: `1px solid ${border}`, borderRadius: 4, cursor: 'pointer',
                       background: expandedId === entry.id ? '#3b82f6' : 'transparent',
                       color: expandedId === entry.id ? '#fff' : textMid }}>
              {expandedId === entry.id ? '−' : '+'}
            </button>
          )}
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: '#22c55e', fontWeight: '600' }}>{fmt(entry.premium)}</td>
        <td style={{ padding: '9px 10px', textAlign: 'right' }}>
          {(entry.saleCount || 1) > 1 && (
            <div style={{ fontSize: 10, color: textMid, whiteSpace: 'nowrap' }}
              title={`Sold across ${entry.saleCount} trades: ${(entry.saleDates || []).map(fmtDate).join(', ')}. The premium shown is the average weighted by contracts.`}>
              {entry.saleCount} sales · avg
            </div>
          )}
          {isEditing ? (
            <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
              <input
                type="number"
                value={editClose}
                onChange={e => setEditClose(e.target.value)}
                autoFocus
                step="0.01"
                style={{ width: '80px', padding: '3px 6px', borderRadius: '4px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '12px' }}
              />
              <button onClick={() => saveUnderlyingClose(entry.id, editClose)} style={{ padding: '3px 7px', borderRadius: '4px', border: 'none', background: '#22c55e', color: 'white', fontSize: '11px', cursor: 'pointer' }}>✓</button>
              <button onClick={() => setEditingId(null)} style={{ padding: '3px 7px', borderRadius: '4px', border: 'none', background: '#94a3b8', color: 'white', fontSize: '11px', cursor: 'pointer' }}>✗</button>
            </div>
          ) : (
            <button
              onClick={() => { setEditingId(entry.id); setEditClose(entry.underlying_close ?? '') }}
              style={{ background: 'transparent', border: `1px solid ${border}`, padding: '2px 8px', borderRadius: '4px', color: entry.underlying_close ? text : '#f59e0b', cursor: 'pointer', fontSize: '12px' }}
              title="Click to set or edit underlying close price on sale date"
            >
              {entry.underlying_close ? fmt(entry.underlying_close) : '— set ✎'}
            </button>
          )}
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: text }}>{fmt(entry.currentStock)}</td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: textMid }}
            title={entry.priceSource === 'model' ? 'Estimated (Black–Scholes) — no live quote on the data plan, so modeled from the underlying'
                 : entry.priceSource === 'close' ? 'Stale: last daily close (no live quote or recent trade)'
                 : entry.priceSource === 'quote' ? 'Live quote / recent trade' : ''}>
          {entry.currentOptionPrice != null
            ? <>{entry.priceSource === 'model' ? '~' : ''}{fmt(entry.currentOptionPrice)}{entry.priceSource === 'model' ? <span style={{ fontSize: '10px', color: textMid }}> est</span> : entry.priceSource === 'close' ? <span style={{ fontSize: '10px', color: '#f59e0b' }}> stale</span> : ''}</>
            : <span style={{ fontSize: '11px', color: textMid }}>n/a</span>}
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: '600', color: stockMoveColor(entry.stockMove, isDark) }}>
          {entry.stockMove != null ? (entry.stockMove >= 0 ? '+' : '') + fmt(entry.stockMove) : '—'}
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: '700', color: pnlColor(entry.thetaGain, isDark) }}
          title={entry.callGainTotal != null ? `Total across ${entry.contracts} contract(s): ${(entry.callGainTotal >= 0 ? '+' : '') + fmt(entry.callGainTotal)}` : ''}>
          {entry.thetaGain != null ? (entry.thetaGain >= 0 ? '+' : '') + fmt(entry.thetaGain) : '—'}
        </td>
        {(() => {
          // A spread is not a covered call. The covered-call figure adds the
          // stock's move because it assumes 100 shares sit behind the short
          // call — with a long call there instead, that term is meaningless and
          // the long leg's own gain is missing. So a spread reports both legs
          // and nothing else, which is also why it reads as a smaller loss on a
          // rally: the long leg is gaining while the short one loses.
          const sp = entry.spread
          const isSpread = !!sp && sp.netPnl != null
          const netDollars = isSpread
            ? sp.netPnl
            : (entry.stockMove != null && entry.thetaGain != null)
              ? (entry.stockMove + entry.thetaGain) * 100 * (entry.contracts || 1)
              : null
          const title = isSpread
            ? `Spread P&L, both legs: short $${entry.strike} ${(sp.shortPnl >= 0 ? '+' : '') + fmt(sp.shortPnl)} ` +
              `+ long $${sp.strike} ${(sp.longPnl >= 0 ? '+' : '') + fmt(sp.longPnl)} = ${(sp.netPnl >= 0 ? '+' : '') + fmt(sp.netPnl)}. ` +
              `Net credit ${fmt(sp.netCredit)}` +
              (sp.maxLoss != null ? ` · max profit ${fmt(sp.maxProfit)} / max loss ${fmt(sp.maxLoss)}` : '') +
              `. Excludes stock movement — there are no shares behind this one.`
            : `(Stock Δ + Call Gain) × 100 × ${entry.contracts || 1} contract(s) — total dollar performance of the covered call position`
          return (
            <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: '700', borderLeft: `1px solid ${border}`,
              color: netDollars != null ? pnlColor(netDollars, isDark) : (isDark ? '#94a3b8' : '#64748b') }}
              title={title}>
              {netDollars != null ? (netDollars >= 0 ? '+' : '') + fmt(netDollars) : '—'}
              {isSpread && <div style={{ fontSize: '10px', color: textMid, fontWeight: 400 }}>both legs</div>}
            </td>
          )
        })()}
        <td style={{ padding: '9px 10px', textAlign: 'center' }}>
          <span style={{
            padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600',
            background: entry.isOpen ? '#22c55e22' : '#94a3b822',
            color: entry.isOpen ? '#22c55e' : '#94a3b8'
          }}>
            {entry.isExpired ? 'Expired' : entry.isOpen ? 'Open' : 'Closed'}
          </span>
        </td>
      </tr>

      {expandedId === entry.id && (
        <tr style={{ background: isDark ? '#141a2b' : '#f7f9fc' }}>
          <td colSpan={13} style={{ padding: '10px 16px', borderBottom: `1px solid ${border}` }}>
            {fills.loading && <span style={{ fontSize: 12, color: textMid }}>Loading fills…</span>}
            {fills.error && <span style={{ fontSize: 12, color: '#ef4444' }}>{fills.error}</span>}
            {fills.data && (
              <div>
                <div style={{ fontSize: 11, color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                  Individual trades in {fills.data.symbol}
                </div>
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <tbody>
                    {fills.data.fills.map((f, k) => (
                      <tr key={k}>
                        <td style={{ padding: '3px 14px 3px 0', color: textMid }}>{fmtDate(f.date)}</td>
                        <td style={{ padding: '3px 14px 3px 0', fontWeight: 600,
                                     color: f.opening ? '#22c55e' : '#f59e0b' }}>
                          {f.opening ? 'Sold' : f.transCode === 'OEXP' ? 'Expired' : 'Closed'}
                        </td>
                        <td style={{ padding: '3px 14px 3px 0', color: text }}>
                          {f.contracts} contract{f.contracts === 1 ? '' : 's'}
                        </td>
                        <td style={{ padding: '3px 14px 3px 0', color: text }}>
                          {fmt(f.perShare)}/sh
                        </td>
                        <td style={{ padding: '3px 0', color: textMid }}>
                          {fmt(f.totalAmount)} total
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div style={{ fontSize: 11.5, color: textMid, marginTop: 8, lineHeight: 1.5 }}>
                  {fills.data.summary.sales} sale{fills.data.summary.sales === 1 ? '' : 's'} ·{' '}
                  {fills.data.summary.soldContracts} contracts ·{' '}
                  average {fmt(fills.data.summary.avgPerShare)}/sh
                  {/* The row is built from short_call_entries, which collapses
                      same-day fills. Where that disagrees with the trades, say
                      so — the trades are the record. */}
                  {fills.data.summary.storedContracts != null
                    && fills.data.summary.storedContracts !== fills.data.summary.soldContracts && (
                    <div style={{ color: '#f59e0b', marginTop: 4 }}>
                      The row shows {fills.data.summary.storedContracts} contract(s) but the trades total{' '}
                      {fills.data.summary.soldContracts} — same-day sales get collapsed into one entry,
                      so the trades above are the accurate record.
                    </div>
                  )}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
      </React.Fragment>
    )
  }

  const saleDate = entries[0]?.sale_date

  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: text }}>Short Call Tracker</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={fetchData} disabled={loading} style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: 'white', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button onClick={handleRebuild} disabled={rebuilding} style={{ padding: '5px 12px', borderRadius: '6px', border: `1px solid ${border}`, background: 'transparent', color: textMid, fontSize: '12px', cursor: 'pointer' }}>
            {rebuilding ? 'Scanning…' : '↺ Rebuild from History'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: textMid, cursor: 'pointer' }}>
            <input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />
            Show closed/expired
          </label>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="🔍 Search ticker…"
              style={{ padding: '5px 24px 5px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '12px', width: '150px' }}
            />
            {search && (
              <button onClick={() => setSearch('')} title="Clear"
                style={{ position: 'absolute', right: '6px', border: 'none', background: 'transparent', color: textMid, cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: 0 }}>×</button>
            )}
          </div>
        </div>
        {rebuildMsg && <span style={{ fontSize: '12px', color: '#22c55e' }}>{rebuildMsg}</span>}
        {!data?.polygonEnabled && (
          <span style={{ fontSize: '11px', color: '#f59e0b', background: '#fff3cd', padding: '3px 8px', borderRadius: '4px' }}>
            Set POLYGON_API_KEY for live call prices
          </span>
        )}
      </div>

      <p style={{ margin: '0 0 12px', fontSize: '12px', color: textMid }}>
        Tracks the underlying stock price when you sell a short call. Compare current vs. sale-day price to see how the position is working.
        <strong style={{ color: pnlColor(1, isDark) }}> Call Gain/Sh</strong> = premium you sold for − current call price (per share). It's positive when the call is cheaper to buy back than you sold it for — driven by both time decay and the stock falling. Hover the value for the dollar total across all contracts.
        {' '}<span style={{ color: '#22c55e', fontWeight: 600 }}>Rows shaded green</span> are profitable on the option (sold premium &gt; current call price — cheaper to buy back);{' '}
        <span style={{ color: '#ef4444', fontWeight: 600 }}>rows shaded red</span> cost more to buy back than you sold them for.
      </p>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', background: '#fee2e2', color: '#991b1b', marginBottom: '12px', fontSize: '13px' }}>{error}</div>
      )}

      {!loading && entries.length === 0 && !error && (
        <div style={{ padding: '32px', textAlign: 'center', color: textMid, fontSize: '13px', background: surface, borderRadius: '10px', border: `1px solid ${border}` }}>
          No short call entries found. Upload a CSV with STO (Sell to Open) call trades, or click "Rebuild from History" to scan existing trades.
        </div>
      )}

      {filtered.length > 0 && (
        <div className="floating-panel" style={{ overflowX: 'auto', position: 'relative', borderRadius: '10px', border: `1px solid ${border}` }}>
          <table className="sc-tracker-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '12px', background: surface }}>
            <colgroup>
              <col style={{ width: '60px' }} />
            </colgroup>
            <thead>
              <tr>
                {['Ticker', 'Strike', 'Expiry', 'DTE', 'Qty', 'Sold/Share', 'Stock @ Sale', 'Current Stock', 'Current Call', 'Stock Δ', 'Call Gain/Sh', 'Net $', 'Status'].map((h, i) => (
                  <th key={h} style={{ ...thStyle, textAlign: i === 0 ? 'left' : [3,4,12].includes(i) ? 'center' : 'right',
                    ...(i === 0 ? { position: 'sticky', left: 0, zIndex: 2, width: '60px', minWidth: '60px', maxWidth: '60px', overflow: 'hidden', padding: '9px 8px', boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}` } : {}),
                    ...(h === 'Net $' ? { background: isDark ? '#1a2035' : '#f0f4ff', borderLeft: `1px solid ${border}` } : {}) }}
                    title={h === 'Net $' ? '(Stock Δ + Call Gain) × 100 × contracts: total dollar performance of this covered call position'
                      : h === 'Call Gain/Sh' ? 'Per-share gain on the short call = premium sold − current call price. Positive means the call is cheaper to buy back than you sold it for. Includes both time decay AND stock movement, not pure theta.' : undefined}
                  >{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {openEntries.map((e, i) => renderRow(e, i))}
              {showClosed && closedEntries.length > 0 && (
                <>
                  <tr><td colSpan={13} style={{ padding: '6px 10px', fontSize: '11px', fontWeight: '600', color: textMid, background: headerBg, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Closed / Expired</td></tr>
                  {closedEntries.map((e, i) => renderRow(e, openEntries.length + i))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      {chartEntry && (
        <ShortCallChart entry={chartEntry} onClose={() => setChartEntry(null)} isDark={isDark} />
      )}
    </div>
  )
}
