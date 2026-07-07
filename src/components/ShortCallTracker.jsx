import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'

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

export default function ShortCallTracker() {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editClose, setEditClose] = useState('')
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildMsg, setRebuildMsg] = useState(null)
  const [showClosed, setShowClosed] = useState(false)
  const [search, setSearch] = useState('')

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const headerBg = isDark ? '#151929' : '#f8fafc'

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/short-calls', { credentials: 'include' })
      const json = await res.json()
      if (json.success) setData(json)
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(iv)
  }, [])

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

  const renderRow = (entry, i) => {
    const isEditing = editingId === entry.id
    const dteBadgeColor = entry.daysToExpiry > 21 ? '#22c55e' : entry.daysToExpiry > 7 ? '#f59e0b' : entry.daysToExpiry >= 0 ? '#ef4444' : '#94a3b8'

    // Truly in the money: current stock is above the call strike (assignment risk),
    // independent of the Net P&L. Flag it so she knows a roll may be warranted.
    const strikeNum = parseFloat(entry.strike)
    const stockNum = entry.currentStock != null ? parseFloat(entry.currentStock) : null
    const itm = stockNum != null && !isNaN(strikeNum) && stockNum > strikeNum
    const itmAmount = itm ? stockNum - strikeNum : null
    const rowBg = itm ? (isDark ? '#3a1d24' : '#fff1f2') : (i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff'))

    return (
      <tr key={entry.id} style={{ borderBottom: `1px solid ${border}`, background: rowBg, boxShadow: itm ? `inset 3px 0 0 #ef4444` : undefined }}>
        <td style={{ padding: '9px 8px', fontWeight: '700', color: text, position: 'sticky', left: 0, zIndex: 1, width: '60px', minWidth: '60px', maxWidth: '60px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: rowBg, boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}` }}>{entry.ticker}</td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: text, whiteSpace: 'nowrap' }}>
          ${entry.strike}
          {itm && (
            <span title={`In the money: stock is $${itmAmount.toFixed(2)} above the $${strikeNum} strike — assignment risk, consider rolling`}
              style={{ marginLeft: 6, padding: '1px 5px', borderRadius: '8px', fontSize: '10px', fontWeight: '700', background: '#ef444422', color: '#ef4444' }}>ITM</span>
          )}
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: textMid }}>{fmtDate(entry.expiry)}</td>
        <td style={{ padding: '9px 10px', textAlign: 'center' }}>
          <span style={{ padding: '2px 7px', borderRadius: '10px', fontSize: '11px', fontWeight: '700', background: dteBadgeColor + '22', color: dteBadgeColor }}>
            {entry.isExpired ? 'Exp' : `${entry.daysToExpiry}d`}
          </span>
        </td>
        <td style={{ padding: '9px 10px', textAlign: 'center', color: textMid }}>{entry.contracts}</td>
        <td style={{ padding: '9px 10px', textAlign: 'right', color: '#22c55e', fontWeight: '600' }}>{fmt(entry.premium)}</td>
        <td style={{ padding: '9px 10px', textAlign: 'right' }}>
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
          const netDollars = (entry.stockMove != null && entry.thetaGain != null)
            ? (entry.stockMove + entry.thetaGain) * 100 * (entry.contracts || 1)
            : null
          return (
            <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: '700', borderLeft: `1px solid ${border}`,
              color: netDollars != null ? pnlColor(netDollars, isDark) : (isDark ? '#94a3b8' : '#64748b') }}
              title={`(Stock Δ + Call Gain) × 100 × ${entry.contracts || 1} contract(s) — total dollar performance of the covered call position`}>
              {netDollars != null ? (netDollars >= 0 ? '+' : '') + fmt(netDollars) : '—'}
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
        {' '}<span style={{ color: '#ef4444', fontWeight: 600 }}>Rows shaded red / tagged ITM</span> mean the stock is above the strike (truly in the money → assignment risk), so a roll may be worth considering.
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
        <div style={{ overflowX: 'auto', position: 'relative', borderRadius: '10px', border: `1px solid ${border}` }}>
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
    </div>
  )
}
