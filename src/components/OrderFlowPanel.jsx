import React, { useState, useEffect, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const num = (n) => {
  if (n == null) return '—'
  const v = Math.abs(n)
  if (v >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return Math.round(n).toLocaleString('en-US')
}
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-US', { hour12: false })
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const KIND_LABEL = {
  wall: 'Wall',
  absorbed: 'Absorbed',
  consumed: 'Eaten',
  pulled: 'Pulled',
}

/**
 * Order flow absorption by price.
 *
 * Open interest above shows where positioning sits. This shows where size
 * actually changed hands today — and the two answer different questions. A
 * price both of them mark is a far stronger level than one either marks alone.
 *
 * The column that matters is absorption: what a level ate measured against the
 * most it ever displayed at once. A level that showed 20k and ate 300k was one
 * seller working an order behind an iceberg, and that is usually where a move
 * runs out. A level that ate roughly what it showed was an ordinary wall that
 * got taken.
 *
 * Eaten and pulled are kept apart throughout because the order book cannot tell
 * them apart on its own — the size is gone either way — and treating a
 * cancellation as demand is how people talk themselves into levels that were
 * never there.
 */
export default function OrderFlowPanel() {
  const { isDark } = useTheme()
  const [ticker, setTicker] = useState('')
  const [input, setInput] = useState('')
  const [session, setSession] = useState(today())
  const [data, setData] = useState(null)
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/orderflow/sessions', { credentials: 'include' })
      .then(r => r.json())
      .then(d => Array.isArray(d) && setSessions(d))
      .catch(() => {})
  }, [data])

  const load = (t, s) => {
    if (!t) return
    setLoading(true); setError('')
    fetch(`/api/orderflow?ticker=${encodeURIComponent(t)}&session=${s}`,
      { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setData(d); setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }

  useEffect(() => { if (ticker) load(ticker, session) }, [ticker, session])

  // Scaled against the busiest level so the bars stay comparable down the
  // ladder rather than each being relative to itself.
  const maxWork = useMemo(
    () => Math.max(1, ...(data?.levels || []).map(l => Math.max(l.consumed, l.pulled))),
    [data])

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
  const td = {
    padding: '4px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums',
    color: isDark ? '#e2e8f0' : '#0f172a',
  }
  const input_ = {
    fontSize: 12, padding: '5px 10px', borderRadius: 6,
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    background: isDark ? '#0f172a' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a',
  }

  const submit = (e) => {
    e.preventDefault()
    const t = input.trim().toUpperCase()
    if (t) setTicker(t)
  }

  const hasData = data && (data.levels?.length > 0 || data.events?.length > 0)

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: isDark ? '#fff' : '#0f172a' }}>Order Flow</h3>
        <span style={{ fontSize: 12, color: muted }}>what got eaten, and what was only ever shown</span>

        <form onSubmit={submit} style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ticker…"
            style={{ ...input_, width: 100, textTransform: 'uppercase' }} />
          <input type="date" value={session} onChange={e => setSession(e.target.value)} style={input_} />
          <button type="submit" className="btn btn-sm" style={{
            ...input_, cursor: 'pointer', background: isDark ? '#334155' : '#e2e8f0',
          }}>Load</button>
        </form>
      </div>

      {sessions.length > 0 && (
        <div style={{ fontSize: 11, color: muted, marginBottom: 10 }}>
          Recorded:{' '}
          {sessions.slice(0, 8).map((s, i) => (
            <button key={`${s.ticker}-${s.session}`}
              onClick={() => { setInput(s.ticker); setTicker(s.ticker); setSession(s.session) }}
              style={{
                background: 'none', border: 'none', padding: '0 4px', cursor: 'pointer',
                fontSize: 11, color: isDark ? '#60a5fa' : '#2563eb',
              }}>
              {s.ticker} {s.session}{i < Math.min(sessions.length, 8) - 1 ? ' ·' : ''}
            </button>
          ))}
        </div>
      )}

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ color: muted, fontSize: 13 }}>Loading…</div>}

      {!ticker && !loading && (
        <div style={{ color: muted, fontSize: 13 }}>
          Enter a ticker to see where size actually changed hands. Data comes from the
          local recorder — it only covers sessions it was running for.
        </div>
      )}

      {ticker && !loading && !error && !hasData && (
        <div style={{ color: muted, fontSize: 13 }}>
          Nothing recorded for {ticker} on {session}. The recorder has to have been
          running during that session — unlike open interest, order flow cannot be
          fetched after the fact.
        </div>
      )}

      {hasData && (
        <>
          {data.ranked?.length > 0 && (
            <div style={{
              padding: '10px 12px', borderRadius: 6, marginBottom: 14,
              background: isDark ? '#0f172a' : '#f8fafc',
              border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
            }}>
              <div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>
                Most absorbed — where size actually went through
              </div>
              {data.ranked.slice(0, 5).map(l => (
                <div key={`${l.side}-${l.price}`} style={{ fontSize: 13, color: isDark ? '#e2e8f0' : '#0f172a' }}>
                  <strong>${l.price.toFixed(2)}</strong>{' '}
                  <span style={{ color: muted }}>
                    ate {num(l.consumed)} · showed {num(l.max_displayed)} · {l.ratio.toFixed(1)}×
                    {l.refreshed > 0 && ` · refilled ${num(l.refreshed)}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto', marginBottom: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'right' }}>Price</th>
                  <th style={{ ...th, textAlign: 'right' }}>Showed</th>
                  <th style={{ ...th, textAlign: 'left' }}>Eaten</th>
                  <th style={{ ...th, textAlign: 'left' }}>Pulled</th>
                  <th style={{ ...th, textAlign: 'right' }}>Refilled</th>
                  <th style={{ ...th, textAlign: 'right' }}>Absorption</th>
                </tr>
              </thead>
              <tbody>
                {data.levels.map(l => {
                  // The levels worth the eye: ate several times what they ever
                  // showed, on volume big enough not to be noise.
                  const hot = l.ratio >= 3 && l.consumed >= 25000
                  return (
                    <tr key={`${l.side}-${l.price}`}
                      style={hot ? { background: isDark ? '#292524' : '#fffbeb' } : undefined}>
                      <td style={{ ...td, textAlign: 'right', fontWeight: hot ? 700 : 500 }}>
                        ${l.price.toFixed(2)}
                        <span style={{ fontSize: 9, color: muted, marginLeft: 4 }}>
                          {l.side === 'bid' ? 'B' : 'A'}
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: muted }}>{num(l.max_displayed)}</td>
                      <td style={td}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            display: 'inline-block', height: 10, borderRadius: 2,
                            background: '#22c55e', width: `${(l.consumed / maxWork) * 110}px`,
                          }} />
                          <span style={{ fontSize: 11, color: muted }}>{num(l.consumed)}</span>
                        </span>
                      </td>
                      <td style={td}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            display: 'inline-block', height: 10, borderRadius: 2,
                            background: '#94a3b8', width: `${(l.pulled / maxWork) * 110}px`,
                          }} />
                          <span style={{ fontSize: 11, color: muted }}>{num(l.pulled)}</span>
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: muted }}>{num(l.refreshed)}</td>
                      <td style={{
                        ...td, textAlign: 'right', fontWeight: hot ? 700 : 500,
                        color: hot ? '#f59e0b' : (isDark ? '#e2e8f0' : '#0f172a'),
                      }}>
                        {l.ratio.toFixed(1)}×
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {data.events?.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>Events, newest first</div>
              {data.events.map((e, i) => (
                <div key={i} style={{ fontSize: 11, color: muted, fontVariantNumeric: 'tabular-nums' }}>
                  <span>{fmtTime(e.ts)}</span>{' '}
                  <span style={{
                    fontWeight: 700,
                    color: e.kind === 'pulled' ? '#ef4444'
                      : e.kind === 'absorbed' ? '#f59e0b'
                      : e.kind === 'consumed' ? '#22c55e' : '#60a5fa',
                  }}>{KIND_LABEL[e.kind] || e.kind}</span>{' '}
                  <span>{e.side} ${e.price.toFixed(2)}</span>{' · '}
                  <span>ate {num(e.consumed)}, pulled {num(e.pulled)}, refilled {num(e.refreshed)}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
            {num(data.totals?.consumed)} eaten · {num(data.totals?.pulled)} pulled ·
            {' '}{num(data.totals?.refreshed)} refilled.
            Absorption is what a level ate against the most it ever displayed at once —
            a level showing 20k that ate 300k was one seller working an order, not a wall,
            and that is usually where a move runs out. Eaten and pulled are kept apart
            because the book cannot tell them apart on its own: the size is gone either
            way, and reading a cancellation as demand is how a level that was never there
            becomes a level someone trades against. Depth covers only the venues this
            account subscribes to, and a large share of US volume never appears on any
            book at all.
          </div>
        </>
      )}
    </div>
  )
}
