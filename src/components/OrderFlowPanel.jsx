import React, { useState, useEffect, useMemo, useRef } from 'react'
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
 * What is resting in the book right now — the recorder's latest snapshot.
 *
 * Laid out like the Both sides view, one row per price with bids left and
 * offers right, but the figures are plain resting size rather than what a
 * level did over the session.
 */
function LiveBook({ ticker, live, error, watch, isDark, muted, th, td }) {
  const book = live?.book
  const boxRef = useRef(null)
  const spreadRef = useRef(null)
  const centeredFor = useRef('')

  const rows = useMemo(() => {
    if (!book) return []
    const m = new Map()
    for (const r of book.asks) m.set(r.price, { price: r.price, ask: r })
    for (const r of book.bids) {
      const row = m.get(r.price) || { price: r.price }
      row.bid = r
      m.set(r.price, row)
    }
    return [...m.values()].sort((a, b) => b.price - a.price)
  }, [book])

  // Open on the spread, once per ticker. After that, leave the scroll where
  // the reader put it -- a ladder that jumps every two seconds cannot be read.
  useEffect(() => {
    if (!book || centeredFor.current === ticker) return
    const box = boxRef.current, mark = spreadRef.current
    if (box && mark) {
      box.scrollTop = mark.offsetTop - box.clientHeight / 2
      centeredFor.current = ticker
    }
  }, [book, ticker])

  const watching = watch?.symbols?.includes(ticker)
  if (error) return <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>
  if (!watching) {
    return (
      <div style={{ color: muted, fontSize: 13 }}>
        {ticker} isn't being watched, so there's no live book for it. Use
        “+ watch {ticker}” above and the recorder picks it up within a few
        seconds. IBKR allows {watch?.max || 3} at once.
      </div>
    )
  }
  if (!book) {
    return <div style={{ color: muted, fontSize: 13 }}>Waiting for the recorder's first snapshot of {ticker}…</div>
  }

  const maxSize = Math.max(1, ...rows.map(r => Math.max(r.bid?.size || 0, r.ask?.size || 0)))
  const bestBid = book.bids[0]?.price
  const bestAsk = book.asks[0]?.price
  const splitAt = bestBid == null ? rows.length : rows.findIndex(r => r.price <= bestBid)
  const stale = book.ageSec > 10
  const venueCell = { ...td, fontSize: 10, color: muted, whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }

  const spreadRow = (
    <tr key="spread" ref={spreadRef}>
      <td colSpan={5} style={{
        ...td, textAlign: 'center', fontSize: 11, color: muted, padding: '5px 8px',
        background: isDark ? '#0f172a' : '#f8fafc',
        borderTop: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
        borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      }}>
        {bestBid != null && bestAsk != null ? `spread $${(bestAsk - bestBid).toFixed(2)}` : 'one side empty'}
        {book.last != null && ` · last $${book.last.toFixed(2)}`}
      </td>
    </tr>
  )

  return (
    <>
      <div style={{ fontSize: 11, marginBottom: 6, color: stale ? '#ef4444' : muted }}>
        {stale
          ? `Stale — the recorder hasn't sent ${ticker} for ${Math.round(book.ageSec)}s`
          : `${ticker} · updated ${Math.max(0, Math.round(book.ageSec))}s ago · ${book.bids.length} bid / ${book.asks.length} offer prices`}
      </div>
      {(() => {
        // Resting size, not absorption: a snapshot has nothing eaten in it,
        // only what each side is showing right now. A heavy side is displayed
        // intent, and displayed intent can be pulled -- which is what the
        // session views are for.
        const bidTotal = book.bids.reduce((n, r) => n + r.size, 0)
        const askTotal = book.asks.reduce((n, r) => n + r.size, 0)
        const total = bidTotal + askTotal
        if (!total) return null
        const bidPct = (bidTotal / total) * 100
        const askPct = 100 - bidPct
        const lead = Math.max(bidPct, askPct)
        const verdict = lead < 58
          ? 'Balanced — similar size resting on both sides'
          : bidPct > askPct
            ? 'More size resting on the bid — buyers showing more than sellers'
            : 'More size resting on the offer — sellers showing more than buyers'
        return (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
              <span style={{ color: '#22c55e', fontWeight: 700 }}>
                BIDS {num(bidTotal)} ({bidPct.toFixed(0)}%)
              </span>
              <span style={{ color: '#ef4444', fontWeight: 700 }}>
                ({askPct.toFixed(0)}%) OFFERS {num(askTotal)}
              </span>
            </div>
            <div style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${bidPct}%`, background: '#22c55e', display: 'flex', alignItems: 'center',
                paddingLeft: 6, fontSize: 10, fontWeight: 700, color: '#052e16', transition: 'width 0.4s',
              }}>{bidPct >= 18 ? 'resting to buy' : ''}</div>
              <div style={{
                width: `${askPct}%`, background: '#ef4444', display: 'flex', alignItems: 'center',
                justifyContent: 'flex-end', paddingRight: 6, fontSize: 10, fontWeight: 700,
                color: '#450a0a', transition: 'width 0.4s',
              }}>{askPct >= 18 ? 'resting to sell' : ''}</div>
            </div>
            <div style={{
              fontSize: 12, marginTop: 5, fontWeight: 600,
              color: lead < 58 ? muted : (bidPct > askPct ? '#22c55e' : '#ef4444'),
            }}>{verdict}</div>
          </div>
        )
      })()}
      <div ref={boxRef} style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto', marginBottom: 10, position: 'relative' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'right' }}>Venues</th>
              <th style={{ ...th, textAlign: 'right' }}>Bid size</th>
              <th style={{ ...th, textAlign: 'center', width: 86 }}>Price</th>
              <th style={{ ...th, textAlign: 'left' }}>Offer size</th>
              <th style={{ ...th, textAlign: 'left' }}>Venues</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              // Half the biggest size on the ladder is worth the eye.
              const big = (l) => l && l.size >= maxSize * 0.5
              const out = []
              if (i === splitAt) out.push(spreadRow)
              out.push(
                <tr key={row.price}
                  style={big(row.bid) || big(row.ask) ? { background: isDark ? '#292524' : '#fffbeb' } : undefined}>
                  <td style={{ ...venueCell, textAlign: 'right' }} title={row.bid?.venues.join(', ')}>
                    {row.bid?.venues.join(' ')}
                  </td>
                  <td style={{ ...td, textAlign: 'right', width: 150 }}>
                    {row.bid && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: big(row.bid) ? 700 : 500 }}>{num(row.bid.size)}</span>
                        <span style={{
                          display: 'inline-block', height: 10, borderRadius: 2, background: '#22c55e',
                          width: `${(row.bid.size / maxSize) * 90}px`,
                        }} />
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'center', fontWeight: 500 }}>${row.price.toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'left', width: 150 }}>
                    {row.ask && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          display: 'inline-block', height: 10, borderRadius: 2, background: '#ef4444',
                          width: `${(row.ask.size / maxSize) * 90}px`,
                        }} />
                        <span style={{ fontWeight: big(row.ask) ? 700 : 500 }}>{num(row.ask.size)}</span>
                      </span>
                    )}
                  </td>
                  <td style={venueCell} title={row.ask?.venues.join(', ')}>{row.ask?.venues.join(' ')}</td>
                </tr>
              )
              return out
            })}
            {splitAt === rows.length && spreadRow}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
        Shares resting at each price right now, refreshed every 2 seconds. Covers only
        the venues this account's depth subscription includes, and hidden or
        off-exchange size never shows on any book.
      </div>
    </>
  )
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
  // What the server knows, fetched alongside the data. An empty panel has
  // several causes that look identical -- nothing recorded, rows written under
  // a different user, the recorder pushing to another instance entirely -- and
  // guessing between them from a blank table wastes a trading session.
  const [diag, setDiag] = useState(null)
  // Remembered per browser: which layout someone reads a book in is a habit,
  // and having to reset it every visit is its own small tax.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('orderflow-view') || 'price' } catch { return 'price' }
  })
  const setViewSaved = (v) => {
    setView(v)
    try { localStorage.setItem('orderflow-view', v) } catch { /* private window */ }
  }
  // What the recorder is asked to watch, and the latest ladder for the ticker
  // on screen. Both come from the server; the recorder picks up list changes
  // on its next book push.
  const [watch, setWatch] = useState(null)
  const [watchErr, setWatchErr] = useState('')
  const [live, setLive] = useState(null)
  const [liveErr, setLiveErr] = useState('')

  useEffect(() => {
    fetch('/api/orderflow/watch', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.symbols)) setWatch(d) })
      .catch(() => {})
  }, [])

  const saveWatch = (symbols) => {
    setWatchErr('')
    fetch('/api/orderflow/watch', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setWatch(d) })
      .catch(e => setWatchErr(e.message))
  }

  // Poll only while the live view is open and the tab is visible -- a ladder
  // nobody is looking at is two requests a second spent on nothing.
  useEffect(() => {
    if (view !== 'live' || !ticker) return
    let stopped = false
    setLive(null); setLiveErr('')
    const tick = () => {
      if (document.hidden) return
      fetch(`/api/orderflow/book?ticker=${encodeURIComponent(ticker)}`, { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          if (stopped) return
          if (d.error) throw new Error(d.error)
          setLive(d); setWatch(d.watch); setLiveErr('')
        })
        .catch(e => { if (!stopped) setLiveErr(e.message) })
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => { stopped = true; clearInterval(id) }
  }, [view, ticker])

  // The stock's price and day change, for any ticker in any view -- the ladder
  // means little without knowing where the stock is trading. The live view's
  // last print is fresher and takes over there; this covers everything else,
  // including names the recorder is not watching.
  const [quote, setQuote] = useState(null)
  useEffect(() => {
    if (!ticker) { setQuote(null); return }
    let stopped = false
    setQuote(null)
    const tick = () => {
      if (document.hidden) return
      fetch(`/api/current-prices?symbols=${encodeURIComponent(ticker)}`, { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          if (stopped || !d.success) return
          const pick = (v) => (typeof v === 'number' ? v : Number(v?.previousClose ?? v?.price ?? v) || null)
          const price = pick(d.prices?.[ticker])
          const prev = pick(d.previousClose?.[ticker])
          setQuote(price > 0 ? { price, prev: prev > 0 ? prev : null } : null)
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 15000)
    return () => { stopped = true; clearInterval(id) }
  }, [ticker])

  useEffect(() => {
    fetch('/api/orderflow/sessions', { credentials: 'include' })
      .then(r => r.json())
      .then(d => Array.isArray(d) && setSessions(d))
      .catch(() => {})
  }, [data])

  const load = (t, s) => {
    if (!t) return
    setLoading(true); setError(''); setDiag(null)
    const url = `/api/orderflow?ticker=${encodeURIComponent(t)}&session=${s}`
    fetch(url, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setData(d); setLoading(false)
        setDiag(x => ({ ...(x || {}), url, got: `${d.levels?.length || 0} levels, ${d.events?.length || 0} events` }))
      })
      .catch(e => { setError(e.message); setLoading(false) })
    fetch('/api/orderflow/debug', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setDiag(x => ({ ...(x || {}), ...d })))
      .catch(() => {})
  }

  useEffect(() => { if (ticker) load(ticker, session) }, [ticker, session])

  // Scaled against the busiest level so the bars stay comparable down the
  // ladder rather than each being relative to itself.
  const maxWork = useMemo(
    () => Math.max(1, ...(data?.levels || []).map(l => Math.max(l.consumed, l.pulled))),
    [data])

  /**
   * One row per price, with each side's figures beside it.
   *
   * A price is not a bid or an offer for the whole session -- it is the bid,
   * then the offer, as the market moves through it. Splitting the table by side
   * files the same level in two places and hides the thing worth seeing: whether
   * buyers or sellers were the ones absorbing there.
   */
  const byPrice = useMemo(() => {
    const m = new Map()
    for (const l of data?.levels || []) {
      const row = m.get(l.price) || { price: l.price, bid: null, ask: null }
      row[l.side === 'bid' ? 'bid' : 'ask'] = l
      m.set(l.price, row)
    }
    return [...m.values()].sort((a, b) => b.price - a.price)
  }, [data])

  // Which side did the absorbing. Sellers eating into bids and buyers eating
  // into offers are opposite readings, and one number for both would cancel
  // them out into nothing.
  const imbalance = useMemo(() => {
    let bid = 0, ask = 0
    for (const l of data?.levels || []) {
      if (l.side === 'bid') bid += l.consumed; else ask += l.consumed
    }
    const total = bid + ask
    return { bid, ask, total, bidPct: total ? (bid / total) * 100 : 0 }
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

        {ticker && (() => {
          const lb = view === 'live' ? live?.book : null
          const price = lb?.last ?? quote?.price
          if (!(price > 0)) return null
          const prev = quote?.prev
          const chg = prev ? price - prev : null
          const up = chg != null && chg >= 0
          return (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
              <strong style={{ fontSize: 15, color: isDark ? '#fff' : '#0f172a' }}>
                {ticker} ${price.toFixed(2)}
              </strong>
              {chg != null && (
                <span style={{ fontSize: 12, fontWeight: 600, color: up ? '#22c55e' : '#ef4444' }}>
                  {up ? '+' : ''}{chg.toFixed(2)} ({up ? '+' : ''}{((chg / prev) * 100).toFixed(2)}%)
                </span>
              )}
              {lb?.bid != null && lb?.ask != null && (
                <span style={{ fontSize: 12, color: muted }}>
                  bid ${lb.bid.toFixed(2)} × ask ${lb.ask.toFixed(2)}
                </span>
              )}
            </span>
          )
        })()}

        <form onSubmit={submit} style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ticker…"
            style={{ ...input_, width: 100, textTransform: 'uppercase' }} />
          <input type="date" value={session} onChange={e => setSession(e.target.value)} style={input_} />
          <button type="submit" className="btn btn-sm" style={{
            ...input_, cursor: 'pointer', background: isDark ? '#334155' : '#e2e8f0',
          }}>Load</button>
        </form>

        <div style={{ display: 'flex', gap: 2 }}>
          {[['live', 'Live now'], ['price', 'Both sides'], ['list', 'Flat list']].map(([k, label]) => (
            <button key={k} onClick={() => setViewSaved(k)} style={{
              ...input_, cursor: 'pointer', padding: '5px 9px',
              background: view === k ? (isDark ? '#334155' : '#e2e8f0')
                                     : (isDark ? '#0f172a' : '#fff'),
              fontWeight: view === k ? 700 : 400,
            }}>{label}</button>
          ))}
        </div>
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

      {watch && (() => {
        const rec = watch.recorder
        const alive = rec && rec.lastSeenSec < 15
        const link = {
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 11, color: isDark ? '#60a5fa' : '#2563eb',
        }
        return (
          <div style={{ fontSize: 11, color: muted, marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Watching:</span>
            {watch.symbols.length === 0 && <span>nothing</span>}
            {watch.symbols.map(s => (
              <span key={s} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', borderRadius: 10,
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
              }}>
                <button onClick={() => { setInput(s); setTicker(s) }} style={link}>{s}</button>
                {rec?.errors?.[s] && (
                  // 2152 is IBKR listing which books this account can see --
                  // a notice worth reading, not a failure to watch the symbol.
                  rec.errors[s].startsWith('[2152]')
                    ? <span title={rec.errors[s]} style={{ color: '#f59e0b', fontWeight: 700, cursor: 'help' }}>i</span>
                    : <span title={rec.errors[s]} style={{ color: '#ef4444', fontWeight: 700, cursor: 'help' }}>!</span>
                )}
                <button onClick={() => saveWatch(watch.symbols.filter(x => x !== s))}
                  title={`Stop watching ${s}`} style={{ ...link, color: muted }}>×</button>
              </span>
            ))}
            {ticker && !watch.symbols.includes(ticker) && (
              watch.symbols.length < watch.max
                ? <button onClick={() => saveWatch([...watch.symbols, ticker])} style={link}>+ watch {ticker}</button>
                : <span>{watch.max} max — remove one to watch {ticker}</span>
            )}
            {watchErr && <span style={{ color: '#ef4444' }}>{watchErr}</span>}
            <span style={{ marginLeft: 'auto', color: alive ? '#22c55e' : '#ef4444' }}>
              {alive ? '● recorder live' : rec ? `recorder last seen ${rec.lastSeenSec}s ago` : 'recorder offline'}
            </span>
          </div>
        )
      })()}

      {error && view !== 'live' && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && view !== 'live' && <div style={{ color: muted, fontSize: 13 }}>Loading…</div>}

      {view === 'live' && ticker && (
        <LiveBook ticker={ticker} live={live} error={liveErr} watch={watch}
          isDark={isDark} muted={muted} th={th} td={td} />
      )}

      {!ticker && !loading && (
        <div style={{ color: muted, fontSize: 13 }}>
          Enter a ticker to see where size actually changed hands. Data comes from the
          local recorder — it only covers sessions it was running for.
        </div>
      )}

      {ticker && view !== 'live' && !loading && !error && !hasData && (
        <div style={{ color: muted, fontSize: 13 }}>
          <div style={{ marginBottom: 8 }}>
            Nothing recorded for {ticker} on {session}. The recorder has to have been
            running during that session — unlike open interest, order flow cannot be
            fetched after the fact.
          </div>
          {diag && (
            <div style={{
              fontSize: 11, fontFamily: 'ui-monospace, monospace', lineHeight: 1.6,
              padding: '8px 10px', borderRadius: 6,
              background: isDark ? '#0f172a' : '#f8fafc',
              border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
            }}>
              <div>queried: {diag.url}</div>
              <div>returned: {diag.got}</div>
              <div>you are user {String(diag.youAre)} · recorder writes as user {String(diag.recorderWritesAs)}</div>
              <div>
                push token on this server:{' '}
                <strong style={{ color: diag.tokenConfigured ? '#22c55e' : '#ef4444' }}>
                  {diag.tokenConfigured ? 'configured' : 'NOT SET — pushes will be refused'}
                </strong>
              </div>
              <div style={{ marginTop: 4 }}>rows this server actually holds:</div>
              {(diag.storedBy || []).length === 0
                ? <div style={{ paddingLeft: 10 }}>none at all — nothing has ever been pushed here</div>
                : diag.storedBy.map((r, i) => (
                    <div key={i} style={{
                      paddingLeft: 10,
                      color: r.user_id === diag.youAre ? (isDark ? '#e2e8f0' : '#0f172a') : muted,
                    }}>
                      user {r.user_id} · {r.ticker} · {r.session} · {r.levels} levels
                      {r.user_id !== diag.youAre && ' (not yours)'}
                    </div>
                  ))}
            </div>
          )}
        </div>
      )}

      {hasData && view !== 'live' && (
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

          {imbalance.total > 0 && (() => {
            const askPct = 100 - imbalance.bidPct
            const lead = Math.max(imbalance.bidPct, askPct)
            const askSide = askPct > imbalance.bidPct
            // Deliberately spelled out. Absorption at the offer means buyers
            // were lifting AND a seller kept supplying -- so the side that ate
            // more marks where the other side's aggression was being met, which
            // reads the opposite way round to most people's first instinct.
            const verdict = lead < 58
              ? 'Balanced — neither side clearly absorbed more'
              : askSide
                ? 'Sellers supplying into buying — the offer side is where size was met'
                : 'Buyers supplying into selling — the bid side is where size was met'
            return (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span style={{ color: '#22c55e', fontWeight: 700 }}>
                    BIDS ate {num(imbalance.bid)} ({imbalance.bidPct.toFixed(0)}%)
                  </span>
                  <span style={{ color: '#ef4444', fontWeight: 700 }}>
                    ({askPct.toFixed(0)}%) OFFERS ate {num(imbalance.ask)}
                  </span>
                </div>
                <div style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{
                    width: `${imbalance.bidPct}%`, background: '#22c55e', display: 'flex',
                    alignItems: 'center', paddingLeft: 6, fontSize: 10, fontWeight: 700, color: '#052e16',
                  }}>{imbalance.bidPct >= 18 ? 'buyers supplying' : ''}</div>
                  <div style={{
                    width: `${askPct}%`, background: '#ef4444', display: 'flex',
                    alignItems: 'center', justifyContent: 'flex-end', paddingRight: 6,
                    fontSize: 10, fontWeight: 700, color: '#450a0a',
                  }}>{askPct >= 18 ? 'sellers supplying' : ''}</div>
                </div>
                <div style={{
                  fontSize: 12, marginTop: 5, fontWeight: 600,
                  color: lead < 58 ? muted : (askSide ? '#ef4444' : '#22c55e'),
                }}>{verdict}</div>
              </div>
            )
          })()}

          <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto', marginBottom: 14 }}>
            {view === 'price' ? (
              /* Bid side left, ask side right, one row per price -- the same
                 shape as the Open Interest table above, so the two read the
                 same way. */
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'right' }} colSpan={2}>Bids — sellers hitting</th>
                    <th style={{ ...th, textAlign: 'center', width: 86 }}>Price</th>
                    <th style={{ ...th, textAlign: 'left' }} colSpan={2}>Offers — buyers lifting</th>
                  </tr>
                </thead>
                <tbody>
                  {byPrice.map(row => {
                    const hot = (l) => l && l.ratio >= 3 && l.consumed >= 25000
                    const warm = hot(row.bid) || hot(row.ask)
                    return (
                      <tr key={row.price}
                        style={warm ? { background: isDark ? '#292524' : '#fffbeb' } : undefined}>
                        <td style={{ ...td, textAlign: 'right', fontSize: 11, color: muted, whiteSpace: 'nowrap' }}>
                          {row.bid ? <>
                            {num(row.bid.consumed)} ate
                            {row.bid.pulled > 0 && <span> · {num(row.bid.pulled)} pulled</span>}
                            {row.bid.ratio >= 3 && <strong style={{ color: '#f59e0b' }}> · {row.bid.ratio.toFixed(1)}×</strong>}
                          </> : ''}
                        </td>
                        <td style={{ ...td, textAlign: 'right', width: 130 }}>
                          {row.bid && <span style={{
                            display: 'inline-block', height: 10, borderRadius: 2, background: '#22c55e',
                            width: `${(row.bid.consumed / maxWork) * 120}px`,
                          }} />}
                        </td>
                        <td style={{ ...td, textAlign: 'center', fontWeight: warm ? 700 : 500 }}>
                          ${row.price.toFixed(2)}
                        </td>
                        <td style={{ ...td, textAlign: 'left', width: 130 }}>
                          {row.ask && <span style={{
                            display: 'inline-block', height: 10, borderRadius: 2, background: '#ef4444',
                            width: `${(row.ask.consumed / maxWork) * 120}px`,
                          }} />}
                        </td>
                        <td style={{ ...td, textAlign: 'left', fontSize: 11, color: muted, whiteSpace: 'nowrap' }}>
                          {row.ask ? <>
                            {num(row.ask.consumed)} ate
                            {row.ask.pulled > 0 && <span> · {num(row.ask.pulled)} pulled</span>}
                            {row.ask.ratio >= 3 && <strong style={{ color: '#f59e0b' }}> · {row.ask.ratio.toFixed(1)}×</strong>}
                          </> : ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
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
            )}
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
