import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { pairSpreads } from '../utils/pairSpreads'
import { impliedVol, probKeepCredit, yearsTo, RISK_FREE } from '../utils/optionMath'

const fmt = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return n < 0 ? `-$${abs}` : `$${abs}`
}
const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}
const r2 = n => Math.round(n * 100) / 100
const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = String(s).split('-')
  return `${Number(m)}/${Number(d)}`
}
const daysTo = (s) => {
  if (!s) return null
  const t = new Date(`${s}T16:00:00Z`).getTime() - Date.now()
  return Math.ceil(t / 86400000)
}

/**
 * Open verticals, valued as one position each.
 *
 * A spread only existed here after it closed: while it was open its two legs
 * sat apart in Open P&L, so the thing you actually put on — a credit, a width,
 * a defined worst case — had no row anywhere. Knowing a short 78 put is worth
 * -$267 tells you very little; knowing the 77/78 took $57.90 in, costs $93 to
 * get out of, and cannot lose more than $42.10 tells you the trade.
 *
 * Pairing is done here rather than on the server because the open-positions
 * endpoint already carries everything needed: both legs, their marks, their
 * cost and the underlying. Nothing on the server changes, so no figure
 * anywhere else can move.
 */
export default function SpreadsPanel({ broker = 'all' }) {
  const { isDark } = useTheme()
  const [positions, setPositions] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSingles, setShowSingles] = useState(false)
  const [holdings, setHoldings] = useState([])
  const [divs, setDivs] = useState({ map: {}, unavailable: null })

  useEffect(() => {
    setLoading(true); setError(null)
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/options-pnl/open-positions${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d?.success) throw new Error(d?.error || 'Could not load open positions')
        setPositions(d.positions || [])
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
    // Shares are fetched separately because a spread's P&L alone doesn't say
    // whether the trade did its job. A spread that lost because the stock ran
    // through the range only lost while the shares behind it gained.
    fetch(`/api/stock-positions-with-prices${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setHoldings(d?.holdings || []))
      .catch(() => setHoldings([]))
  }, [broker])

  const { spreads: rawSpreads, singles } = useMemo(() => pairSpreads(positions), [positions])

  /**
   * Two extra readings per spread.
   *
   * `captured` is how much of the credit is already banked — the number that
   * says a side has gone cheap and can be taken off, which is how these are
   * actually closed: one leg at a time, whichever the market hands you first.
   *
   * `prob` is the risk-neutral chance the short strike is never breached, so
   * the whole credit is kept. Implied vol is backed out of the short leg's own
   * mark, so it is the market's own number rather than an assumption. It
   * replaces counting outcomes: "up, flat or down" sounds like two chances in
   * three, but the three are not equally likely and their real weights are
   * knowable.
   */
  const spreads = useMemo(() => rawSpreads.map(s => {
    const T = yearsTo(s.expiry)
    const sigma = (s.stock > 0 && s.shortMark > 0 && T > 0)
      ? impliedVol(s.shortMark, s.stock, s.shortStrike, T, RISK_FREE, s.type)
      : null
    // Early assignment is not random. The holder of your short leg gives up
    // its remaining extrinsic value the moment they exercise, so they don't —
    // until there is none left to give up. In the money with the extrinsic
    // worn away is the state that gets assigned, and it is visible days ahead.
    const intrinsic = s.type === 'call'
      ? Math.max(0, (s.stock || 0) - s.shortStrike)
      : Math.max(0, s.shortStrike - (s.stock || 0))
    const itm = intrinsic > 0
    const extrinsic = (s.shortMark != null && s.stock > 0) ? r2(s.shortMark - intrinsic) : null
    const assignRisk = !itm ? 'none'
      : extrinsic == null ? 'unknown'
      : extrinsic <= 0.10 ? 'high'
      : extrinsic <= 0.35 ? 'watch'
      : 'low'
    return {
      ...s,
      captured: s.credit > 0 ? s.pnl / s.credit : null,
      prob: sigma ? probKeepCredit(s.stock, s.shortStrike, T, sigma, s.type) : null,
      iv: sigma,
      itm, intrinsic: r2(intrinsic), extrinsic, assignRisk,
      dte: Math.ceil(T * 365.25),
    }
  }), [rawSpreads])

  // Anything in the money is worth seeing before it is assigned rather than
  // after; assignment lands stock on you mid-move, which is the worst time.
  const atRisk = useMemo(
    () => spreads.filter(s => s.assignRisk === 'high' || s.assignRisk === 'watch')
      .sort((a, b) => (a.extrinsic ?? 9) - (b.extrinsic ?? 9)),
    [spreads])

  // Ex-dividend dates, only for the names that could actually be assigned over
  // one. Fetched after the spreads resolve because the ticker list comes from
  // them, and only for short calls — a dividend gives nobody a reason to
  // exercise a put early.
  const divTickers = useMemo(() => [...new Set(
    spreads.filter(s => s.type === 'call' && s.itm).map(s => s.ticker)
  )].sort().join(','), [spreads])

  useEffect(() => {
    if (!divTickers) { setDivs({ map: {}, unavailable: null }); return }
    fetch(`/api/upcoming-dividends?tickers=${encodeURIComponent(divTickers)}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setDivs({ map: d?.dividends || {}, unavailable: d?.unavailable || null }))
      .catch(e => setDivs({ map: {}, unavailable: e.message }))
  }, [divTickers])

  /**
   * A dividend worth more than the call's remaining time value makes early
   * exercise the rational move for whoever holds it — they take the shares to
   * collect the dividend, and the day before the ex-date is when they do it.
   * That turns a gradual risk into a specific date.
   */
  const divRisk = (s) => {
    if (s.type !== 'call' || !s.itm) return null
    const d = divs.map[s.ticker]
    if (!d?.exDate || !(d.amount > 0)) return null
    if (d.exDate > s.expiry) return null       // the option is gone before it matters
    const days = Math.ceil((new Date(`${d.exDate}T20:00:00Z`) - Date.now()) / 86400000)
    return { ...d, days, beats: s.extrinsic != null && d.amount > s.extrinsic }
  }

  /**
   * A call spread and a put spread on the same name and expiry are one
   * position: the stock is being dared to stay between the two short strikes.
   *
   * Both credits are collected but only one side can lose at expiry, so each
   * tail is that side's width less BOTH credits — which is why the tails are
   * smaller than either spread alone suggests. The chance of keeping
   * everything is P(call side safe) + P(put side safe) - 1, and it is
   * materially lower than either side on its own.
   */
  const condors = useMemo(() => {
    const byKey = new Map()
    for (const s of spreads) {
      const k = `${s.ticker}|${s.expiry}`
      const e = byKey.get(k) || { ticker: s.ticker, expiry: s.expiry, calls: [], puts: [] }
      ;(s.type === 'call' ? e.calls : e.puts).push(s)
      byKey.set(k, e)
    }
    const out = []
    for (const e of byKey.values()) {
      if (!e.calls.length || !e.puts.length) continue
      const c = e.calls[0], p = e.puts[0]
      const credit = r2(e.calls.reduce((a, x) => a + x.credit, 0) + e.puts.reduce((a, x) => a + x.credit, 0))
      const pnl = r2(e.calls.reduce((a, x) => a + x.pnl, 0) + e.puts.reduce((a, x) => a + x.pnl, 0))
      const upTail = r2(c.width - credit)
      const downTail = r2(p.width - credit)
      const inside = (c.prob != null && p.prob != null) ? Math.max(0, c.prob + p.prob - 1) : null
      out.push({
        ticker: e.ticker, expiry: e.expiry, credit, pnl,
        lo: p.shortStrike, hi: c.shortStrike, stock: c.stock ?? p.stock,
        upTail, downTail, inside,
        callProb: c.prob, putProb: p.prob,
      })
    }
    return out.sort((a, b) => (a.expiry < b.expiry ? -1 : 1))
  }, [spreads])

  /**
   * Per ticker: the spread, and whatever is standing behind it.
   *
   * These are never put on naked — there are shares underneath or puts against
   * the move. So a spread's own P&L is half the story: when the stock breaks
   * through the range and the spread gives back $50, the shares or the puts
   * made money on the same move. Reading the spread alone shows the loss and
   * hides the reason it was acceptable.
   *
   * A spread with nothing behind it is called out, because by that rule it
   * shouldn't exist — it usually means the shares were called away or the puts
   * expired and the hedge quietly disappeared.
   */
  const backing = useMemo(() => {
    const byTicker = new Map()
    for (const s of spreads) {
      const e = byTicker.get(s.ticker) || { ticker: s.ticker, spreadPnl: 0, n: 0, otherPnl: 0, puts: 0, calls: 0 }
      e.spreadPnl = r2(e.spreadPnl + s.pnl); e.n += 1
      byTicker.set(s.ticker, e)
    }
    // Option legs not consumed by a spread, on a ticker that has one.
    for (const p of singles) {
      const e = byTicker.get(p.ticker)
      if (!e) continue
      if (p.remainingPnl != null) e.otherPnl = r2(e.otherPnl + p.remainingPnl)
      if (p.optionType === 'put') e.puts += p.remaining
      else e.calls += p.remaining
    }
    const rows = []
    for (const e of byTicker.values()) {
      const h = holdings.find(x => x.symbol === e.ticker)
      const shares = h?.position > 0 ? h.position : 0
      const stockPnl = h?.unrealizedPnL ?? null
      const combined = r2(e.spreadPnl + e.otherPnl + (stockPnl || 0))
      rows.push({
        ...e, shares, stockPnl, combined,
        // Nothing underneath and nothing against it.
        unbacked: shares === 0 && e.puts === 0,
        // The case worth seeing: the spread is down, the rest is up.
        offset: e.spreadPnl < 0 && (e.otherPnl + (stockPnl || 0)) > 0,
      })
    }
    return rows.sort((a, b) => a.ticker.localeCompare(b.ticker))
  }, [spreads, singles, holdings])

  const totals = useMemo(() => spreads.reduce((t, s) => ({
    credit: r2(t.credit + s.credit),
    nowCost: r2(t.nowCost + s.nowCost),
    pnl: r2(t.pnl + s.pnl),
    maxLoss: r2(t.maxLoss + s.maxLoss),
    unpriced: t.unpriced + (s.priced ? 0 : 1),
  }), { credit: 0, nowCost: 0, pnl: 0, maxLoss: 0, unpriced: 0 }), [spreads])

  const text = isDark ? '#f1f5f9' : '#0f172a'
  const muted = isDark ? '#94a3b8' : '#64748b'
  const border = isDark ? '#334155' : '#e2e8f0'
  const card = {
    background: isDark ? '#1e2130' : '#ffffff', border: `1px solid ${border}`,
    borderRadius: 10, padding: '14px 16px', marginBottom: 16,
  }
  // Light grey, fixed rather than theme-dependent: index.css paints every
  // <thead> with a purple gradient that is the same in both themes, so a
  // header colour chosen against the card behind it is simply wrong. Dark text
  // on purple was the real unreadability here — not the size, which is what
  // the first two attempts at this chased.
  const th = {
    textAlign: 'right', padding: '7px 8px', fontSize: 12, color: '#e2e8f0', whiteSpace: 'nowrap',
    fontWeight: 600, borderBottom: `1px solid ${border}`,
  }
  const td = { textAlign: 'right', padding: '6px 8px', fontSize: 13, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }

  if (loading) return <div style={card}>Loading open spreads…</div>
  if (error) return <div style={{ ...card, color: '#ef4444' }}>Couldn’t load spreads: {error}</div>

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: text }}>Open spreads</h3>
        <span style={{ fontSize: 12, color: muted }}>
          {spreads.length} vertical{spreads.length === 1 ? '' : 's'}
          {broker !== 'all' ? ` · ${broker}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12, color: muted }}>
            Open P&L{' '}
            <strong style={{ fontSize: 15, color: pnlColor(totals.pnl, isDark) }}>{fmt(totals.pnl)}</strong>
          </span>
          <span style={{ fontSize: 12, color: muted }}
                title="If every one of these went fully against you. The most these positions can lose, by construction — that is what a defined-risk trade buys you.">
            Worst case{' '}
            <strong style={{ fontSize: 15, color: '#ef4444' }}>{fmt(-totals.maxLoss)}</strong>
          </span>
        </span>
      </div>

      {atRisk.length > 0 && (
        <div style={{
          border: `1px solid ${atRisk.some(s => s.assignRisk === 'high') ? '#ef4444' : '#f59e0b'}`,
          background: isDark ? '#2a1409' : '#fffbeb', borderRadius: 8,
          padding: '10px 12px', marginBottom: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: atRisk.some(s => s.assignRisk === 'high') ? '#ef4444' : '#b45309', marginBottom: 4 }}>
            {atRisk.length} short leg{atRisk.length === 1 ? '' : 's'} in the money — assignment watch
          </div>
          {atRisk.map((s, i) => {
            const dv = divRisk(s)
            return (
              <div key={i} style={{ fontSize: 12, color: text, padding: '2px 0' }}>
                <strong>{s.ticker} {s.type === 'put' ? 'Put' : 'Call'} ${s.shortStrike}</strong>
                <span style={{ color: muted }}> ×{s.n} · {fmtDate(s.expiry)} ({s.dte <= 0 ? 'today' : `${s.dte}d`})</span>
                {' — '}
                <span style={{ color: s.assignRisk === 'high' ? '#ef4444' : '#b45309', fontWeight: 600 }}>
                  {fmt(s.extrinsic)}/sh time value left
                </span>
                <span style={{ color: muted }}>
                  {s.assignRisk === 'high'
                    ? ' · almost none — assignment is rational now'
                    : ' · thinning'}
                </span>
                {dv && (
                  <div style={{ fontSize: 11, paddingLeft: 12, marginTop: 1,
                    color: dv.beats ? '#ef4444' : muted, fontWeight: dv.beats ? 600 : 400 }}
                    title={dv.beats
                      ? `The ${fmt(dv.amount)} dividend is worth more than the ${fmt(s.extrinsic)} of time value left, so exercising to collect it pays. Expect assignment the day before ${dv.exDate}.`
                      : `The ${fmt(dv.amount)} dividend is less than the ${fmt(s.extrinsic)} of time value left, so exercising early would cost the holder more than the dividend is worth.`}>
                    ↳ goes ex-dividend {fmtDate(dv.exDate)}
                    {dv.days >= 0 ? ` (${dv.days === 0 ? 'today' : `${dv.days}d`})` : ''}
                    {' · '}{fmt(dv.amount)}/sh
                    {dv.beats
                      ? ' — beats the time value left, so early exercise pays. Assignment likely the day before.'
                      : ' — smaller than the time value left, so not yet a reason to exercise.'}
                  </div>
                )}
              </div>
            )
          })}
          {divs.unavailable && atRisk.some(s => s.type === 'call') && (
            <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
              Ex-dividend dates unavailable ({divs.unavailable}), so the dividend trigger isn't
              being checked — treat in-the-money short calls as riskier than they look here.
            </div>
          )}
          <div style={{ fontSize: 11, color: muted, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${border}`, lineHeight: 1.5 }}>
            Whoever holds your short leg forfeits its remaining time value the moment they exercise,
            so they wait until there is none left. That makes this predictable: the number above
            falling toward zero is the warning, not the assignment itself.
            <br />
            <strong style={{ color: text }}>Rolling out costs less than being assigned</strong> — closing
            the short and reselling a later expiry keeps the position and pays you new time value.
            Assignment instead hands you the stock (or takes it), turns a defined-risk spread into a
            share position mid-move, and leaves the long leg stranded on its own.
          </div>
        </div>
      )}

      {spreads.length === 0 ? (
        <div style={{ fontSize: 13, color: muted }}>
          No open verticals — a spread here means a short and a long of the same underlying,
          expiry and type held at once.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Spread</th>
                <th style={{ ...th, textAlign: 'left' }}>Expires</th>
                <th style={th}>Qty</th>
                <th style={th} title="What you took in to open it, or paid if this is a debit spread.">Credit</th>
                <th style={th} title="What it would cost to close both legs at today's marks.">To close</th>
                <th style={th}>Open P&L</th>
                <th style={th} title="How much of the credit is already banked. A high number means the side has gone cheap and can be taken off for little — 100% would be the whole credit kept.">Captured</th>
                <th style={th} title="The market's own odds that the short strike is never breached, so the full credit is kept. Implied vol is backed out of this spread's own short-leg mark.">Odds kept</th>
                <th style={th} title="The most this can still make, and the most it can still lose. Fixed by the width of the strikes.">Max win / loss</th>
                <th style={{ ...th, textAlign: 'left' }}>Stock</th>
              </tr>
            </thead>
            <tbody>
              {spreads.map((s, i) => {
                const dte = daysTo(s.expiry)
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${border}` }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600, color: text }}>
                      {s.ticker}{' '}
                      <span style={{ color: muted, fontWeight: 400 }}>
                        {s.type === 'put' ? 'Put' : 'Call'} {s.lo}/{s.hi}
                      </span>
                      {!s.priced && <span style={{ color: '#f59e0b', fontSize: 10 }}> unpriced</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'left', color: muted }}>
                      {fmtDate(s.expiry)}
                      {dte != null && <span style={{ fontSize: 11 }}> · {dte <= 0 ? 'today' : `${dte}d`}</span>}
                    </td>
                    <td style={{ ...td, color: muted }}>{s.n}</td>
                    <td style={{ ...td, color: pnlColor(s.credit, isDark) }}>{fmt(s.credit)}</td>
                    <td style={{ ...td, color: text }}>{fmt(s.nowCost)}</td>
                    <td style={{ ...td, fontWeight: 700, color: pnlColor(s.pnl, isDark) }}>{fmt(s.pnl)}</td>
                    <td style={{ ...td, fontSize: 12, fontWeight: s.captured >= 0.7 ? 700 : 400,
                      color: s.captured == null ? muted : s.captured >= 0.7 ? '#22c55e' : s.captured < 0 ? '#ef4444' : text }}
                      title={s.captured == null ? 'Debit spread — no credit to capture.'
                        : `${fmt(s.pnl)} of the ${fmt(s.credit)} credit is banked. Closing now costs ${fmt(s.nowCost)}.`
                          + (s.captured >= 0.7 ? '\n\nMost of the credit is already in. Little left to gain by holding.' : '')}>
                      {s.captured == null ? '—' : `${Math.round(s.captured * 100)}%`}
                      {s.captured >= 0.7 && (
                        <div style={{ fontSize: 10, fontWeight: 500 }}>cheap to close</div>
                      )}
                    </td>
                    <td style={{ ...td, fontSize: 12, color: s.prob == null ? muted : text }}
                      title={s.prob == null ? 'No usable mark on the short leg, so implied vol could not be backed out.'
                        : `${Math.round(s.prob * 100)}% chance the stock finishes on the safe side of your $${s.shortStrike} short strike`
                          + `, at the market's implied vol of ${(s.iv * 100).toFixed(0)}%.`
                          + `\n\nRisk-neutral: the market's odds, not a forecast.`}>
                      {s.prob == null ? '—' : `${Math.round(s.prob * 100)}%`}
                    </td>
                    <td style={{ ...td, fontSize: 12 }}>
                      <span style={{ color: '#22c55e' }}>{fmt(s.maxProfit)}</span>
                      <span style={{ color: muted }}> / </span>
                      <span style={{ color: '#ef4444' }}>{fmt(-s.maxLoss)}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'left', fontSize: 12, color: muted }}>
                      {s.stock != null ? `$${s.stock.toFixed(2)}` : '—'}
                      {s.breached && (
                        <span style={{ color: '#f59e0b', fontWeight: 700 }}
                              title={`The short ${s.shortStrike} is in the money — this spread is working against you.`}>
                          {' '}· short {s.shortStrike} ITM
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
              <tr>
                <td colSpan={3} style={{ ...td, textAlign: 'left', color: muted, fontWeight: 600 }}>Total</td>
                <td style={{ ...td, fontWeight: 700, color: pnlColor(totals.credit, isDark) }}>{fmt(totals.credit)}</td>
                <td style={{ ...td, fontWeight: 700, color: text }}>{fmt(totals.nowCost)}</td>
                <td style={{ ...td, fontWeight: 800, color: pnlColor(totals.pnl, isDark) }}>{fmt(totals.pnl)}</td>
                <td />
                <td />
                <td style={{ ...td, fontWeight: 700, color: '#ef4444' }}>{fmt(-totals.maxLoss)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {condors.length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: text, marginBottom: 2 }}>
            Both sides together
          </div>
          <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>
            A call spread and a put spread on the same name and expiry are one position: the stock
            is dared to stay between the two short strikes. Both credits are collected but only one
            side can lose, so each tail is that side's width less <em>both</em> credits.
          </div>
          {condors.map((c, i) => {
            const inRange = c.stock > 0 && c.stock >= c.lo && c.stock <= c.hi
            return (
              <div key={i} style={{
                border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8,
              }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 }}>
                  <strong style={{ fontSize: 13, color: text }}>{c.ticker}</strong>
                  <span style={{ fontSize: 12, color: muted }}>expires {fmtDate(c.expiry)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: muted }}>
                    Open P&L <strong style={{ fontSize: 14, color: pnlColor(c.pnl, isDark) }}>{fmt(c.pnl)}</strong>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12 }}>
                  <span style={{ color: muted }}>
                    Safe range{' '}
                    <strong style={{ color: inRange ? '#22c55e' : '#f59e0b' }}>
                      ${c.lo} – ${c.hi}
                    </strong>
                    {c.stock > 0 && (
                      <span style={{ color: inRange ? muted : '#f59e0b' }}>
                        {' '}· stock ${c.stock.toFixed(2)}{inRange ? ' (inside)' : ' (outside)'}
                      </span>
                    )}
                  </span>
                  <span style={{ color: muted }}>
                    Total credit <strong style={{ color: '#22c55e' }}>{fmt(c.credit)}</strong>
                  </span>
                  <span style={{ color: muted }}
                    title="If the stock runs up through the call side. That side's width less both credits, because the put side expires worthless and its credit is kept.">
                    Up tail <strong style={{ color: '#ef4444' }}>{fmt(-c.upTail)}</strong>
                  </span>
                  <span style={{ color: muted }}
                    title="If the stock falls through the put side. Same arithmetic on the other wing — and if you hold shares, they are falling with it.">
                    Down tail <strong style={{ color: '#ef4444' }}>{fmt(-c.downTail)}</strong>
                  </span>
                </div>
                {c.inside != null && (
                  <div style={{ fontSize: 11, color: muted, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${border}` }}>
                    Odds it finishes inside the range and both credits are kept:{' '}
                    <strong style={{ color: text, fontSize: 12 }}>{Math.round(c.inside * 100)}%</strong>
                    <span style={{ color: muted }}>
                      {' '}— the call side alone is {Math.round(c.callProb * 100)}% and the put side{' '}
                      {Math.round(c.putProb * 100)}%, but both must hold, so the combined figure is
                      lower than either.
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {backing.length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: text, marginBottom: 2 }}>
            What's behind each spread
          </div>
          <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>
            A spread that loses because the stock ran through the range only lost while the
            shares or puts on the same name were making money. Here they are side by side.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
                  <th style={th}>Spread</th>
                  <th style={{ ...th, textAlign: 'left' }}>Behind it</th>
                  <th style={th}>Stock</th>
                  <th style={th}>Other options</th>
                  <th style={th}>Combined</th>
                </tr>
              </thead>
              <tbody>
                {backing.map(b => (
                  <tr key={b.ticker} style={{ borderBottom: `1px solid ${border}` }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600, color: text }}>
                      {b.ticker}
                      <span style={{ color: muted, fontWeight: 400, fontSize: 11 }}> ×{b.n}</span>
                    </td>
                    <td style={{ ...td, fontWeight: 600, color: pnlColor(b.spreadPnl, isDark) }}>{fmt(b.spreadPnl)}</td>
                    <td style={{ ...td, textAlign: 'left', fontSize: 12, color: muted }}>
                      {b.unbacked ? (
                        <span style={{ color: '#f59e0b', fontWeight: 600 }}
                          title="No shares and no puts on this name. You don't put these on naked, so this usually means the stock was called away or the puts expired and the hedge is gone.">
                          nothing — check this
                        </span>
                      ) : (
                        [b.shares > 0 ? `${b.shares} shares` : null,
                         b.puts > 0 ? `${b.puts} put${b.puts === 1 ? '' : 's'}` : null,
                         b.calls > 0 ? `${b.calls} call${b.calls === 1 ? '' : 's'}` : null]
                          .filter(Boolean).join(' · ')
                      )}
                    </td>
                    <td style={{ ...td, color: b.stockPnl == null ? muted : pnlColor(b.stockPnl, isDark) }}>
                      {b.stockPnl == null ? '—' : fmt(b.stockPnl)}
                    </td>
                    <td style={{ ...td, color: pnlColor(b.otherPnl, isDark) }}>
                      {b.otherPnl === 0 ? '—' : fmt(b.otherPnl)}
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: pnlColor(b.combined, isDark) }}>
                      {fmt(b.combined)}
                      {b.offset && (
                        <div style={{ fontSize: 10, color: '#22c55e', fontWeight: 500 }}
                          title="The spread is down but the stock and options behind it are up by more than it lost — the hedge did its job.">
                          covered
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {singles.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${border}`, paddingTop: 10 }}>
          <button onClick={() => setShowSingles(v => !v)}
            style={{ border: 'none', background: 'transparent', color: muted, cursor: 'pointer',
                     fontSize: 12, padding: 0 }}>
            {showSingles ? '▾' : '▸'} {singles.length} leg{singles.length === 1 ? '' : 's'} not in a spread
          </button>
          {showSingles && (
            <div style={{ marginTop: 6, fontSize: 12, color: muted, lineHeight: 1.7 }}>
              {singles.map((p, i) => (
                <div key={i}>
                  {p.ticker} {p.optionType === 'put' ? 'Put' : 'Call'} ${p.strike} · {fmtDate(p.expiry)}
                  {' · '}{p.isLong ? 'long' : 'short'} ×{p.remaining}
                  {!p.isLong && <strong style={{ color: '#f59e0b' }}> · uncovered by a long</strong>}
                  {p.unrealizedPnl != null && (
                    <span style={{ color: pnlColor(p.unrealizedPnl, isDark) }}> · {fmt(p.unrealizedPnl)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, color: muted, marginTop: 12, lineHeight: 1.5 }}>
        Each short is paired with the nearest long of the same underlying, expiry and type — the leg
        that actually caps the risk. Credit is what you took in; <em>to close</em> is what both legs
        would cost at today’s marks, so Open P&amp;L is the difference. Max win and loss are fixed by
        the width between the strikes and cannot change, which is the whole point of trading it as a
        spread rather than a naked short.
        {totals.unpriced > 0 && (
          <span style={{ color: '#f59e0b' }}> {totals.unpriced} spread(s) had a leg with no mark, so their value is incomplete.</span>
        )}
      </div>
    </div>
  )
}
