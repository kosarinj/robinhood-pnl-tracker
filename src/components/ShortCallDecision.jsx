import React, { useEffect, useMemo, useState } from 'react'
import { bsPrice, normCdf } from '../utils/optionMath'

/**
 * Leave it, close it, roll it — or roll it and buy a cheaper, shorter long call.
 *
 * Every strategy is scored the same way: total dollars kept on this short call
 * if you are flat at the horizon date, counting the premium already collected.
 * That puts "leave it" and "roll it" on one scale, which mark-to-market P&L
 * doesn't — a roll banks a credit today that holding only earns over time.
 *
 * Contracts are valued at the horizon with Black–Scholes at each contract's
 * implied vol today, held constant. Sales fill at the bid and purchases at the
 * ask when IBKR has a market; otherwise at the model price.
 */

const MOVES = [-0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.75]

const money = (n) => {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = Math.round(n)
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString()}`
}
const shortDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`
}
const keyOf = (c) => `${c.strike}|${c.expiry}`
const SOURCE = { ibkr: 'IBKR live', 'polygon-iv': 'est', close: 'est (close)', 'flat-iv': 'est (flat vol)' }

/**
 * How a price series moved over the same calendar window in earlier years.
 * Each year uses the last close on or before the shifted start and end dates,
 * and is skipped when the series doesn't reach back that far.
 */
function windowMoves(series, startIso, endIso, years = 10) {
  if (!series?.length) return []
  const closeOnOrBefore = (iso) => {
    let lo = 0, hi = series.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (series[mid][0] <= iso) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
  }
  const shift = (iso, k) => `${Number(iso.slice(0, 4)) - k}${iso.slice(4)}`
  const out = []
  for (let k = 1; k <= years; k++) {
    const a = shift(startIso, k), b = shift(endIso, k)
    if (a < series[0][0]) break
    const i = closeOnOrBefore(a), j = closeOnOrBefore(b)
    if (i < 0 || j <= i) continue
    out.push({ year: Number(a.slice(0, 4)), move: series[j][1] / series[i][1] - 1 })
  }
  return out
}

export default function ShortCallDecision({ entryId, isDark }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [rollKey, setRollKey] = useState(null)
  const [longKey, setLongKey] = useState(null)
  const [horizon, setHorizon] = useState('auto')

  useEffect(() => {
    let alive = true
    fetch(`/api/short-calls/${entryId}/decision`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => { if (!alive) return; j.success ? setData(j) : setError(j.error || 'Could not load') })
      .catch(e => alive && setError(e.message))
    return () => { alive = false }
  }, [entryId])

  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const GOOD = '#0ca30c'
  const CRIT = '#d03b3b'

  // Defaults: a roll about six months past the current expiry at the same
  // strike (else the biggest credit), and a hedge that expires before it and
  // costs little — the trade described when this was asked for.
  const defaults = useMemo(() => {
    if (!data) return {}
    const target = data.current.dte + 180
    const same = data.rolls.filter(r => r.strike === data.current.strike)
    const pool = same.length ? same : data.rolls
    const roll = [...pool].sort((a, b) => Math.abs(a.dte - target) - Math.abs(b.dte - target) || b.netCredit - a.netCredit)[0]
    return { roll: roll ? keyOf(roll) : 'none' }
  }, [data])

  const roll = data?.rolls.find(r => keyOf(r) === (rollKey ?? defaults.roll)) || null

  // Hedges must expire before the roll does ("shorter time frame").
  const longChoices = useMemo(() => {
    if (!data) return []
    const limit = roll ? roll.expiry : data.current.expiry
    return data.longs.filter(l => l.expiry < limit && l.dte >= 21)
  }, [data, roll])

  const defaultLong = useMemo(() => {
    if (!data || !longChoices.length) return 'none'
    // Most protection per dollar: payoff at a 40% rally three-quarters of the
    // way to its expiry, divided by cost, among contracts up to ~$150.
    const S = data.stock
    const cheap = longChoices.filter(l => l.ask * 100 <= 150)
    const pool = cheap.length ? cheap : longChoices
    let best = null, bestScore = -Infinity
    for (const l of pool) {
      const T = (l.dte * 0.25) / 365.25
      const v = bsPrice(S * 1.4, l.strike, T, data.riskFree, l.iv, 'call')
      const score = (v - l.ask) / Math.max(0.05, l.ask)
      if (score > bestScore) { bestScore = score; best = l }
    }
    return best ? keyOf(best) : 'none'
  }, [data, longChoices])

  const long = longChoices.find(l => keyOf(l) === (longKey ?? defaultLong)) || null

  const model = useMemo(() => {
    if (!data) return null
    const { stock: S, contracts: n, premiumPerShare: prem, current: cur, riskFree: r } = data
    const h = horizon === 'auto'
      ? (long ? long.dte : Math.min(60, cur.dte))
      : horizon === 'expiry' ? cur.dte : Number(horizon)
    const valueAt = (c, S1) => {
      const T = Math.max(0, c.dte - h) / 365.25
      return T > 0 ? bsPrice(S1, c.strike, T, r, c.iv, 'call') : Math.max(0, S1 - c.strike)
    }
    const x = 100 * n
    const strategies = [
      { key: 'hold', label: 'Leave it', at: S1 => (prem - valueAt(cur, S1)) * x },
      { key: 'close', label: 'Close now', at: () => (prem - cur.ask) * x },
    ]
    if (roll) strategies.push({
      key: 'roll', label: `Roll → $${roll.strike} ${shortDate(roll.expiry)}`,
      at: S1 => (prem - cur.ask + roll.bid - valueAt(roll, S1)) * x,
    })
    if (roll && long) strategies.push({
      key: 'rollLong', label: `Roll + long $${long.strike} ${shortDate(long.expiry)}`,
      at: S1 => (prem - cur.ask + roll.bid - valueAt(roll, S1) + valueAt(long, S1) - long.ask) * x,
    })

    // Chance the stock finishes ABOVE a price by the horizon, at the current
    // contract's implied vol — risk-neutral, so a guide to the market's
    // pricing rather than a forecast.
    const T = h / 365.25
    const sig = cur.iv
    const probAbove = (X) => (T > 0 && sig > 0)
      ? normCdf((Math.log(S / X) + (r - sig * sig / 2) * T) / (sig * Math.sqrt(T)))
      : (S > X ? 1 : 0)

    // Where the best alternative overtakes leaving it, scanned on a fine grid.
    const alt = strategies.find(s => s.key === 'rollLong') || strategies.find(s => s.key === 'roll')
    const hold = strategies[0]
    let crossings = []
    if (alt) {
      let prev = null
      for (let i = 0; i <= 400; i++) {
        const S1 = S * (0.4 + i * 0.005)
        const d = alt.at(S1) - hold.at(S1)
        const sign = d >= 0
        if (prev != null && sign !== prev) crossings.push({ price: S1, altBetterAbove: sign })
        prev = sign
      }
    }
    const altBetterNow = alt ? alt.at(S) >= hold.at(S) : false

    const probItm = (c) => {
      const Tc = c.dte / 365.25
      return Tc > 0 ? normCdf((Math.log(S / c.strike) + (r - c.iv * c.iv / 2) * Tc) / (c.iv * Math.sqrt(Tc))) : (S > c.strike ? 1 : 0)
    }

    return { h, strategies, probAbove, alt, hold, crossings, altBetterNow, probItm, x }
  }, [data, roll, long, horizon])

  if (error) return <div style={{ marginTop: 18, fontSize: 12, color: textMid }}>Roll analysis unavailable: {error}</div>
  if (!data || !model) return <div style={{ marginTop: 18, fontSize: 12, color: textMid }}>Loading roll analysis…</div>

  const { stock: S, current: cur, contracts: n, premiumPerShare: prem } = data
  const horizonDate = new Date(Date.now() + model.h * 86400000).toISOString().slice(0, 10)
  const stockSeason = windowMoves(data.seasonality?.stock, data.today, horizonDate)
  const marketSeason = windowMoves(data.seasonality?.market, data.today, horizonDate)
  // The scenario table gets a column for each of the stock's last three
  // same-window moves: "if it does what it did last year".
  const repeatCols = stockSeason.slice(0, 3).map(y => ({ move: y.move, label: `${y.year} repeat` }))
  const cols = [...MOVES.map(m => ({ move: m, label: m === 0 ? 'flat' : `${m > 0 ? '+' : ''}${Math.round(m * 100)}%` })), ...repeatCols]
  const pct = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(1)}%`
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
  const maxHold = prem * model.x
  const keptNow = (prem - cur.ask) * model.x
  const leftHold = maxHold - keptNow
  const select = {
    padding: '4px 6px', fontSize: 12, borderRadius: 6, border: `1px solid ${border}`,
    background: 'transparent', color: text, maxWidth: '100%',
  }

  // The plain-language read: which is ahead where the stock is now, and the
  // price at which that flips.
  const summary = (() => {
    if (!model.alt) return 'No roll found for a net credit at this strike or higher.'
    const name = model.alt.key === 'rollLong' ? 'Rolling with the long call' : 'Rolling'
    const c = model.crossings.filter(x => x.price > S * 0.5)
    if (!c.length) {
      return model.altBetterNow
        ? `${name} comes out ahead of leaving it at every stock price from −60% to +100% by ${shortDate(horizonDate)}.`
        : `Leaving it comes out ahead of ${name.toLowerCase()} at every stock price from −60% to +100% by ${shortDate(horizonDate)}.`
    }
    const parts = c.slice(0, 2).map(x => {
      const p = model.probAbove(x.price)
      return x.altBetterAbove
        ? `${name} pulls ahead if ${data.ticker} is above $${x.price.toFixed(0)} (≈${Math.round(p * 100)}% chance)`
        : `Leaving it is better only if ${data.ticker} is above $${x.price.toFixed(0)} (≈${Math.round(p * 100)}% chance)`
    })
    return `${parts.join('; ')} by ${shortDate(horizonDate)}. Today ${model.altBetterNow ? name.toLowerCase() + ' is ahead' : 'leaving it is ahead'} at $${S.toFixed(2)}.`
  })()

  const td = { padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: `1px solid ${border}`, color: text }}>
      <div style={{ fontSize: 14, fontWeight: 800 }}>Leave it or roll it?</div>

      {/* Where it stands */}
      <div style={{ fontSize: 12, color: textMid, marginTop: 4, lineHeight: 1.6 }}>
        Kept {money(keptNow)} of {money(maxHold)} ({maxHold > 0 ? Math.round(keptNow / maxHold * 100) : 0}%) ·{' '}
        {money(leftHold)} left over {cur.dte} days ({money(leftHold / Math.max(1, cur.dte))}/day) ·{' '}
        buy back at ${cur.ask.toFixed(2)} <span title="Where the buyback price comes from">({SOURCE[cur.source] || cur.source})</span> ·{' '}
        {Math.round(model.probItm(cur) * 100)}% chance it ends in the money
      </div>

      {/* Choices */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10, alignItems: 'center', fontSize: 12 }}>
        <label>Roll to{' '}
          <select style={select} value={rollKey ?? defaults.roll} onChange={e => setRollKey(e.target.value)}>
            <option value="none">— no roll —</option>
            {data.rolls.map(r => (
              <option key={keyOf(r)} value={keyOf(r)}>
                ${r.strike} {shortDate(r.expiry)} · +{money(r.netCredit * 100 * n)} credit{r.source === 'ibkr' ? ' · IBKR' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>Long call{' '}
          <select style={select} value={long ? keyOf(long) : 'none'} onChange={e => setLongKey(e.target.value)}>
            <option value="none">— none —</option>
            {longChoices.map(l => (
              <option key={keyOf(l)} value={keyOf(l)}>
                ${l.strike} {shortDate(l.expiry)} · {money(l.ask * 100 * n)}{l.source === 'ibkr' ? ' · IBKR' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>Judge at{' '}
          <select style={select} value={horizon} onChange={e => setHorizon(e.target.value)}>
            <option value="auto">{long ? 'long call expiry' : '60 days'}</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
            <option value="expiry">current expiry ({cur.dte}d)</option>
          </select>
        </label>
      </div>

      {/* The answer */}
      <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, lineHeight: 1.5,
                    background: isDark ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.08)', border: `1px solid ${isDark ? '#1e3a8a' : '#bfdbfe'}` }}>
        {summary}
      </div>

      {/* Seasonality — the same calendar window in earlier years. A pattern,
          not a forecast: it says what tended to happen, not what will. */}
      {(stockSeason.length > 0 || marketSeason.length > 0) && (
        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700 }}>Same window ({shortDate(data.today).slice(0, -3)} → {shortDate(horizonDate).slice(0, -3)}) in past years:</span>{' '}
          {stockSeason.length > 0 && (
            <span>
              {data.ticker}{' '}
              {stockSeason.map(y => (
                <span key={y.year} style={{ color: y.move >= 0 ? GOOD : CRIT, marginRight: 6 }}>{y.year} {pct(y.move)}</span>
              ))}
            </span>
          )}
          {marketSeason.length > 0 && (() => {
            const ups = marketSeason.filter(y => y.move > 0).length
            const lo = Math.min(...marketSeason.map(y => y.move)), hi = Math.max(...marketSeason.map(y => y.move))
            return (
              <span style={{ color: textMid }}
                title={marketSeason.map(y => `${y.year}: ${pct(y.move)}`).join('\n')}>
                · {data.seasonality.marketSymbol} up in {ups} of {marketSeason.length} years, median {pct(median(marketSeason.map(y => y.move)))}
                {' '}(range {pct(lo)} to {pct(hi)})
              </span>
            )
          })()}
          {stockSeason.length > 0 && stockSeason.length < 3 && (
            <span style={{ color: textMid }}> · only {stockSeason.length} year{stockSeason.length > 1 ? 's' : ''} of {data.ticker} history — one year is an anecdote, not a pattern</span>
          )}
        </div>
      )}

      {/* Scenario table */}
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
          <thead>
            <tr style={{ color: textMid, borderBottom: `1px solid ${border}` }}>
              <th style={{ ...td, textAlign: 'left' }}>{data.ticker} on {shortDate(horizonDate)}</th>
              {cols.map((c, i) => {
                const S1 = S * (1 + c.move)
                const repeat = i >= MOVES.length
                return (
                  <th key={i} style={{ ...td, ...(repeat ? { borderLeft: `1px dashed ${border}`, color: '#7c3aed' } : {}) }}
                    title={(repeat ? `${data.ticker} moved ${pct(c.move)} over this same window in ${c.label.slice(0, 4)}. ` : '')
                      + `Chance ${data.ticker} is above this by then: ${Math.round(model.probAbove(S1) * 100)}%`}>
                    ${S1.toFixed(0)}
                    <div style={{ fontWeight: 400, fontSize: 10 }}>{repeat ? `${c.label} ${pct(c.move)}` : c.label}</div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {model.strategies.map(s => {
              const vals = cols.map(c => s.at(S * (1 + c.move)))
              return (
                <tr key={s.key} style={{ borderBottom: `1px solid ${border}` }}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{s.label}</td>
                  {vals.map((v, i) => {
                    const best = Math.max(...model.strategies.map(t => t.at(S * (1 + cols[i].move))))
                    return (
                      <td key={i} style={{ ...td, color: v >= 0 ? GOOD : CRIT, fontWeight: Math.abs(v - best) < 1 ? 800 : 400,
                                           borderLeft: i >= MOVES.length ? `1px dashed ${border}` : undefined,
                                           background: Math.abs(v - best) < 1 ? (isDark ? 'rgba(12,163,12,0.12)' : 'rgba(12,163,12,0.08)') : undefined }}>
                        {money(v)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* What each choice commits to */}
      <div style={{ fontSize: 11, color: textMid, marginTop: 8, lineHeight: 1.6 }}>
        {roll && <>Roll: buy back at ${cur.ask.toFixed(2)}, sell ${roll.strike} {shortDate(roll.expiry)} at ${roll.bid.toFixed(2)} ({SOURCE[roll.source] || roll.source}) for {money(roll.netCredit * 100 * n)} more credit;
          most it can keep is {money((prem - cur.ask + roll.bid) * model.x)} if it expires worthless in {roll.dte} days ({Math.round(model.probItm(roll) * 100)}% chance it ends in the money).<br /></>}
        {long && <>Long ${long.strike} {shortDate(long.expiry)} costs {money(long.ask * 100 * n)} ({SOURCE[long.source] || long.source}) and expires before the roll — it covers a fast rally, not one late in the roll.<br /></>}
        Each cell is the total kept on this call, premium already collected included, if you close everything on that date at that stock price.
        Options only — shares held against the call are not counted. Estimates at today's implied vols, held constant; a rally usually lifts them.
        {data.ibkrQuoted === 0 && ' No IBKR quotes yet — with the recorder running, reopen in about 5 minutes for live bid/ask on these contracts.'}
      </div>
    </div>
  )
}
