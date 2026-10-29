import React, { useState, useEffect } from 'react'
import { getPref, setPref } from '../services/prefs'
import { fetchShared, brokerQuery, withQuery } from '../services/dashData'
import { tickerStatus, statusTitle, strikeGapPct, daysBetween, weekFriday, NEAR_PCT } from '../utils/positionStatus'

/**
 * The second and third rows of the dashboard:
 *   - Premium goal: option P&L realized this month against a monthly target.
 *   - Week recap: what the week did, in sentences.
 *   - Coming up: expirations, earnings, ex-dates and near-strike calls by date.
 *   - Strategy pockets: positions grouped by how they're held.
 *
 * All four read the same few endpoints through fetchShared, so mounting them
 * together costs one round of requests.
 */

const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const signed = (n) => `${(Number(n) || 0) >= 0 ? '+' : '−'}${money(n)}`
const tone = (n) => n == null ? 'var(--textSecondary)' : n >= 0 ? 'var(--positive)' : 'var(--negative)'
const fmtDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

/** Shared data for the dashboard panels; refreshes every two minutes. */
export function useDashboardData(broker) {
  const [data, setData] = useState({})
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 120000)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => {
    let alive = true
    const bq = brokerQuery(broker)
    const ytdQ = new URLSearchParams(bq)
    ytdQ.set('startDate', getPref('ytdPanel_globalStart', '2026-03-15'))
    const ttl = tick === 0 ? 60000 : 1000
    Promise.all([
      fetchShared(withQuery('/api/insights', bq), ttl),
      fetchShared(`/api/options-pnl/ytd?${ytdQ}`, ttl),
      fetchShared(withQuery('/api/earnings', bq), 30 * 60000),
      fetchShared(withQuery('/api/dividend-schedule', bq), 30 * 60000),
      fetchShared('/api/macro-calendar?days=45', 30 * 60000),
    ]).then(([insights, ytd, earnings, divs, macro]) => {
      if (!alive) return
      setData({
        insights: insights?.success ? insights : null,
        rows: ytd?.success ? ytd.byUnderlying || [] : null,
        earnings: earnings?.success ? earnings.upcoming || [] : [],
        dividends: divs?.success ? divs.events || [] : [],
        macro: macro?.success ? macro.events || [] : [],
      })
    })
    return () => { alive = false }
  }, [broker, tick])
  return data
}

/** Status tags for every ticker that has shares or open legs. */
export function statusByTicker({ insights, rows, earnings = [], dividends = [] }) {
  if (!insights || !rows) return {}
  const today = insights.today
  const legsBy = {}
  for (const l of insights.openLegs || []) (legsBy[l.ticker] ||= []).push(l)
  const priceBy = {}
  for (const r of rows) if (r.stockCurrentPrice > 0) priceBy[r.ticker] = r.stockCurrentPrice
  const earnBy = Object.fromEntries(earnings.map(e => [e.ticker, e.earningsDate]))
  const exBy = {}
  for (const d of dividends) (exBy[d.ticker] ||= []).push(d.exDate)
  const out = {}
  const tickers = new Set([...Object.keys(legsBy), ...rows.filter(r => r.stockPosition > 0).map(r => r.ticker)])
  for (const t of tickers) {
    out[t] = tickerStatus({ price: priceBy[t], legs: legsBy[t] || [], earningsDate: earnBy[t], exDates: exBy[t] || [], today })
  }
  return out
}

export function Sparkline({ points, color = 'var(--accent)', height = 28 }) {
  if (!points || points.length < 2) return null
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min || 1
  const w = 100
  const d = points.map((v, i) => `${(i / (points.length - 1)) * w},${height - 2 - ((v - min) / span) * (height - 4)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

const Panel = ({ title, right, children, style }) => (
  <div className="floating-panel" style={{
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '16px 20px', color: 'var(--text)', minWidth: 0, ...style,
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--textSecondary)' }}>{title}</div>
      {right}
    </div>
    {children}
  </div>
)

const linkBtn = {
  background: 'none', border: 'none', padding: 0, minHeight: 0, minWidth: 0, cursor: 'pointer',
  fontSize: 12, fontWeight: 600, color: 'var(--accent)', fontFamily: 'inherit', boxShadow: 'none',
}

// ── Premium goal ──────────────────────────────────────────────────────────
const weekdaysBetween = (fromIso, toIso) => {
  let n = 0
  const d = new Date(fromIso + 'T12:00:00Z'), end = new Date(toIso + 'T12:00:00Z')
  while (d <= end) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; d.setUTCDate(d.getUTCDate() + 1) }
  return n
}

function PremiumGoal({ insights }) {
  const [goal, setGoal] = useState(() => Number(getPref('premiumGoalMonthly', 0)) || 0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!insights) return <Panel title="Premium goal"><div style={{ fontSize: 12, color: 'var(--textSecondary)' }}>…</div></Panel>

  const kept = insights.month.realized
  const today = insights.today
  const monthEnd = (() => { const d = new Date(insights.monthStart + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10) })()
  const total = weekdaysBetween(insights.monthStart, monthEnd)
  const done = weekdaysBetween(insights.monthStart, today)
  const left = Math.max(0, total - done)
  const pace = goal > 0 ? goal * done / total : null
  const frac = goal > 0 ? Math.max(0, Math.min(1, kept / goal)) : 0
  const monthName = new Date(insights.monthStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'long' })

  const save = () => {
    const v = Math.round(Number(String(draft).replace(/[$,]/g, '')) || 0)
    setGoal(v); setPref('premiumGoalMonthly', v); setEditing(false)
  }

  const R = 42, C = 2 * Math.PI * R
  const ringColor = kept >= goal && goal > 0 ? 'var(--positive)' : 'var(--accent)'
  return (
    <Panel title={`Premium goal · ${monthName}`}
      right={!editing && <button style={linkBtn} onClick={() => { setDraft(goal || ''); setEditing(true) }}>{goal ? 'Edit' : 'Set goal'}</button>}>
      {editing ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}>Monthly target $</span>
          <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()}
            inputMode="numeric" style={{ width: 100, padding: '6px 8px', fontSize: 14, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
          <button style={linkBtn} onClick={save}>Save</button>
          <button style={{ ...linkBtn, color: 'var(--textSecondary)' }} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <svg width="104" height="104" viewBox="0 0 104 104" style={{ flexShrink: 0 }}>
            <circle cx="52" cy="52" r={R} fill="none" stroke="var(--rule)" strokeWidth="10" />
            {goal > 0 && <circle cx="52" cy="52" r={R} fill="none" stroke={ringColor} strokeWidth="10" strokeLinecap="round"
              strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 52 52)" style={{ transition: 'stroke-dasharray 0.6s' }} />}
            {goal > 0 && pace != null && (() => {
              const a = (pace / goal) * 2 * Math.PI - Math.PI / 2
              return <line x1={52 + (R - 8) * Math.cos(a)} y1={52 + (R - 8) * Math.sin(a)} x2={52 + (R + 8) * Math.cos(a)} y2={52 + (R + 8) * Math.sin(a)}
                stroke="var(--textSecondary)" strokeWidth="2"><title>Where you'd be on an even pace</title></line>
            })()}
            <text x="52" y="50" textAnchor="middle" style={{ fontSize: 18, fontWeight: 700, fill: 'var(--text)' }}>
              {goal > 0 ? `${Math.round(kept / goal * 100)}%` : '—'}</text>
            <text x="52" y="67" textAnchor="middle" style={{ fontSize: 10, fill: 'var(--textSecondary)' }}>of goal</text>
          </svg>
          <div style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            <div><span style={{ fontSize: 22, fontWeight: 700, color: tone(kept) }}>{signed(kept)}</span>
              {goal > 0 && <span style={{ color: 'var(--textSecondary)' }}> of {money(goal)}</span>}</div>
            {goal > 0 ? (<>
              <div style={{ color: kept >= pace ? 'var(--positive)' : 'var(--warning)' }}>
                {kept >= goal ? 'Goal reached' : kept >= pace ? `${money(kept - pace)} ahead of pace` : `${money(pace - kept)} behind pace`}</div>
              {kept < goal && <div style={{ color: 'var(--textSecondary)' }}>
                {left > 0 ? `${money((goal - kept) / left)}/day over ${left} trading day${left !== 1 ? 's' : ''} left` : 'last trading day'}</div>}
            </>) : <div style={{ color: 'var(--textSecondary)' }}>Set a monthly target to track progress.</div>}
            <div style={{ color: 'var(--textSecondary)' }}>Last month {signed(insights.lastMonth.realized)}</div>
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--textSecondary)', marginTop: 8 }}>
        Realized option P&L on contracts closed, expired or assigned this month.
      </div>
    </Panel>
  )
}

// ── Week recap ────────────────────────────────────────────────────────────
function WeeklyRecap({ insights, rows }) {
  if (!insights || !rows) return <Panel title="Week recap"><div style={{ fontSize: 12, color: 'var(--textSecondary)' }}>…</div></Panel>
  const per = rows.map(r => {
    const pos = Number(r.stockPosition) || 0, px = Number(r.stockCurrentPrice) || 0
    const shares = pos > 0 && r.weekStartPrice > 0 && px > 0 ? pos * (px - r.weekStartPrice) : 0
    return { ticker: r.ticker, total: shares + (r.optionsThisWeek || 0) + (r.optionsOpenWeekChange || 0) }
  }).filter(x => Math.abs(x.total) >= 1).sort((a, b) => b.total - a.total)
  const total = per.reduce((a, x) => a + x.total, 0)
  const best = per[0], worst = per[per.length - 1]
  const w = insights.week
  const dow = new Date(insights.today + 'T12:00:00Z').getUTCDay()
  const final = dow === 5 || dow === 6 || dow === 0
  const closedEarly = w.closes.filter(c => c.code === 'BTC' || c.code === 'STC')

  const line = (k, content) => <li key={k} style={{ marginBottom: 4 }}>{content}</li>
  const items = [
    line('total', <>Week <b style={{ color: tone(total) }}>{signed(total)}</b></>),
    best && best.total > 0 && line('best', <>Best <b>{best.ticker}</b> <span style={{ color: tone(best.total) }}>{signed(best.total)}</span>
      {worst && worst !== best && worst.total < 0 && <>, worst <b>{worst.ticker}</b> <span style={{ color: tone(worst.total) }}>{signed(worst.total)}</span></>}</>),
    w.expiredWorthless.contracts > 0 && line('exp', <>{w.expiredWorthless.contracts} short contract{w.expiredWorthless.contracts !== 1 ? 's' : ''} expired worthless, kept <b style={{ color: 'var(--positive)' }}>{money(w.expiredWorthless.kept)}</b></>),
    closedEarly.length > 0 && line('closed', <>{closedEarly.length} closed early for <span style={{ color: tone(closedEarly.reduce((a, c) => a + c.realized, 0)) }}>{signed(closedEarly.reduce((a, c) => a + c.realized, 0))}</span></>),
    w.rolls > 0 && line('rolls', <>{w.rolls} roll{w.rolls !== 1 ? 's' : ''}</>),
    w.assigned.contracts > 0 && line('asg', <><span style={{ color: 'var(--warning)' }}>{w.assigned.contracts} assigned</span></>),
    line('real', <>Options realized this week <span style={{ color: tone(w.realized) }}>{signed(w.realized)}</span></>),
  ].filter(Boolean)

  return (
    <Panel title={final ? `Week recap · ${fmtDay(insights.weekStart).replace(/^\w+, /, '')}` : 'This week so far'}>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{items}</ul>
    </Panel>
  )
}

// ── Coming up ─────────────────────────────────────────────────────────────
function UpcomingTimeline({ insights, rows, earnings, dividends, macro = [] }) {
  const [days, setDays] = useState(() => Number(getPref('timelineDays', 14)) || 14)
  if (!insights || !rows) return <Panel title="Coming up"><div style={{ fontSize: 12, color: 'var(--textSecondary)' }}>…</div></Panel>
  const today = insights.today
  const priceBy = Object.fromEntries(rows.filter(r => r.stockCurrentPrice > 0).map(r => [r.ticker, r.stockCurrentPrice]))
  const sharesBy = Object.fromEntries(rows.map(r => [r.ticker, Number(r.stockPosition) || 0]))
  const within = (d) => d >= today && daysBetween(today, d) <= days
  const events = []

  // Short calls near the strike are today's business, whatever their expiry.
  for (const l of insights.openLegs) {
    if (l.isLong || l.type !== 'call') continue
    const gap = strikeGapPct(priceBy[l.ticker], l.strike)
    if (gap != null && gap <= NEAR_PCT) {
      events.push({ date: today, kind: 'near', color: '#e5484d', ticker: l.ticker,
        text: `${l.contracts}× $${l.strike} call (${l.expiry.slice(5).replace('-', '/')}) ${gap <= 0 ? `${Math.abs(gap)}% in the money` : `${gap}% from strike`}` })
    }
  }
  // Expirations, one line per ticker per date.
  const byExp = {}
  for (const l of insights.openLegs) if (within(l.expiry)) (byExp[`${l.expiry}|${l.ticker}`] ||= []).push(l)
  for (const [k, legs] of Object.entries(byExp)) {
    const [date, ticker] = k.split('|')
    const px = priceBy[ticker]
    const parts = legs.map(l => {
      const itm = px > 0 ? (l.type === 'call' ? px > l.strike : px < l.strike) : null
      return `${l.isLong ? '+' : '−'}${l.contracts} $${l.strike}${l.type === 'call' ? 'C' : 'P'}${itm == null ? '' : itm ? ' ITM' : ' OTM'}`
    })
    events.push({ date, kind: 'exp', color: '#f59e0b', ticker, text: `expires: ${parts.join(', ')}` })
  }
  for (const e of earnings) if (e.earningsDate && within(e.earningsDate)) {
    events.push({ date: e.earningsDate, kind: 'earn', color: '#3b82f6', ticker: e.ticker, text: 'earnings' + (e.time ? ` ${e.time}` : '') + (e.hasOptions ? ' — options open' : '') })
  }
  for (const d of dividends) if (within(d.exDate)) {
    events.push({ date: d.exDate, kind: 'ex', color: '#a855f7', ticker: d.ticker,
      text: `ex-dividend $${d.amount} × ${(sharesBy[d.ticker] || d.shares).toLocaleString()} = ${money(d.expected)}${d.status === 'estimated' ? ' (est.)' : ''}${d.shortCalls ? ' — early assignment risk' : ''}` })
  }
  for (const m of macro) if (within(m.date)) {
    const t = m.time ? (() => { const [h, mi] = m.time.split(':').map(Number); return `${(h % 12) || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}` })() : ''
    const nums = [m.forecast && `exp ${m.forecast}`, m.previous && `prev ${m.previous}`].filter(Boolean).join(', ')
    events.push({ date: m.date, kind: 'macro', color: m.impact === 'High' ? '#ec4899' : '#f9a8d4', ticker: 'MACRO',
      text: `${t ? t + ' ' : ''}${m.title}${nums ? ` (${nums})` : ''}` })
  }
  const order = { near: 0, macro: 1, exp: 2, earn: 3, ex: 4 }
  events.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ticker.localeCompare(b.ticker))
  const byDate = []
  for (const e of events) {
    const last = byDate[byDate.length - 1]
    if (last && last.date === e.date) last.items.push(e); else byDate.push({ date: e.date, items: [e] })
  }
  const fri = weekFriday(today)
  const label = (d) => d === today ? 'Today' : daysBetween(today, d) === 1 ? 'Tomorrow' : fmtDay(d)

  return (
    <Panel title="Coming up" right={
      <div style={{ display: 'flex', gap: 10 }}>
        {[14, 30].map(n => <button key={n} style={{ ...linkBtn, color: days === n ? 'var(--accent)' : 'var(--textSecondary)' }}
          onClick={() => { setDays(n); setPref('timelineDays', n) }}>{n}d</button>)}
      </div>}>
      {byDate.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>Nothing in the next {days} days.</div> : (
        <div style={{ maxHeight: 300, overflowY: 'auto', fontSize: 12.5 }}>
          {byDate.map(g => (
            <div key={g.date} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: g.date <= fri ? 'var(--text)' : 'var(--textSecondary)', marginBottom: 2 }}>{label(g.date)}</div>
              {g.items.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: e.color, flexShrink: 0, transform: 'translateY(-1px)' }} />
                  <span><b>{e.ticker}</b> <span style={{ color: 'var(--textSecondary)' }}>{e.text}</span></span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

// ── Weekday odds ──────────────────────────────────────────────────────────
// For each weekday over the last 52 weeks: sessions that closed up vs down.
// The next session to trade is highlighted.
function WeekdayOdds({ rows }) {
  const [symbol, setSymbol] = useState(() => getPref('weekdaySymbol', 'SPY'))
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    setData(null)
    fetchShared(`/api/weekday-stats?symbol=${encodeURIComponent(symbol)}`, 60 * 60000)
      .then(d => alive && setData(d))
    return () => { alive = false }
  }, [symbol])
  const choices = [...new Set(['SPY', 'QQQ', 'IWM', ...(rows || []).filter(r => r.stockPosition > 0).map(r => r.ticker).sort()])]

  // The next session: today if the market hasn't closed, else the next weekday.
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  let next = new Date(et)
  if (et.getHours() >= 16) next.setDate(next.getDate() + 1)
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1)
  const nextDow = next.getDay()
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const ahead = Math.round((dayStart(next) - dayStart(et)) / 86400000)
  const nextLabel = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : 'next'
  const FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' }

  return (
    <Panel title="Up or down by weekday · 52 weeks" right={
      <select value={symbol} onChange={e => { setSymbol(e.target.value); setPref('weekdaySymbol', e.target.value) }}
        style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit' }}>
        {choices.map(c => <option key={c} value={c}>{c}</option>)}
      </select>}>
      {!data ? <div style={{ fontSize: 12, color: 'var(--textSecondary)' }}>…</div>
        : !data.success ? <div style={{ fontSize: 12, color: 'var(--textSecondary)' }}>Unavailable: {data.error}</div>
        : (
          <div style={{ fontSize: 12.5 }}>
            {data.days.map(d => {
              const isNext = d.dow === nextDow
              const total = d.up + d.down + d.flat || 1
              const upPct = Math.round(d.up / total * 100)
              return (
                <div key={d.dow} title={`${d.day}: ${d.up} up, ${d.down} down${d.flat ? `, ${d.flat} flat` : ''} of ${d.sessions} sessions\nAverage ${d.avgPct}% · avg up day +${d.avgUpPct ?? 0}% · avg down day ${d.avgDownPct ?? 0}%\nLast few: ${d.recent.map(x => `${x.date.slice(5)} ${x.pct > 0 ? '+' : ''}${x.pct}%`).join(', ')}`}
                  style={{ display: 'grid', gridTemplateColumns: '64px 1fr 74px', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 8,
                    background: isNext ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                    outline: isNext ? '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' : 'none' }}>
                  <span style={{ fontWeight: isNext ? 700 : 600 }}>{d.day}{isNext && <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 4 }}>{nextLabel}</span>}</span>
                  <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--rule)' }}>
                    <div style={{ width: `${upPct}%`, background: 'var(--positive)' }} />
                    <div style={{ width: `${Math.round(d.down / total * 100)}%`, background: 'var(--negative)', marginLeft: 'auto' }} />
                  </div>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: 'var(--positive)', fontWeight: 700 }}>{d.up}</span>
                    <span style={{ color: 'var(--textSecondary)' }}> / </span>
                    <span style={{ color: 'var(--negative)', fontWeight: 700 }}>{d.down}</span>
                  </span>
                </div>
              )
            })}
            {(() => {
              const d = data.days.find(x => x.dow === nextDow)
              if (!d) return null
              const total = d.up + d.down + d.flat || 1
              return <div style={{ marginTop: 8, color: 'var(--textSecondary)', fontSize: 12 }}>
                {data.symbol} closed up on {d.up} of the last {total} {FULL[d.day]}s ({Math.round(d.up / total * 100)}%), average move {d.avgPct > 0 ? '+' : ''}{d.avgPct}%.
              </div>
            })()}
          </div>
        )}
    </Panel>
  )
}

// ── Strategy pockets ──────────────────────────────────────────────────────
const POCKETS = [
  ['hedged', 'Hedged covered calls', 'Shares with short calls and a long call behind them'],
  ['covered', 'Covered calls', 'Shares with short calls'],
  ['sharesPuts', 'Shares + short puts', 'Shares, adding on dips through puts'],
  ['sharesLong', 'Shares + long options', 'Shares with calls or puts bought, nothing sold'],
  ['spread', 'Spreads', 'Short and long options, no shares'],
  ['csp', 'Short puts', 'Puts sold without shares'],
  ['long', 'Long options', 'Calls or puts bought outright'],
  ['shares', 'Shares only', 'No open options'],
]

const classify = (shares, legs) => {
  const sc = legs.some(l => !l.isLong && l.type === 'call'), lc = legs.some(l => l.isLong && l.type === 'call')
  const sp = legs.some(l => !l.isLong && l.type === 'put'), lp = legs.some(l => l.isLong && l.type === 'put')
  if (shares > 0 && sc && lc) return 'hedged'
  if (shares > 0 && sc) return 'covered'
  if (shares > 0 && sp) return 'sharesPuts'
  if (shares > 0) return lc || lp ? 'sharesLong' : 'shares'
  if ((sc && lc) || (sp && lp)) return 'spread'
  if (sp && !sc) return 'csp'
  if (lc || lp) return 'long'
  return 'spread'
}

function StrategyPockets({ insights, rows, status }) {
  const [open, setOpen] = useState(() => getPref('pocketsOpen', {}) || {})
  if (!insights || !rows) return null
  const legsBy = {}
  for (const l of insights.openLegs) (legsBy[l.ticker] ||= []).push(l)
  const items = rows
    .filter(r => (Number(r.stockPosition) || 0) > 0 || legsBy[r.ticker])
    .map(r => {
      const legs = legsBy[r.ticker] || []
      const shares = Number(r.stockPosition) || 0
      const netOpen = (r.totalRealized || 0) + (r.stockUnrealizedPnL || 0) + (r.stockRealizedPnL || 0) + (r.openUnrealizedPnL || 0)
      const gaps = legs.filter(l => !l.isLong && l.type === 'call').map(l => strikeGapPct(r.stockCurrentPrice, l.strike)).filter(g => g != null)
      return { ticker: r.ticker, shares, legs, pocket: classify(shares, legs), netOpen,
               premium: r.totalRealized || 0, nearest: gaps.length ? Math.min(...gaps) : null, tags: status[r.ticker] || [] }
    })
  const toggle = (k) => { const n = { ...open, [k]: !open[k] }; setOpen(n); setPref('pocketsOpen', n) }

  return (
    <Panel title="Strategy pockets" style={{ gridColumn: '1 / -1' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {POCKETS.map(([key, name, desc]) => {
          const list = items.filter(i => i.pocket === key).sort((a, b) => b.netOpen - a.netOpen)
          if (!list.length) return null
          const sum = list.reduce((a, i) => a + i.netOpen, 0)
          const prem = list.reduce((a, i) => a + i.premium, 0)
          const risk = list.filter(i => i.tags[0]?.key === 'near').length
          const isOpen = !!open[key]
          return (
            <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', background: 'var(--panel)' }}>
              <button onClick={() => toggle(key)} title={desc} style={{ ...linkBtn, color: 'var(--text)', width: '100%', textAlign: 'left', display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{name}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: tone(sum) }}>{signed(sum)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--textSecondary)', fontWeight: 500, marginTop: 2 }}>
                  {list.length} name{list.length !== 1 ? 's' : ''}
                  {key !== 'shares' && <> · premium {signed(prem)}</>}
                  {risk > 0 && <span style={{ color: '#e5484d' }}> · {risk} near strike</span>}
                  <span style={{ float: 'right' }}>{isOpen ? '▾' : '▸'}</span>
                </div>
              </button>
              {isOpen && (
                <div style={{ marginTop: 8, fontSize: 12.5 }}>
                  {list.map(i => (
                    <div key={i.ticker} title={statusTitle(i.tags)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '1px solid var(--rule)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: i.tags[0]?.color || 'transparent', border: i.tags[0] ? 'none' : '1px solid var(--border)' }} />
                      <b style={{ minWidth: 48 }}>{i.ticker}</b>
                      <span style={{ color: 'var(--textSecondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {i.shares > 0 ? `${i.shares.toLocaleString()} sh` : ''}
                        {i.legs.length > 0 && `${i.shares > 0 ? ' · ' : ''}${i.legs.map(l => `${l.isLong ? '+' : '−'}${l.contracts}${l.type === 'call' ? 'C' : 'P'}${l.strike}`).join(' ')}`}
                        {i.nearest != null && ` · ${i.nearest}% to strike`}
                      </span>
                      <span style={{ fontWeight: 700, color: tone(i.netOpen) }}>{signed(i.netOpen)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--textSecondary)', marginTop: 8 }}>
        Net + Open per name for the Options YTD period: options realized + stock P&L + open options. Click a pocket to see its names; dot = most urgent status.
      </div>
    </Panel>
  )
}

export default function DashboardInsights({ broker = 'all' }) {
  const data = useDashboardData(broker)
  const status = statusByTicker(data)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 20 }}>
      <PremiumGoal insights={data.insights} />
      <WeeklyRecap insights={data.insights} rows={data.rows} />
      <UpcomingTimeline {...data} />
      <WeekdayOdds rows={data.rows} />
      <StrategyPockets insights={data.insights} rows={data.rows} status={status} />
    </div>
  )
}
