import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${m}/${d}/${y.slice(2)}`
}
const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'))

// "9/18 · 8d · monthly" — the days matter more than the date here, and counting
// them off a calendar is exactly the step that gets skipped.
const expiryLabel = (m) => [
  fmtDate(m.date),
  m.dte <= 0 ? 'today' : `${m.dte}d`,
  m.monthly ? 'monthly' : null,
].filter(Boolean).join(' · ')

/**
 * How far either side of spot is worth showing, as a fraction.
 *
 * A strike price cannot reach inside the life of the contract is not a level,
 * and on a one-day chain most of the chain is exactly that: open interest sits
 * there, but with no time left it carries no delta and nobody hedges against
 * it. The band grows with the square root of the days left, the way a price
 * range does — about 4% at a day, 13% at a week and a half, 25% at a month.
 */
const strikeBand = (dte) =>
  dte == null ? 0.4 : Math.min(0.5, Math.max(0.04, 0.045 * Math.sqrt(Math.max(dte, 0.5))))

/**
 * Open interest by strike, with spot marked.
 *
 * The convention is that heavy call open interest above the price acts as
 * resistance and heavy put open interest below it as support. This shows where
 * the positioning actually sits and stops there — it is a picture of what other
 * people are holding, not a forecast, and dressing it up as a signal would be
 * claiming something the data does not support.
 *
 * Bars are scaled against the largest strike in the chain rather than each
 * half separately, so calls and puts stay comparable to each other.
 */
export default function OpenInterestPanel() {
  const { isDark } = useTheme()
  const [ticker, setTicker] = useState('')
  const [input, setInput] = useState('')
  const [expiry, setExpiry] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = (t, e) => {
    if (!t) return
    setLoading(true); setError('')
    const qs = new URLSearchParams({ ticker: t })
    if (e) qs.set('expiry', e)
    fetch(`/api/open-interest?${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setData(d); setLoading(false)
        // The server picks the expiry when none was asked for, skipping a chain
        // that expires before the next session. Adopt what came back rather
        // than assuming the request decided it.
        if (d.expiry) setExpiry(d.expiry)
      })
      .catch(err => { setError(err.message); setLoading(false) })
  }

  useEffect(() => { if (ticker) load(ticker, expiry) }, [ticker])

  // The user's own contracts on this expiry, by strike — so a hedge can be read
  // against the walls instead of held in the head.
  const mine = useMemo(() => {
    const m = {}
    ;(data?.holdings || []).forEach(h => { (m[h.strike] = m[h.strike] || []).push(h) })
    return m
  }, [data])

  const maxOi = useMemo(
    () => Math.max(1, ...(data?.strikes || []).map(s => Math.max(s.callOi, s.putOi))),
    [data])

  // Only the strikes worth looking at: a chain runs to strikes nobody holds,
  // and the reachable range narrows sharply as the expiry approaches.
  const shown = useMemo(() => {
    const all = data?.strikes || []
    const spot = data?.spot
    if (!spot) return all.filter(s => s.totalOi > 0)
    const band = strikeBand(data?.dte)
    return all.filter(s => s.totalOi > 0
      && s.strike > spot * (1 - band) && s.strike < spot * (1 + band))
  }, [data])

  const card = {
    background: isDark ? '#1e293b' : '#fff',
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    borderRadius: 8, padding: 16, marginBottom: 16,
  }
  const muted = isDark ? '#94a3b8' : '#64748b'
  const th = {
    padding: '6px 8px', fontSize: 11, fontWeight: 500, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: isDark ? '#fff' : '#0f172a',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, whiteSpace: 'nowrap',
  }
  const td = { padding: '4px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums', color: isDark ? '#e2e8f0' : '#0f172a' }

  const submit = (e) => { e.preventDefault(); const t = input.trim().toUpperCase(); if (t) { setExpiry(''); setTicker(t) } }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: isDark ? '#fff' : '#0f172a' }}>Open Interest</h3>
        <span style={{ fontSize: 12, color: muted }}>where the positioning sits by strike</span>

        <form onSubmit={submit} style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ticker…"
            style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 6, width: 100, textTransform: 'uppercase',
              border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
              background: isDark ? '#0f172a' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a',
            }} />
          {data?.expiryMeta?.length > 0 && (
            <select value={expiry} onChange={e => { setExpiry(e.target.value); load(ticker, e.target.value) }}
              style={{
                fontSize: 12, padding: '5px 8px', borderRadius: 6,
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: isDark ? '#0f172a' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a',
              }}>
              {data.expiryMeta.map(m => (
                <option key={m.date} value={m.date}>{expiryLabel(m)}</option>
              ))}
            </select>
          )}
          <button type="submit" className="btn btn-sm" style={{
            fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
            background: isDark ? '#334155' : '#e2e8f0', color: isDark ? '#e2e8f0' : '#0f172a',
          }}>Load</button>
        </form>
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ color: muted, fontSize: 13 }}>Loading chain…</div>}
      {!data && !loading && !error && (
        <div style={{ color: muted, fontSize: 13 }}>Enter a ticker to see its open interest by strike.</div>
      )}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
            <div style={{ padding: '10px 12px', borderRadius: 6, background: isDark ? '#0f172a' : '#f8fafc', border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}` }}>
              <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>Resistance — call OI above {data.spot ? `$${data.spot.toFixed(2)}` : 'spot'}</div>
              {data.resistance?.length
                ? data.resistance.map(s => (
                    <div key={s.strike} style={{ fontSize: 13, color: isDark ? '#e2e8f0' : '#0f172a' }}>
                      <strong>${s.strike}</strong> <span style={{ color: muted }}>{num(s.callOi)} calls</span>
                    </div>
                  ))
                : <div style={{ fontSize: 12, color: muted }}>—</div>}
            </div>
            <div style={{ padding: '10px 12px', borderRadius: 6, background: isDark ? '#0f172a' : '#f8fafc', border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}` }}>
              <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>Support — put OI below {data.spot ? `$${data.spot.toFixed(2)}` : 'spot'}</div>
              {data.support?.length
                ? data.support.map(s => (
                    <div key={s.strike} style={{ fontSize: 13, color: isDark ? '#e2e8f0' : '#0f172a' }}>
                      <strong>${s.strike}</strong> <span style={{ color: muted }}>{num(s.putOi)} puts</span>
                    </div>
                  ))
                : <div style={{ fontSize: 12, color: muted }}>—</div>}
            </div>
          </div>

          <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'right' }}>Calls</th>
                  <th style={{ ...th, textAlign: 'center', width: 90 }}>Strike</th>
                  <th style={{ ...th, textAlign: 'left' }}>Puts</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(s => {
                  const near = data.spot && Math.abs(s.strike - data.spot) < (data.spot * 0.012)
                  return (
                    <tr key={s.strike} style={near ? { background: isDark ? '#292524' : '#fffbeb' } : undefined}>
                      {/* Bars scaled to the whole chain, so the two sides stay comparable. */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', width: '100%' }}>
                          {/* Volume under the count, because open interest alone
                              cannot tell a level being traded today from one
                              established weeks ago and left there. */}
                          <span style={{ color: muted, fontSize: 11, lineHeight: 1.25 }}>
                            <span style={{ display: 'block' }}>
                              {s.callOi ? num(s.callOi) : ''}
                              {s.callOiChange ? <span style={{ color: s.callOiChange > 0 ? '#22c55e' : '#ef4444', marginLeft: 3 }}>
                                {s.callOiChange > 0 ? '+' : ''}{num(s.callOiChange)}
                              </span> : null}
                            </span>
                            {s.callVol ? <span style={{ display: 'block', fontSize: 9, opacity: 0.8 }}>vol {num(s.callVol)}</span> : null}
                          </span>
                          <span style={{ display: 'inline-block', height: 10, borderRadius: 2, background: '#22c55e', width: `${(s.callOi / maxOi) * 140}px` }} />
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontWeight: near ? 700 : 500 }}>
                        ${s.strike}
                        {near && <span style={{ fontSize: 9, color: muted, display: 'block' }}>spot</span>}
                        {mine[s.strike]?.map((h, i) => (
                          <span key={i} title={`You hold ${h.contracts} ${h.side} ${h.type}${h.contracts === 1 ? '' : 's'} here`}
                            style={{
                              display: 'block', fontSize: 9, fontWeight: 700,
                              color: h.side === 'long' ? '#3b82f6' : '#f59e0b',
                            }}>
                            {h.side === 'long' ? '+' : '-'}{h.contracts}{h.type === 'call' ? 'C' : 'P'}
                          </span>
                        ))}
                      </td>
                      <td style={{ ...td, textAlign: 'left' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ display: 'inline-block', height: 10, borderRadius: 2, background: '#ef4444', width: `${(s.putOi / maxOi) * 140}px` }} />
                          <span style={{ color: muted, fontSize: 11, lineHeight: 1.25 }}>
                            <span style={{ display: 'block' }}>
                              {s.putOi ? num(s.putOi) : ''}
                              {s.putOiChange ? <span style={{ color: s.putOiChange > 0 ? '#22c55e' : '#ef4444', marginLeft: 3 }}>
                                {s.putOiChange > 0 ? '+' : ''}{num(s.putOiChange)}
                              </span> : null}
                            </span>
                            {s.putVol ? <span style={{ display: 'block', fontSize: 9, opacity: 0.8 }}>vol {num(s.putVol)}</span> : null}
                          </span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: muted, marginTop: 10, lineHeight: 1.5 }}>
            {data.contracts} contracts · {num(data.totals?.callOi)} call OI · {num(data.totals?.putOi)} put OI
            {data.priorDate ? ` · change vs ${fmtDate(data.priorDate)}` : ' · no earlier reading yet, so no change shown'}.
            Blue marks contracts you hold long, amber short. Volume is today's trading at that
            strike — high open interest with little volume is positioning left from earlier, not a
            level being defended now.
            Heavy call interest above the price is read as resistance and heavy put interest below it as
            support. That is a description of where positioning sits, not a forecast — a large block far
            from the money is often one holder's hedge rather than a level anyone trades around.
            {data.dte != null && data.dte <= 1 && (
              <> This chain expires {data.dte <= 0 ? 'today' : 'tomorrow'}, so its walls describe where
              the stock settles at that close and nothing after it — the whole chain is gone by the next
              session. For levels that outlive this week, pick a later expiry{' '}
              {data.expiryMeta?.some(m => m.monthly && m.dte > 1) ? '— the monthly carries the most' : ''}.</>
            )}
            {data.truncated && (
              <> This chain is longer than the data feed returns in one read, so some strikes are missing
              rather than empty.</>
            )}
          </div>
        </>
      )}
    </div>
  )
}
