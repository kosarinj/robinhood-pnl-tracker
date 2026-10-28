import React, { useState, useEffect } from 'react'
import { getPref } from '../services/prefs'

/**
 * The three numbers at the top of the dashboard: where the account stands,
 * what today did, and what the week has done.
 *
 * Account value = net deposits + Account P&L (cash in and out on every trade,
 * shares at market, open options at their mark) + dividends received. It is an
 * estimate of the broker's figure, not a read of it: interest, fees and
 * margin aren't in the imports.
 *
 * Today and This week use the same figures as the Positions table's Day P&L
 * and Wk P&L columns, so they agree with it.
 */

const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const signed = (n) => `${(Number(n) || 0) >= 0 ? '+' : '−'}${money(n)}`

export default function DashboardTopCards({ broker = 'all' }) {
  const [account, setAccount] = useState(null)
  const [open, setOpen] = useState(null)
  const [rows, setRows] = useState(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 120000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    const q = broker && broker !== 'all' ? `broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/account-pnl${q ? `?${q}` : ''}`, { credentials: 'include' })
      .then(r => r.json()).then(d => setAccount(d?.success ? d : null)).catch(() => setAccount(null))
    fetch(`/api/options-pnl/open-positions${q ? `?${q}` : ''}`, { credentials: 'include' })
      .then(r => r.json()).then(d => setOpen(d?.success ? d.positions || [] : null)).catch(() => setOpen(null))
    // Same period as the Options YTD panel; Day and Week don't depend on it.
    const p = new URLSearchParams(q)
    p.set('startDate', getPref('ytdPanel_globalStart', '2026-03-15'))
    fetch(`/api/options-pnl/ytd?${p}`, { credentials: 'include' })
      .then(r => r.json()).then(d => setRows(d?.success ? d.byUnderlying || [] : null)).catch(() => setRows(null))
  }, [broker, tick])

  // Account value, held back until the options are priced -- short contracts
  // carry negative value, so a total without them reads far too high.
  let value = null, pnl = null, deposits = null
  if (account && Array.isArray(open)) {
    const priced = open.filter(p => p.markSource && p.currentValue != null)
    if (open.length === 0 || priced.length > 0) {
      const optionValue = priced.reduce((s, p) => s + (p.isLong ? p.currentValue : -p.currentValue), 0)
      const divs = Number(account.dividends?.total) || 0
      pnl = account.subtotalExcludingOpenOptions + optionValue + divs
      deposits = Number(account.netDeposits) || 0
      value = deposits + pnl
    }
  }

  let day = null, dayStock = 0, dayOpt = 0, week = null, wkStock = 0, wkClosed = 0, wkOpen = 0
  if (rows) {
    let anyDay = false
    for (const r of rows) {
      if (r.dayPnl != null) { anyDay = true; dayStock += r.dayStockPnl || 0; dayOpt += r.dayOptionPnl || 0 }
      const pos = Number(r.stockPosition) || 0, px = Number(r.stockCurrentPrice) || 0
      if (pos > 0 && r.weekStartPrice > 0 && px > 0) wkStock += pos * (px - r.weekStartPrice)
      wkClosed += r.optionsThisWeek || 0
      wkOpen += r.optionsOpenWeekChange || 0
    }
    day = anyDay ? dayStock + dayOpt : null
    week = wkStock + wkClosed + wkOpen
  }

  const pct = (n, base) => (base > 0 && n != null) ? `${n >= 0 ? '↑' : '↓'} ${Math.abs(n / base * 100).toFixed(2)}%` : null
  const tone = (n) => n == null ? 'var(--textSecondary)' : n >= 0 ? 'var(--positive)' : 'var(--negative)'

  const Card = ({ label, big, bigColor, delta, deltaColor, sub, title }) => (
    <div className="floating-panel" title={title} style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '16px 20px', color: 'var(--text)', minWidth: 0,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--textSecondary)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: bigColor || 'var(--text)' }}>
          {big}
        </span>
        {delta && <span style={{ fontSize: 13, fontWeight: 600, color: deltaColor || 'var(--textSecondary)' }}>{delta}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--textSecondary)', marginTop: 6 }}>{sub}</div>}
    </div>
  )

  const prior = value != null && day != null ? value - day : null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 20 }}>
      <Card label="Account value"
        big={value == null ? '…' : money(value)}
        delta={pnl != null ? `${signed(pnl)} all-time` : null} deltaColor={tone(pnl)}
        sub={deposits != null ? `on ${money(deposits)} deposited · estimate` : 'pricing options…'}
        title="Net deposits + every trade's cash + shares at market + open options at their mark + dividends. Interest, fees and margin aren't in the imports, so expect it to differ from the broker a little." />
      <Card label="Today"
        big={day == null ? '—' : signed(day)} bigColor={tone(day)}
        delta={prior ? pct(day, prior) : null} deltaColor={tone(day)}
        sub={day == null ? 'no prices yet' : `stocks ${signed(dayStock)} · options ${signed(dayOpt)}`}
        title="Same as the Day P&L column in Positions: shares × move since yesterday's close, plus open options." />
      <Card label="This week"
        big={week == null ? '…' : signed(week)} bigColor={tone(week)}
        delta={value != null && week != null ? pct(week, value - week) : null} deltaColor={tone(week)}
        sub={week == null ? null : `shares ${signed(wkStock)} · closed options ${signed(wkClosed)} · open ${signed(wkOpen)}`}
        title="Same as the Wk P&L column in Positions: share move since last Friday's close + options closed this week + the change on options still open." />
    </div>
  )
}
