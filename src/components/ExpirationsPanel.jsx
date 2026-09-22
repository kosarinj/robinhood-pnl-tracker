import React, { useState, useEffect, useMemo } from 'react'
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

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtMonth = (s) => {
  if (!s) return ''
  const [y, m] = s.split('-')
  return `${MONTHS[+m]} ${y}`
}

const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}

const r2 = n => Math.round(n * 100) / 100

/**
 * Where option premium actually went at expiry.
 *
 * These were invisible: a bought option expiring worthless loses its whole
 * premium, and until the settlement fix the Options YTD panel booked nothing at
 * all for it. The totals here are what that correction is made of, and the
 * drill-down exists so a number that looks too big can be checked contract by
 * contract rather than taken on trust.
 *
 * Totals and rollups are derived from the SAME filtered rows the detail shows,
 * so a search narrows every number on the panel together. Totals that ignored
 * the filter would be the more confusing half of a search.
 */
export default function ExpirationsPanel({ broker = 'all', startDate = '' }) {
  const { isDark } = useTheme()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [groupBy, setGroupBy] = useState('month')
  const [openKey, setOpenKey] = useState(null)
  const [hideExercised, setHideExercised] = useState(true)
  const [query, setQuery] = useState('')
  const [openPos, setOpenPos] = useState(null)   // open contracts, for the week block

  useEffect(() => {
    setLoading(true); setError(null)
    const qs = new URLSearchParams()
    if (broker && broker !== 'all') qs.set('broker', broker)
    if (startDate) qs.set('start', startDate)
    fetch(`/api/expirations${qs.toString() ? `?${qs}` : ''}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [broker, startDate])

  // Open contracts expiring this week, from the open-positions endpoint rather
  // than this panel's own: /api/expirations is settled history, and the
  // question here is about contracts that have not settled yet.
  useEffect(() => {
    const qs = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/options-pnl/open-positions${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setOpenPos(d?.positions || []))
      .catch(() => setOpenPos([]))      // the week block just stays hidden
  }, [broker])

  const today = new Date().toLocaleDateString('en-CA')
  // Through the coming Friday. On a Saturday that means next week's, not
  // yesterday's — an expiry window that has already passed is no window at all.
  const weekEnd = useMemo(() => {
    const d = new Date()
    const day = d.getDay()
    d.setDate(d.getDate() + (day === 6 ? 6 : day === 0 ? 5 : 5 - day))
    return d.toLocaleDateString('en-CA')
  }, [])

  /**
   * Longs and shorts are kept apart because expiring worthless means opposite
   * things for them: a long's current value is what you LOSE if it dies, a
   * short's is what you stop owing and therefore KEEP. One combined number
   * would net those against each other and mean nothing.
   */
  const week = useMemo(() => {
    const list = (openPos || []).filter(p => p.expiry >= today && p.expiry <= weekEnd)
    let longVal = 0, shortVal = 0, priced = 0, unpriced = 0, contracts = 0
    // Split by moneyness, because market value alone answers the wrong
    // question. A deep in-the-money call carries its intrinsic value right to
    // expiry and gets sold or exercised — it is not heading for zero, and
    // counting it under "expiring worthless" made a single contract look like
    // thousands of dollars at risk. What actually expires worthless is the
    // out-of-the-money side.
    let longOtm = 0, shortOtm = 0, longItm = 0, shortItm = 0, unknown = 0
    for (const p of list) {
      contracts += Math.abs(p.openContracts || 0)
      if (p.markSource) priced += 1; else unpriced += 1
      const v = p.currentValue || 0
      if (p.isLong) longVal += v; else shortVal += v

      const S = p.stockPrice
      if (!(S > 0) || !(p.strike > 0)) { unknown += 1; continue }
      const itm = p.optionType === 'put' ? S < p.strike : S > p.strike
      if (p.isLong) { if (itm) longItm += v; else longOtm += v }
      else { if (itm) shortItm += v; else shortOtm += v }
    }
    return { list, longVal, shortVal, priced, unpriced, contracts,
             longOtm, shortOtm, longItm, shortItm, unknown }
  }, [openPos, today, weekEnd])

  // Space-separated terms, all of which must match somewhere on the row — so
  // "pltr put" narrows to PLTR puts rather than everything mentioning either.
  const rows = useMemo(() => {
    const all = data?.rows || []
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return all
    return all.filter(r => {
      const hay = [
        r.symbol, r.ticker, r.type, r.side, r.outcome,
        r.settledOn, fmtDate(r.settledOn), fmtMonth((r.settledOn || '').slice(0, 7)),
        r.strike != null ? String(r.strike) : '',
      ].join(' ').toLowerCase()
      return terms.every(t => hay.includes(t))
    })
  }, [data, query])

  const totals = useMemo(() => {
    const worthless = rows.filter(r => r.outcome === 'expired worthless')
    return {
      contracts: r2(rows.reduce((s, r) => s + r.contracts, 0)),
      realized: r2(worthless.reduce((s, r) => s + r.realized, 0)),
      lostOnLongs: r2(worthless.filter(r => r.realized < 0).reduce((s, r) => s + r.realized, 0)),
      keptOnShorts: r2(worthless.filter(r => r.realized > 0).reduce((s, r) => s + r.realized, 0)),
      expiredWorthless: worthless.length,
      exercisedOrAssigned: rows.length - worthless.length,
    }
  }, [rows])

  // Rolled up here rather than taken from the server, so the search reaches them.
  const groups = useMemo(() => {
    const m = {}
    rows.forEach(r => {
      const k = groupBy === 'month' ? (r.settledOn || '').slice(0, 7) : r.ticker
      if (!k) return
      const e = m[k] || (m[k] = { key: k, contracts: 0, realized: 0, lostOnLongs: 0, keptOnShorts: 0, count: 0 })
      e.count += 1
      e.contracts += r.contracts
      if (r.outcome === 'expired worthless') {
        e.realized += r.realized
        if (r.realized < 0) e.lostOnLongs += r.realized
        else e.keptOnShorts += r.realized
      }
    })
    const list = Object.values(m).map(e => ({
      ...e, contracts: r2(e.contracts), realized: r2(e.realized),
      lostOnLongs: r2(e.lostOnLongs), keptOnShorts: r2(e.keptOnShorts),
    }))
    return groupBy === 'month'
      ? list.sort((a, b) => (a.key < b.key ? 1 : -1))
      : list.sort((a, b) => a.realized - b.realized)
  }, [rows, groupBy])

  const detail = useMemo(() => {
    if (!openKey) return []
    const match = groupBy === 'month'
      ? r => (r.settledOn || '').slice(0, 7) === openKey
      : r => r.ticker === openKey
    const list = rows.filter(match)
    return hideExercised ? list.filter(r => r.outcome === 'expired worthless') : list
  }, [rows, openKey, groupBy, hideExercised])

  const card = {
    background: isDark ? '#1e293b' : '#fff',
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    borderRadius: 8, padding: 16, marginBottom: 16,
  }
  const th = {
    textAlign: 'left', padding: '6px 8px', fontSize: 11, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.04em',
    color: '#e2e8f0',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, whiteSpace: 'nowrap',
  }
  const td = { padding: '6px 8px', fontSize: 13, color: isDark ? '#e2e8f0' : '#0f172a', whiteSpace: 'nowrap' }
  const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

  if (loading) return <div style={card}>Loading expirations…</div>
  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn't load expirations: {error}</div>
  if (!data) return null

  const total = data.rows.length
  const filtering = rows.length !== total

  return (
    <div style={card}>
      {week.list.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap',
          padding: '10px 12px', marginBottom: 12, borderRadius: 8,
          background: isDark ? '#0f172a' : '#f8fafc',
          border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: isDark ? '#f1f5f9' : '#0f172a' }}>
            Expiring by {fmtDate(weekEnd)}
          </span>
          <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
            {week.list.length} position{week.list.length === 1 ? '' : 's'} · {week.contracts} contract{week.contracts === 1 ? '' : 's'}
          </span>

          <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}
                title="Bought contracts currently OUT of the money. These are the ones actually heading for zero — this is what is lost if they finish there.">
            Longs likely worthless{' '}
            <strong style={{ fontSize: 14, color: '#ef4444' }}>
              {week.longOtm.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
            </strong>
          </span>

          <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}
                title="Sold contracts currently OUT of the money. If they finish there you stop owing this and keep the premium.">
            Shorts likely kept{' '}
            <strong style={{ fontSize: 14, color: '#22c55e' }}>
              {week.shortOtm.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
            </strong>
          </span>

          <span style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}
                title="Contracts currently IN the money. They carry intrinsic value to expiry and get sold, exercised or assigned — they are not heading for zero, so they are kept out of the figures on the left.">
            in the money: longs {week.longItm.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
            {' · '}shorts {week.shortItm.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
          </span>

          {week.unknown > 0 && (
            <span style={{ fontSize: 11, color: '#f59e0b' }}
                  title="No underlying price for these, so they could not be classified either way.">
              {week.unknown} unclassified
            </span>
          )}

          {week.unpriced > 0 && (
            <span style={{ fontSize: 11, color: '#f59e0b' }}
                  title="These contracts had no usable price, so they contribute nothing to the figures beside them — the totals are a part, not the whole.">
              {week.unpriced} of {week.priced + week.unpriced} unpriced
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: isDark ? '#f1f5f9' : '#0f172a' }}>Expirations</h3>
        <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
          {data.start !== '2000-01-01' ? `since ${fmtDate(data.start)}` : 'all time'}
          {broker !== 'all' ? ` · ${broker}` : ''}
          {filtering ? ` · ${rows.length} of ${total}` : ''}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setOpenKey(null) }}
              placeholder="Search ticker, strike, month…"
              style={{
                fontSize: 12, padding: '5px 26px 5px 10px', borderRadius: 6, width: 200,
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: isDark ? '#0f172a' : '#fff',
                color: isDark ? '#e2e8f0' : '#0f172a',
              }}
            />
            {query && (
              <button onClick={() => setQuery('')} title="Clear search"
                style={{
                  position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                  border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1,
                  color: isDark ? '#64748b' : '#94a3b8', padding: '2px 4px',
                }}>×</button>
            )}
          </div>
          {[['month', 'By month'], ['ticker', 'By ticker']].map(([k, label]) => (
            <button key={k} onClick={() => { setGroupBy(k); setOpenKey(null) }}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: groupBy === k ? (isDark ? '#334155' : '#e2e8f0') : 'transparent',
                color: isDark ? '#e2e8f0' : '#0f172a',
              }}>{label}</button>
          ))}
        </div>
      </div>

      {/* Longs and shorts stay apart on purpose: netting them hides that the loss
          side is the bought options, which is the whole point of this panel. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
        {[
          ['Lost on bought options', totals.lostOnLongs, 'expired worthless'],
          ['Kept on sold options', totals.keptOnShorts, 'expired worthless'],
          ['Net from expiries', totals.realized, `${totals.expiredWorthless} settlements`],
          ['Exercised / assigned', null, `${totals.exercisedOrAssigned} — became stock, not a loss`],
        ].map(([label, value, sub]) => (
          <div key={label} style={{
            padding: '10px 12px', borderRadius: 6,
            background: isDark ? '#0f172a' : '#f8fafc',
            border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
          }}>
            <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', marginBottom: 4 }}>{label}</div>
            {value != null && (
              <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: pnlColor(value, isDark) }}>
                {fmt(value)}
              </div>
            )}
            <div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', marginTop: value != null ? 2 : 6 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>{groupBy === 'month' ? 'Month' : 'Ticker'}</th>
              <th style={{ ...th, textAlign: 'right' }}>Contracts</th>
              <th style={{ ...th, textAlign: 'right' }}>Lost on longs</th>
              <th style={{ ...th, textAlign: 'right' }}>Kept on shorts</th>
              <th style={{ ...th, textAlign: 'right' }}>Net</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td style={{ ...td, color: isDark ? '#64748b' : '#94a3b8' }} colSpan={6}>
                {query ? `Nothing matches "${query}".` : 'No expirations in this period.'}
              </td></tr>
            )}
            {groups.map(g => {
              const open = openKey === g.key
              return (
                <React.Fragment key={g.key}>
                  <tr onClick={() => setOpenKey(open ? null : g.key)}
                    style={{ cursor: 'pointer', background: open ? (isDark ? '#0f172a' : '#f8fafc') : 'transparent' }}>
                    <td style={{ ...td, fontWeight: 600 }}>
                      <span style={{ display: 'inline-block', width: 14, color: isDark ? '#64748b' : '#94a3b8' }}>
                        {open ? '▾' : '▸'}
                      </span>
                      {groupBy === 'month' ? fmtMonth(g.key) : g.key}
                    </td>
                    <td style={num}>{g.contracts}</td>
                    <td style={{ ...num, color: pnlColor(g.lostOnLongs, isDark) }}>{g.lostOnLongs ? fmt(g.lostOnLongs) : '—'}</td>
                    <td style={{ ...num, color: pnlColor(g.keptOnShorts, isDark) }}>{g.keptOnShorts ? fmt(g.keptOnShorts) : '—'}</td>
                    <td style={{ ...num, fontWeight: 600, color: pnlColor(g.realized, isDark) }}>{fmt(g.realized)}</td>
                    <td style={{ ...td, fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}>{g.count} settlements</td>
                  </tr>

                  {open && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0 8px 12px 22px', background: isDark ? '#0f172a' : '#f8fafc' }}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '8px 0', color: isDark ? '#94a3b8' : '#64748b', cursor: 'pointer' }}>
                          <input type="checkbox" checked={hideExercised} onChange={e => setHideExercised(e.target.checked)} />
                          Worthless expiries only (hide exercised / assigned)
                        </label>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={th}>Settled</th>
                              <th style={th}>Contract</th>
                              <th style={th}>Side</th>
                              <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                              <th style={{ ...th, textAlign: 'right' }}>Premium</th>
                              <th style={{ ...th, textAlign: 'right' }}>P&amp;L</th>
                              <th style={th}>Outcome</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.length === 0 && (
                              <tr><td style={{ ...td, color: isDark ? '#64748b' : '#94a3b8' }} colSpan={7}>Nothing to show.</td></tr>
                            )}
                            {detail.map((r, i) => (
                              <tr key={`${r.symbol}-${r.settledOn}-${i}`}>
                                <td style={td}>{fmtDate(r.settledOn)}</td>
                                <td style={td}>{r.symbol}</td>
                                <td style={{ ...td, color: isDark ? '#94a3b8' : '#64748b' }}>{r.side}</td>
                                <td style={num}>{r.contracts}</td>
                                <td style={num}>{fmt(r.premium)}</td>
                                <td style={{ ...num, color: pnlColor(r.realized, isDark) }}>
                                  {r.outcome === 'expired worthless' ? fmt(r.realized) : '—'}
                                </td>
                                <td style={{ ...td, fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}>{r.outcome}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', marginTop: 10, lineHeight: 1.5 }}>
        A bought option expiring worthless loses its whole premium; a sold one keeps it. Exercised and
        assigned contracts became stock, so their premium is not a loss and no P&amp;L is shown for them.
        Counted from raw trades, so same-day fills are not collapsed.
      </div>
    </div>
  )
}
