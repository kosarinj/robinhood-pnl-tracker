import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { getPref, subscribePrefs } from '../services/prefs'

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

const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}

const LS_GLOBAL_KEY = 'ytdPanel_globalStart'
const DEFAULT_GLOBAL_START = '2026-03-15'

/**
 * What bought contracts actually netted — winners included.
 *
 * The Expirations view and the "of which Expired" column both show only the cost
 * side: a long that PAID was closed with an STC and appears in neither. So
 * "these expired worthless" and "these lost money" are different claims, and
 * acting on the first as though it were the second is how you end up cutting a
 * hedge that was working.
 *
 * No verdict is attached to a contract. The same expired call can be a failed
 * bet or the premium on insurance that was never needed, and nothing in the
 * trade record separates them — so the drill-down gives strikes, dates and
 * amounts, and leaves the reading to whoever placed the trade.
 */
export default function LongOptionsPanel({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [start, setStart] = useState(() => getPref(LS_GLOBAL_KEY, DEFAULT_GLOBAL_START))
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')   // 'all' | 'call' | 'put'
  const [query, setQuery] = useState('')
  const [openKey, setOpenKey] = useState(null)

  useEffect(() => subscribePrefs(() => {
    setStart(getPref(LS_GLOBAL_KEY, DEFAULT_GLOBAL_START))
  }), [])

  useEffect(() => {
    const qs = new URLSearchParams({ start })
    if (broker && broker !== 'all') qs.set('broker', broker)
    fetch(`/api/long-options?${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d) })
      .catch(e => setError(e.message))
  }, [broker, start])

  const groups = useMemo(() => {
    if (!data) return []
    let g = data.byTickerAndType || []
    if (typeFilter !== 'all') g = g.filter(x => x.type === typeFilter)
    const q = query.trim().toUpperCase()
    if (q) g = g.filter(x => x.ticker.includes(q))
    return g.slice().sort((a, b) => a.net - b.net)
  }, [data, typeFilter, query])

  const detail = useMemo(() => {
    if (!data || !openKey) return []
    const [ticker, type] = openKey.split('|')
    return (data.contracts || [])
      .filter(c => c.ticker === ticker && c.type === type)
      .sort((a, b) => a.net - b.net)
  }, [data, openKey])

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
  const muted = isDark ? '#94a3b8' : '#64748b'

  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn't load long options: {error}</div>
  if (!data) return <div style={card}>Loading long options…</div>

  const t = data.totals || { calls: {}, puts: {} }

  const summary = (label, s, hint) => (
    <div key={label} style={{
      padding: '10px 12px', borderRadius: 6,
      background: isDark ? '#0f172a' : '#f8fafc',
      border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    }}>
      <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: pnlColor(s.net, isDark) }}>
        {fmt(s.net)}
      </div>
      <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
        paid {fmt(s.paid)} · back {fmt(s.proceeds)}
      </div>
      <div style={{ fontSize: 10, color: muted, marginTop: 4 }}>{hint}</div>
    </div>
  )

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: isDark ? '#ffffff' : '#0f172a' }}>Long Options</h3>
        <span style={{ fontSize: 12, color: muted }}>
          since {fmtDate(start)} · winners included, not just expiries
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <input type="text" value={query} onChange={e => { setQuery(e.target.value); setOpenKey(null) }}
              placeholder="Search ticker…"
              style={{
                fontSize: 12, padding: '5px 24px 5px 10px', borderRadius: 6, width: 140,
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: isDark ? '#0f172a' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a',
              }} />
            {query && (
              <button onClick={() => setQuery('')} title="Clear"
                style={{
                  position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                  border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14,
                  lineHeight: 1, color: muted, padding: '2px 4px',
                }}>×</button>
            )}
          </div>
          {[['all', 'All'], ['call', 'Calls'], ['put', 'Puts']].map(([k, label]) => (
            <button key={k} onClick={() => { setTypeFilter(k); setOpenKey(null) }}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: typeFilter === k ? (isDark ? '#334155' : '#e2e8f0') : 'transparent',
                color: isDark ? '#e2e8f0' : '#0f172a',
              }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 14 }}>
        {summary('Bought calls — net', t.calls, `${fmt(t.calls.lostToExpiry)} of it expired worthless`)}
        {summary('Bought puts — net', t.puts, `${fmt(t.puts.lostToExpiry)} of it expired worthless`)}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
              <th style={{ ...th, textAlign: 'left' }}>Type</th>
              <th style={th}>Contracts</th>
              <th style={th} title="Premium paid on contracts that reached an outcome.">Paid</th>
              <th style={th} title="Proceeds from closing or exercising them.">Back</th>
              <th style={th} title="Share of premium that never came back.">% expired</th>
              <th style={th}>Net</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'left', color: muted }} colSpan={7}>
                {query ? `No ticker matches "${query}".` : 'Nothing to show.'}
              </td></tr>
            )}
            {groups.map(g => {
              const key = `${g.ticker}|${g.type}`
              const open = openKey === key
              return (
                <React.Fragment key={key}>
                  <tr onClick={() => setOpenKey(open ? null : key)}
                    style={{ cursor: 'pointer', background: open ? (isDark ? '#0f172a' : '#f8fafc') : 'transparent' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>
                      <span style={{ display: 'inline-block', width: 14, color: muted }}>{open ? '▾' : '▸'}</span>
                      {g.ticker}
                    </td>
                    <td style={{ ...td, textAlign: 'left', color: muted }}>{g.type}</td>
                    <td style={td}>
                      {g.contracts}
                      {g.stillOpen > 0 && <span style={{ color: muted, fontSize: 10 }}> ({g.stillOpen} open)</span>}
                    </td>
                    <td style={td}>{fmt(g.paid)}</td>
                    <td style={td}>{fmt(g.proceeds)}</td>
                    <td style={{ ...td, color: muted }}>{g.percentLostToExpiry != null ? `${g.percentLostToExpiry}%` : '—'}</td>
                    <td style={{ ...td, fontWeight: 700, color: pnlColor(g.net, isDark) }}>{fmt(g.net)}</td>
                  </tr>

                  {open && (
                    <tr>
                      <td colSpan={7} style={{ padding: '0 8px 12px 22px', background: isDark ? '#0f172a' : '#f8fafc' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                          <thead>
                            <tr>
                              <th style={{ ...th, textAlign: 'left' }}>Strike</th>
                              <th style={{ ...th, textAlign: 'left' }}>Expiry</th>
                              <th style={{ ...th, textAlign: 'left' }}>Bought</th>
                              <th style={th}>Qty</th>
                              <th style={th}>Paid</th>
                              <th style={th}>Back</th>
                              <th style={th}>Net</th>
                              <th style={{ ...th, textAlign: 'left' }}>Outcome</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.map(c => (
                              <tr key={c.symbol}>
                                <td style={{ ...td, textAlign: 'left' }}>${c.strike}</td>
                                <td style={{ ...td, textAlign: 'left', color: muted }}>{fmtDate(c.expiry)}</td>
                                <td style={{ ...td, textAlign: 'left', color: muted }}>{fmtDate(c.firstBuy)}</td>
                                <td style={td}>{c.bought}</td>
                                <td style={td}>{fmt(c.paid)}</td>
                                <td style={td}>{fmt(c.proceeds)}</td>
                                <td style={{ ...td, fontWeight: 600, color: pnlColor(c.net, isDark) }}>{fmt(c.net)}</td>
                                <td style={{ ...td, textAlign: 'left', fontSize: 11, color: muted }}>{c.outcome}</td>
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

      <div style={{ fontSize: 11, color: muted, marginTop: 10, lineHeight: 1.5 }}>
        Net counts only contracts that reached an outcome — anything still held is excluded rather than
        marked, so no stale LEAP price can reach these figures. An expired contract isn't necessarily a
        bad one: insurance that was never needed expires worthless by design, and the strikes above are
        what separate that from a bet that didn't come in.
      </div>
    </div>
  )
}
