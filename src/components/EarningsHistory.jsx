import React, { useState, useEffect, useRef } from 'react'

/**
 * Past reports for one name, and what the stock did on each.
 *
 * Built for "the report was good and it got hammered — is that a buy?". The
 * answer starts with how this name usually trades a print: a stock that has
 * fallen after three of its last four beats is telling you the bar is the
 * whisper number, not the consensus. Opened from the Upcoming earnings panel.
 */

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}
const signedPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`)
const tone = (v) => (v == null || v === 0 ? 'var(--textSecondary)' : v > 0 ? '#22c55e' : '#ef4444')
const money = (v) => (v == null ? '—' : `$${v.toFixed(2)}`)
const revenue = (m) => (m == null ? '—' : m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`)

export default function EarningsHistory({ ticker, onClose }) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const boxRef = useRef(null)

  useEffect(() => {
    let alive = true
    setState({ loading: true, data: null, error: null })
    fetch(`/api/earnings-history?ticker=${encodeURIComponent(ticker)}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (alive) setState(d?.success ? { loading: false, data: d, error: null } : { loading: false, data: null, error: d?.error || 'Could not load' }) })
      .catch(() => { if (alive) setState({ loading: false, data: null, error: 'Could not load' }) })
    return () => { alive = false }
  }, [ticker])

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const d = state.data
  const qs = d?.quarters || []
  const s = d?.summary
  const th = { padding: '5px 10px 5px 0', fontSize: 10.5, fontWeight: 600, color: 'var(--textSecondary)',
    textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right', whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)' }
  const td = { padding: '6px 10px 6px 0', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }

  return (
    <div onMouseDown={e => { if (!boxRef.current?.contains(e.target)) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 12px 12px' }}>
      <div ref={boxRef} style={{
        width: 'min(720px, 100%)', maxHeight: '84vh', overflowY: 'auto',
        background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '14px 16px', boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div>
            <strong style={{ fontSize: 15 }}>{ticker} — earnings</strong>
            {d?.price && (
              <span style={{ fontSize: 12, color: 'var(--textSecondary)', marginLeft: 8 }}>
                {money(d.price.close)} close {fmtDate(d.price.date)}
                {' · '}5d <span style={{ color: tone(d.price.chg5d) }}>{signedPct(d.price.chg5d)}</span>
                {' · '}20d <span style={{ color: tone(d.price.chg20d) }}>{signedPct(d.price.chg20d)}</span>
              </span>
            )}
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--textSecondary)', cursor: 'pointer', fontSize: 15, padding: 0 }}>✕</button>
        </div>

        {state.loading && <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>Loading reports…</div>}
        {state.error && <div style={{ fontSize: 12.5, color: '#ef4444' }}>{state.error}</div>}

        {d && (
          <>
            {d.next && (
              <div style={{ fontSize: 12.5, padding: '8px 10px', borderRadius: 6, background: 'var(--surfaceHover)',
                border: '1px solid var(--border)', marginBottom: 12, lineHeight: 1.6 }}>
                <strong>Next report{d.next.fiscalQtrEnd ? ` (${d.next.fiscalQtrEnd})` : ''}:</strong>{' '}
                {d.next.date
                  ? <>{fmtDate(d.next.date)}{d.next.time ? `, ${d.next.time}` : ''}
                      {d.next.daysAway === 0 ? <strong style={{ color: 'var(--severity)' }}> — today</strong>
                        : d.next.daysAway != null ? ` — ${d.next.daysAway} days` : ''}</>
                  : 'date not published'}
                {d.next.epsEstimate != null && (
                  <div style={{ color: 'var(--textSecondary)' }}>
                    Consensus EPS {money(d.next.epsEstimate)}
                    {d.next.epsLow != null && d.next.epsHigh != null && ` (range ${money(d.next.epsLow)}–${money(d.next.epsHigh)})`}
                    {d.next.estimates != null && ` · ${d.next.estimates} analysts`}
                    {(d.next.revisionsUp != null || d.next.revisionsDown != null) &&
                      ` · last 4 wks: ${d.next.revisionsUp ?? 0} up / ${d.next.revisionsDown ?? 0} down`}
                  </div>
                )}
                {d.next.daysAway === 0 && d.next.time === 'after close' && (
                  <div style={{ color: 'var(--textSecondary)' }}>
                    Results land after 4pm; actuals show here once Nasdaq posts them, usually within the hour.
                    Options don't trade after hours, so open-option marks elsewhere in the app still reflect the regular session.
                  </div>
                )}
              </div>
            )}

            {s && s.reports > 0 && (
              <div style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.6 }}>
                Beat EPS in <strong>{s.beats} of {s.reports}</strong> reports
                {s.beats > 0 && <> — and fell after <strong style={{ color: s.beatAndFell ? '#ef4444' : 'inherit' }}>{s.beatAndFell}</strong> of those beats</>}.
                {s.avgAbsReactionPct != null && <> Average reaction <strong>±{s.avgAbsReactionPct}%</strong>.</>}
                {d.sinceLastReport && (
                  <> Since the last reaction ({money(d.sinceLastReport.from)}) it's{' '}
                    <strong style={{ color: tone(d.sinceLastReport.pct) }}>{signedPct(d.sinceLastReport.pct)}</strong>.</>
                )}
              </div>
            )}

            {qs.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>No reported quarters found for {ticker}.</div>
            ) : (
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Quarter</th>
                    <th style={th}>Reported</th>
                    <th style={th}>EPS / est</th>
                    <th style={th}>Surprise</th>
                    <th style={th} title="Quarterly revenue and growth vs the same quarter a year earlier">Revenue (YoY)</th>
                    <th style={th} title="Last close before the report date → first close after it. Holds the reaction whether the report came before the open or after the close.">Reaction</th>
                    <th style={{ ...th, paddingRight: 0 }} title="The five sessions after the reaction day: did the move keep going or reverse?">Next 5d</th>
                  </tr>
                </thead>
                <tbody>
                  {qs.map(q => (
                    <tr key={q.reported} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>
                        {q.fiscalQtrEnd}
                        {q.fromCalendar && <span style={{ fontSize: 10, color: 'var(--textSecondary)', fontWeight: 400 }}> · today</span>}
                      </td>
                      <td style={{ ...td, color: 'var(--textSecondary)' }}>{fmtDate(q.reported)}</td>
                      <td style={td}>{money(q.eps)} <span style={{ color: 'var(--textSecondary)' }}>/ {money(q.epsEstimate)}</span></td>
                      <td style={{ ...td, color: tone(q.surprisePct), fontWeight: 600 }}>{signedPct(q.surprisePct)}</td>
                      <td style={td}>
                        {revenue(q.revenueM)}
                        {q.revenueYoYPct != null && <span style={{ color: tone(q.revenueYoYPct) }}> {signedPct(q.revenueYoYPct)}</span>}
                      </td>
                      <td style={{ ...td, color: tone(q.reactionPct), fontWeight: 700 }}
                        title={q.closeBefore && q.closeAfter ? `${money(q.closeBefore)} → ${money(q.closeAfter)}` : 'Waiting for the next close'}>
                        {q.reactionPct == null && q.fromCalendar ? 'pending' : signedPct(q.reactionPct)}
                      </td>
                      <td style={{ ...td, paddingRight: 0, color: tone(q.followThroughPct) }}>{signedPct(q.followThroughPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ fontSize: 10.5, color: 'var(--textSecondary)', marginTop: 10, lineHeight: 1.5 }}>
              EPS is the adjusted figure analysts forecast, from Nasdaq; revenue from Nasdaq's quarterly table; prices are
              Polygon daily closes. The reaction ignores guidance and the conference call, which are often what actually
              moved the stock.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
