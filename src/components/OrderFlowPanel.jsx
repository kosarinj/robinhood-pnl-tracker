import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, LabelList,
} from 'recharts'
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
  // What counts as a big order, as a multiple of the typical row. Relative
  // rather than a share count, so 20k on NVDA and 2k on a small cap both read
  // as the size worth watching on their own ladders.
  const [bigMult, setBigMult] = useState(() => {
    try { return Number(localStorage.getItem('orderflow-bigmult')) || 3 } catch { return 3 }
  })
  const setBigMultSaved = (m) => {
    setBigMult(m)
    try { localStorage.setItem('orderflow-bigmult', String(m)) } catch { /* private window */ }
  }

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

  // Big orders on each side, and the biggest of each matched against the
  // other. This is the read: a large offer above says where price may be
  // drawn or stopped, and the question is whether anything on the bid side is
  // big enough to compete with it.
  const sizes = [...book.bids, ...book.asks].map(r => r.size).sort((a, b) => a - b)
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0
  const bigMin = Math.max(1, median * bigMult)
  const ref = book.last ?? (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null)
  const bidWalls = book.bids.filter(r => r.size >= bigMin).sort((a, b) => b.size - a.size).slice(0, 3)
  const askWalls = book.asks.filter(r => r.size >= bigMin).sort((a, b) => b.size - a.size).slice(0, 3)
  const topBid = bidWalls[0] || null
  const topAsk = askWalls[0] || null
  const ageOf = (r) => (r.since ? Math.max(0, (book.receivedAt - r.since) / 1000 + (book.ageSec || 0)) : null)
  const fmtAge = (s) => (s < 60 ? `${Math.round(s)}s`
    : s < 3600 ? `${Math.floor(s / 60)}m`
    : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)
  const moveOf = (r) => {
    if (ref == null) return ''
    const d = r.price - ref
    return `${d >= 0 ? '+' : '−'}$${Math.abs(d).toFixed(2)} (${Math.abs((d / ref) * 100).toFixed(2)}%)`
  }
  // Chart marks only. One step darker than the text-and-bar greens used
  // elsewhere in the panel: the lighter pair sits too close together for
  // red-green colour blindness and too light against a dark background.
  const BID = '#15803d'
  const ASK = '#dc2626'

  // Each big order against the largest on the other side -- big or not, since
  // what matters is whether anything over there could absorb it. Pairing only
  // the two biggest missed an offer with nothing to meet it whenever the
  // largest bid happened to be bigger than that offer.
  const biggest = (rows) => rows.reduce((m, r) => (!m || r.size > m.size ? r : m), null)
  const maxBid = biggest(book.bids)
  const maxAsk = biggest(book.asks)
  const standing = (r, side) => {
    const opp = side === 'bid' ? maxAsk : maxBid
    if (!opp || r.size >= opp.size * 1.5) return { kind: 'unopposed', opp }
    if (opp.size >= r.size * 1.5) return { kind: 'outweighed', opp }
    return { kind: 'matched', opp }
  }
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
      {(() => {
        // The whole book at a glance: resting size by price, with the price
        // line between the sides. Solid bars are big orders, faded ones are
        // the ordinary book, and the matched pair from the card below carries
        // the only labels -- so the eye lands on the walls without reading
        // the ladder.
        const chartRows = [
          ...book.bids.map(r => ({ price: r.price, bid: r.size, ask: null, row: r, side: 'bid' })),
          ...book.asks.map(r => ({ price: r.price, bid: null, ask: r.size, row: r, side: 'ask' })),
        ].sort((a, b) => a.price - b.price)
        if (!chartRows.length) return null
        const ink = isDark ? '#e2e8f0' : '#0f172a'
        const grid = isDark ? '#334155' : '#e2e8f0'
        const barSize = Math.max(2, Math.min(24, Math.floor((640 / chartRows.length) * 0.6)))
        const pairLabel = (side) => (props) => {
          const { x, y, width, index } = props
          const d = chartRows[index]
          if (!d || d.side !== side || d.row !== (side === 'bid' ? topBid : topAsk)) return null
          const anchor = index < 4 ? 'start' : index > chartRows.length - 5 ? 'end' : 'middle'
          const tx = anchor === 'start' ? x : anchor === 'end' ? x + width : x + width / 2
          return (
            <text x={tx} y={y - 6} textAnchor={anchor} fontSize={11} fontWeight={700} fill={ink}>
              {num(d.row.size)} @ {d.row.price.toFixed(2)}
            </text>
          )
        }
        const key = (color, label, faded) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color, opacity: faded ? 0.35 : 1 }} />
            {label}
          </span>
        )
        return (
          <div style={{ marginBottom: 12, opacity: stale ? 0.5 : 1 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: muted, marginBottom: 4 }}>
              <span style={{ color: ink, fontWeight: 600 }}>Resting size by price</span>
              {key(BID, 'Bids')}
              {key(ASK, 'Offers')}
              {key(muted, `under ${num(bigMin)} (not big)`, true)}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 2, height: 12, background: ink }} /> {ref != null ? `price $${ref.toFixed(2)}` : 'price'}
              </span>
            </div>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={chartRows} margin={{ top: 22, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={grid} strokeWidth={1} />
                  <XAxis type="number" dataKey="price" domain={['dataMin - 0.02', 'dataMax + 0.02']}
                    tickFormatter={v => `$${v.toFixed(2)}`} tickCount={7}
                    tick={{ fontSize: 10, fill: muted }} stroke={grid} />
                  <YAxis tickFormatter={v => num(v)} width={44} tick={{ fontSize: 10, fill: muted }}
                    stroke={grid} domain={[0, max => Math.ceil(max * 1.15)]} />
                  <Tooltip
                    cursor={{ fill: isDark ? 'rgba(148,163,184,0.08)' : 'rgba(15,23,42,0.05)' }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0].payload
                      const r = d.row
                      const age = ageOf(r)
                      return (
                        <div style={{
                          background: isDark ? '#0f172a' : '#fff', border: `1px solid ${grid}`,
                          borderRadius: 6, padding: '6px 8px', fontSize: 12, color: muted,
                        }}>
                          <div style={{ fontWeight: 700, color: ink }}>{num(r.size)} shares</div>
                          <div>
                            <span style={{ display: 'inline-block', width: 10, height: 2, background: d.side === 'bid' ? BID : ASK, verticalAlign: 'middle', marginRight: 4 }} />
                            {d.side === 'bid' ? 'Bid' : 'Offer'} at ${r.price.toFixed(2)}{ref != null && ` · ${moveOf(r)}`}
                          </div>
                          {age != null && (
                            <div>resting {fmtAge(age)}{r.peak > r.size * 1.5 ? ` · was ${num(r.peak)}` : ''}</div>
                          )}
                          {r.venues?.length > 0 && <div>{r.venues.join(', ')}</div>}
                        </div>
                      )
                    }}
                  />
                  <ReferenceLine y={bigMin} stroke={muted} strokeWidth={1} ifOverflow="extendDomain"
                    label={{ value: `big ${bigMult}×`, position: 'insideTopLeft', fontSize: 10, fill: muted }} />
                  {ref != null && (
                    <ReferenceLine x={ref} stroke={ink} strokeWidth={1} ifOverflow="extendDomain" />
                  )}
                  <Bar dataKey="bid" stackId="s" fill={BID} radius={[4, 4, 0, 0]} barSize={barSize} isAnimationActive={false}>
                    {chartRows.map((d, i) => (
                      <Cell key={i} fillOpacity={d.bid != null && d.bid >= bigMin ? 1 : 0.35} />
                    ))}
                    <LabelList content={pairLabel('bid')} />
                  </Bar>
                  <Bar dataKey="ask" stackId="s" fill={ASK} radius={[4, 4, 0, 0]} barSize={barSize} isAnimationActive={false}>
                    {chartRows.map((d, i) => (
                      <Cell key={i} fillOpacity={d.ask != null && d.ask >= bigMin ? 1 : 0.35} />
                    ))}
                    <LabelList content={pairLabel('ask')} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )
      })()}
      {(() => {
        const move = (r) => {
          if (ref == null) return ''
          const d = r.price - ref
          return `${d >= 0 ? '+' : '−'}$${Math.abs(d).toFixed(2)} (${Math.abs((d / ref) * 100).toFixed(2)}%)`
        }
        const wallLine = (r, i, color, side) => {
          const age = ageOf(r)
          const st = standing(r, side)
          const oppAt = st.opp ? `${num(st.opp.size)} @ $${st.opp.price.toFixed(2)}` : ''
          return (
            <div key={r.price} style={{
              fontSize: 12, fontVariantNumeric: 'tabular-nums', lineHeight: 1.6,
              color: i === 0 ? (isDark ? '#e2e8f0' : '#0f172a') : muted, fontWeight: i === 0 ? 700 : 400,
            }}>
              <span style={{ color }}>${r.price.toFixed(2)}</span> {num(r.size)}
              <span style={{ color: muted, fontWeight: 400 }}>
                {' · '}{move(r)}
                {age != null && ` · resting ${fmtAge(age)}`}
                {r.peak > r.size * 1.5 && <span style={{ color: '#f59e0b' }}> · was {num(r.peak)}</span>}
                {st.kind === 'unopposed'
                  ? <strong style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}> · unopposed</strong>
                  : ` · ${st.kind === 'matched' ? 'matched' : 'outweighed'} by ${oppAt}`}
              </span>
            </div>
          )
        }
        const at = (r) => `${num(r.size)} @ $${r.price.toFixed(2)}`
        let verdict, vColor = muted
        if (!topAsk && !topBid) {
          verdict = `No big orders — nothing stands out from the typical ${num(median)} shares`
        } else if (!topBid) {
          verdict = `Only the offer side has size: ${at(topAsk)}, and no bid of ${num(bigMin)}+ is there to compete`
          vColor = '#ef4444'
        } else if (!topAsk) {
          verdict = `Only the bid side has size: ${at(topBid)}, and no offer of ${num(bigMin)}+ is there to compete`
          vColor = '#22c55e'
        } else {
          const ratio = Math.max(topAsk.size, topBid.size) / Math.min(topAsk.size, topBid.size)
          const pair = `offer ${at(topAsk)} vs bid ${at(topBid)}`
          if (ratio < 1.5) {
            verdict = `Evenly matched — ${pair}`
          } else if (topAsk.size > topBid.size) {
            verdict = `Offers outweigh bids ${ratio.toFixed(1)}× — ${pair}. A bid would need about ${num(topAsk.size / 1.5)} to compete`
            vColor = '#ef4444'
          } else {
            verdict = `Bids outweigh offers ${ratio.toFixed(1)}× — ${pair}. An offer would need about ${num(topBid.size / 1.5)} to compete`
            vColor = '#22c55e'
          }
        }
        // An unopposed order is the read that matters most, so it takes the
        // headline over the top-pair comparison.
        const unAsk = askWalls.find(r => standing(r, 'ask').kind === 'unopposed')
        const unBid = bidWalls.find(r => standing(r, 'bid').kind === 'unopposed')
        if (unAsk || unBid) {
          const say = (r, side) => {
            const opp = standing(r, side).opp
            const other = side === 'bid' ? 'offer' : 'bid'
            return `${at(r)} ${side === 'bid' ? 'bid' : 'offer'} is unopposed — ${opp ? `the biggest ${other} is ${at(opp)}` : `there are no ${other}s`}`
          }
          verdict = unAsk ? say(unAsk, 'ask') : say(unBid, 'bid')
          vColor = unAsk ? '#ef4444' : '#22c55e'
        }
        return (
          <div style={{
            padding: '10px 12px', borderRadius: 6, marginBottom: 12,
            background: isDark ? '#0f172a' : '#f8fafc',
            border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: muted }}>
                Big orders — {bigMult}× the typical {num(median)} shares ({num(bigMin)}+)
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                {[3, 5, 10].map(m => (
                  <button key={m} onClick={() => setBigMultSaved(m)} style={{
                    fontSize: 11, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                    background: bigMult === m ? (isDark ? '#334155' : '#e2e8f0') : 'transparent',
                    color: isDark ? '#e2e8f0' : '#0f172a', fontWeight: bigMult === m ? 700 : 400,
                  }}>{m}×</button>
                ))}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
              <div style={{ flex: '1 1 220px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', marginBottom: 2 }}>BIG BIDS (below)</div>
                {bidWalls.length ? bidWalls.map((r, i) => wallLine(r, i, '#22c55e', 'bid'))
                  : <div style={{ fontSize: 12, color: muted }}>none</div>}
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', marginBottom: 2 }}>BIG OFFERS (above)</div>
                {askWalls.length ? askWalls.map((r, i) => wallLine(r, i, '#ef4444', 'ask'))
                  : <div style={{ fontSize: 12, color: muted }}>none</div>}
              </div>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: vColor }}>{verdict}</div>
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
              // Same definition of big as the card above, and the two orders
              // being matched against each other marked more strongly.
              const big = (l) => l && l.size >= bigMin
              const matched = (row.bid && row.bid === topBid) || (row.ask && row.ask === topAsk)
              const out = []
              if (i === splitAt) out.push(spreadRow)
              out.push(
                <tr key={row.price}
                  style={matched ? { background: isDark ? '#422006' : '#fde68a' }
                    : big(row.bid) || big(row.ask) ? { background: isDark ? '#292524' : '#fffbeb' } : undefined}>
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
/**
 * The screener's columns, and what each one actually measures.
 *
 * Kept in one place so the table header and the legend beneath it cannot drift
 * apart, and so a definition has somewhere to live that is longer than a header
 * will hold. The weights quoted here are the recorder's own arithmetic
 * (l2/recorder.py, Scan.reading) rather than a description of it: lean is worth
 * 40 points, an unopposed wall 30, absorption 20 and the tape 10.
 */
const SCAN_COLUMNS = [
  ['ticker', 'Ticker', 'left',
    'The symbol. Click it to open the live book for that name.'],
  ['score', 'Score', 'right',
    'A 0–100 composite of the four readings to its right: resting lean is worth up to 40, an unopposed wall up to 30, absorption up to 20, the tape up to 10. Hover a score to see how it split.'],
  ['lean', 'Resting lean', 'right',
    'Of the size resting near the current price, the share sitting on the bid. Above 50% means more size is waiting to buy than to sell. The small figures beneath are the raw bid and offer sizes it came from.'],
  ['wall', 'Biggest wall', 'left',
    'The largest single resting order in the book: its size, which side it is on, its price, and how far that price sits from the last trade. "unopposed" means nothing within 1.5× of it is facing it on the other side.'],
  ['absorption', 'Absorption', 'left',
    'The price level that absorbed the most relative to the size it ever showed, during this scan. A high reading means someone kept refilling and soaking up what hit them instead of moving away.'],
  ['tape', 'Tape', 'right',
    'Of the volume that actually traded during the scan, the share that was buyers lifting offers rather than sellers hitting bids.'],
  ['price', 'Price', 'right',
    'The last trade at the moment of the scan, or the midpoint if nothing had traded yet.'],
  ['ageSec', 'Scanned', 'right',
    'How long ago this reading was taken. The scanner rotates through the list, so an old reading means it has not come back to that name yet.'],
]

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

  // The screener: a list the recorder rotates through on whatever depth
  // subscriptions the watch list leaves spare, and the latest reading of each.
  const [scan, setScan] = useState(null)
  const [scanInput, setScanInput] = useState('')
  const [scanErr, setScanErr] = useState('')
  // Newest scan first by default: the rotation is the point, and what just
  // came back is what has not been looked at yet. Remembered per browser like
  // the view choice, so a sort someone picked survives the next visit.
  const [scanSort, setScanSort] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('orderflow-scan-sort') || 'null')
      return saved?.key ? saved : { key: 'ageSec', dir: 'asc' }
    } catch { return { key: 'ageSec', dir: 'asc' } }
  })
  const sortScanBy = (key) => {
    setScanSort(prev => {
      // Clicking the same column flips it; a new column starts the way that
      // column is usually read -- tickers A-Z, everything else biggest first.
      const next = prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: (key === 'ticker' || key === 'ageSec') ? 'asc' : 'desc' }
      try { localStorage.setItem('orderflow-scan-sort', JSON.stringify(next)) } catch { /* private window */ }
      return next
    })
  }
  const loadScan = () => fetch('/api/orderflow/scan', { credentials: 'include' })
    .then(r => r.json())
    .then(d => { if (Array.isArray(d.list)) setScan(d) })
    .catch(() => {})
  useEffect(() => {
    if (view !== 'screener') return
    loadScan()
    // A pass is half a minute a name; ten seconds is often enough to be new.
    const id = setInterval(() => { if (!document.hidden) loadScan() }, 10000)
    return () => clearInterval(id)
  }, [view])
  const saveScan = (body) => {
    setScanErr('')
    fetch('/api/orderflow/scan', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setScan(d) })
      .catch(e => setScanErr(e.message))
  }

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
          {[['live', 'Live now'], ['price', 'Both sides'], ['list', 'Flat list'], ['screener', 'Screener']].map(([k, label]) => (
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
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 12,
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                background: isDark ? '#1e293b' : '#fff',
              }}>
                <button onClick={() => { setInput(s); setTicker(s) }}
                  style={{ ...link, fontSize: 13, fontWeight: 600 }}>{s}</button>
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
            {watch.changed && (
              // One list for everyone, so say who last touched it -- a symbol
              // that vanished was usually someone else making room.
              <span title="Everyone signed in shares this watch list">
                shared · changed by {watch.changed.byYou ? 'you' : watch.changed.by}{' '}
                {new Date(watch.changed.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
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

      {view === 'screener' && (() => {
        const cfg = scan?.config || {}
        const results = scan?.results || []
        // A missing reading sorts last whichever way the column is pointing:
        // a name the rotation has not reached yet is not "the smallest".
        const valueFor = (r, key) => {
          switch (key) {
            case 'ticker': return r.ticker
            case 'lean': return r.lean
            case 'wall': return r.wallSize
            case 'absorption': return r.absRatio
            case 'tape': return r.buyPct
            case 'price': return r.price
            case 'ageSec': return r.ageSec
            default: return r.score
          }
        }
        const sorted = [...results].sort((a, b) => {
          const av = valueFor(a, scanSort.key), bv = valueFor(b, scanSort.key)
          const an = av == null, bn = bv == null
          if (an && bn) return 0
          if (an) return 1
          if (bn) return -1
          const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
          return scanSort.dir === 'asc' ? cmp : -cmp
        })
        const chip = {
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px',
          borderRadius: 10, border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, fontSize: 11,
        }
        const link = {
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 11, color: isDark ? '#60a5fa' : '#2563eb',
        }
        const setBtn = (on) => ({
          ...input_, cursor: 'pointer', padding: '2px 8px', fontSize: 11,
          background: on ? (isDark ? '#334155' : '#e2e8f0') : 'transparent',
          fontWeight: on ? 700 : 400,
        })
        const add = (e) => {
          e.preventDefault()
          const t = scanInput.trim().toUpperCase()
          if (!t) return
          saveScan({ list: [...(scan?.list || []), t] })
          setScanInput('')
        }
        const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)
        return (
          <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: muted }}>Scanning:</span>
              {(scan?.list || []).length === 0 && <span style={{ fontSize: 11, color: muted }}>nothing yet</span>}
              {(scan?.list || []).map(s => (
                <span key={s} style={chip}>
                  <button onClick={() => { setInput(s); setTicker(s); setViewSaved('live') }} style={link}>{s}</button>
                  <button onClick={() => saveScan({ list: scan.list.filter(x => x !== s) })}
                    title={`Remove ${s}`} style={{ ...link, color: muted }}>×</button>
                </span>
              ))}
              <form onSubmit={add} style={{ display: 'flex', gap: 4 }}>
                <input value={scanInput} onChange={e => setScanInput(e.target.value)} placeholder="Add ticker…"
                  style={{ ...input_, width: 100, textTransform: 'uppercase' }} />
                <button type="submit" style={{ ...input_, cursor: 'pointer', background: isDark ? '#334155' : '#e2e8f0' }}>Add</button>
              </form>
              {scanErr && <span style={{ fontSize: 11, color: '#ef4444' }}>{scanErr}</span>}
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: muted, marginBottom: 10 }}>
              <span>Seconds each:</span>
              {[15, 30, 60].map(s => (
                <button key={s} onClick={() => saveScan({ config: { ...cfg, seconds: s } })} style={setBtn(cfg.seconds === s)}>{s}s</button>
              ))}
              <span>Near price:</span>
              {[0.5, 1, 2].map(p => (
                <button key={p} onClick={() => saveScan({ config: { ...cfg, nearPct: p } })} style={setBtn(cfg.nearPct === p)}>{p}%</button>
              ))}
              <span>Big:</span>
              {[3, 5, 10].map(m => (
                <button key={m} onClick={() => saveScan({ config: { ...cfg, bigMult: m } })} style={setBtn(cfg.bigMult === m)}>{m}×</button>
              ))}
              <span style={{ marginLeft: 'auto' }}>
                {results.length} of {(scan?.list || []).length} scanned
                {(scan?.list || []).length > 0 && ` · a full pass takes about ${Math.ceil(((scan.list.length / 2) * ((cfg.seconds || 30) + 3)) / 60)} min`}
              </span>
            </div>

            {results.length === 0 ? (
              <div style={{ fontSize: 13, color: muted }}>
                {/* An idle screener and a broken one used to read the same, so
                    "waiting for the first readings" was the answer whether it
                    was about to report or could not possibly. Say which. */}
                {(() => {
                  const rec = scan?.recorder
                  const listed = (scan?.list || []).length
                  const watching = scan?.watching ?? 0
                  const maxDepth = scan?.maxDepth ?? 3
                  const stale = !rec || rec.lastSeenSec > 90
                  const depthErr = Object.entries(rec?.errors || {})
                    .find(([, v]) => /\[309\]|max.*depth|market depth/i.test(String(v)))

                  if (stale) return (
                    <>
                      <strong style={{ color: '#f59e0b' }}>The recorder isn’t running.</strong>{' '}
                      Nothing can be scanned without it — it is the only thing with a depth
                      subscription. Start it and this fills in on its own.
                      {rec && ` Last heard from ${rec.lastSeenSec}s ago.`}
                    </>
                  )
                  if (listed === 0) return 'Add tickers above. They are scanned on whatever depth subscriptions the watch list leaves spare — watch one name and two are free.'
                  if (watching >= maxDepth) return (
                    <>
                      <strong style={{ color: '#f59e0b' }}>No spare depth subscriptions.</strong>{' '}
                      IBKR allows {maxDepth} at once and the watch list is holding all of them.
                      Remove a watched name and the scan starts on the freed slot.
                    </>
                  )
                  if (depthErr) return (
                    <>
                      <strong style={{ color: '#f59e0b' }}>IBKR refused a depth request.</strong>{' '}
                      {depthErr[0]}: {depthErr[1]}
                    </>
                  )
                  return `Waiting for the first readings. Each name is sampled for ${cfg.seconds || 30} seconds before it reports, and ${maxDepth - watching} can run at once.`
                })()}
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {SCAN_COLUMNS.map(([key, label, align, meaning]) => (
                        <th key={key} onClick={() => sortScanBy(key)}
                          title={`${meaning}\n\nClick to sort by ${label.toLowerCase()}.`}
                          style={{ ...th, textAlign: align, cursor: 'pointer', userSelect: 'none' }}>
                          {label}
                          <span style={{ opacity: scanSort.key === key ? 1 : 0.25, fontSize: 10 }}>
                            {' '}{scanSort.key === key ? (scanSort.dir === 'asc' ? '↑' : '↓') : '↕'}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(r => (
                      <tr key={r.ticker}>
                        <td style={{ ...td, textAlign: 'left' }}>
                          <button onClick={() => { setInput(r.ticker); setTicker(r.ticker); setViewSaved('live') }}
                            style={{ ...link, fontSize: 13, fontWeight: 600 }}>{r.ticker}</button>
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}
                          title={r.parts ? `lean ${r.parts.lean} · wall ${r.parts.wall} · absorption ${r.parts.absorption} · tape ${r.parts.tape}` : ''}>
                          {r.score != null ? r.score.toFixed(0) : '—'}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {r.lean == null ? '—' : (
                            <span style={{ color: r.lean > 0.5 ? '#22c55e' : '#ef4444' }}>
                              {pct(r.lean)} {r.lean > 0.5 ? 'bid' : 'offer'}
                            </span>
                          )}
                          <span style={{ display: 'block', fontSize: 10, color: muted }}>
                            {num(r.restingBid)} / {num(r.restingAsk)}
                          </span>
                        </td>
                        <td style={{ ...td, fontSize: 12 }}>
                          {r.wallSize ? <>
                            <span style={{ color: r.wallSide === 'bid' ? '#22c55e' : '#ef4444' }}>{num(r.wallSize)}</span>
                            {' @ '}${r.wallPrice?.toFixed(2)}
                            {r.wallDistPct != null && <span style={{ color: muted }}> · {r.wallDistPct.toFixed(2)}% away</span>}
                            {r.unopposed && <strong> · unopposed</strong>}
                          </> : '—'}
                        </td>
                        <td style={{ ...td, fontSize: 12 }}>
                          {r.absRatio ? <>
                            <strong>{r.absRatio.toFixed(1)}×</strong> @ ${r.absPrice?.toFixed(2)}
                            <span style={{ color: muted }}> · {num(r.absConsumed)}</span>
                          </> : <span style={{ color: muted }}>—</span>}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {r.buyPct == null ? '—' : (
                            <span style={{ color: r.buyPct > 0.5 ? '#22c55e' : '#ef4444' }}>{pct(r.buyPct)} buy</span>
                          )}
                          <span style={{ display: 'block', fontSize: 10, color: muted }}>{num(r.trades)} trades</span>
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>{r.price ? `$${r.price.toFixed(2)}` : '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontSize: 11, color: r.ageSec > 900 ? '#ef4444' : muted }}>
                          {r.ageSec < 60 ? `${r.ageSec}s ago` : `${Math.floor(r.ageSec / 60)}m ago`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ fontSize: 11, color: muted, lineHeight: 1.5, marginTop: 10 }}>
              Each name is watched for {cfg.seconds || 30} seconds, so this is a sample, not a vigil — a wall can
              appear or vanish between passes. Score adds four parts, shown on hover: how lopsided the resting size
              is near the price, whether the biggest order has anything to meet it, how much traded through a level
              while watching, and which side was hitting.
              {/* Every column spelled out. A reading nobody can define is a
                  reading nobody should trade on, and a tooltip is easy to miss
                  when the question is "what is this column". */}
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', userSelect: 'none' }}>What each column means</summary>
                <dl style={{ margin: '6px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px' }}>
                  {SCAN_COLUMNS.map(([key, label, , meaning]) => (
                    <React.Fragment key={key}>
                      <dt style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{label}</dt>
                      <dd style={{ margin: 0 }}>{meaning}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            </div>
          </div>
        )
      })()}

      {!ticker && !loading && view !== 'screener' && (
        <div style={{ color: muted, fontSize: 13 }}>
          Enter a ticker to see where size actually changed hands. Data comes from the
          local recorder — it only covers sessions it was running for.
        </div>
      )}

      {ticker && view !== 'live' && view !== 'screener' && !loading && !error && !hasData && (
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
                      color: r.user_id === diag.recorderWritesAs ? (isDark ? '#e2e8f0' : '#0f172a') : muted,
                    }}>
                      user {r.user_id} · {r.ticker} · {r.session} · {r.levels} levels
                      {r.user_id !== diag.recorderWritesAs && ' (not the recorder’s — not shown)'}
                    </div>
                  ))}
            </div>
          )}
        </div>
      )}

      {hasData && view !== 'live' && view !== 'screener' && (
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

          {data.outcomes?.total > 0 && (() => {
            // The instinct this answers: heavy offers above often come before a
            // move up. Eaten against pulled is the split that matters -- a wall
            // that trades away was real supply meeting real demand, one that
            // walks away was never there -- so the two averages are shown side
            // by side rather than rolled into one number.
            const o = data.outcomes
            const pct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
            const sideWord = (s) => (s === 'ask' ? 'offer' : 'bid')
            return (
              <div style={{
                padding: '10px 12px', borderRadius: 6, marginBottom: 14,
                background: isDark ? '#0f172a' : '#f8fafc',
                border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
              }}>
                <div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>
                  What happened after each big order — “toward” means price travelled to the side the order was on
                </div>
                <div style={{ fontSize: 13, color: isDark ? '#e2e8f0' : '#0f172a', marginBottom: 6 }}>
                  {o.measured > 0
                    ? <>Price moved <strong>toward {o.toward}</strong> of them and away from <strong>{o.away}</strong>
                        {o.unmeasurable > 0 && <span style={{ color: muted }}> · {o.unmeasurable} recorded before prices were kept</span>}</>
                    : <span style={{ color: muted }}>Recorded before prices were kept alongside events — re-record a session to measure this.</span>}
                </div>
                {o.measured > 0 && (
                  <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>
                    Eaten walls: <strong style={{ color: '#22c55e' }}>{pct(o.eaten.avgMove)}</strong> average move toward them
                    {' '}({o.eaten.n}{o.eaten.n ? `, ${o.eaten.reached} reached` : ''})
                    {' · '}Pulled walls: <strong style={{ color: '#ef4444' }}>{pct(o.pulled.avgMove)}</strong>
                    {' '}({o.pulled.n}{o.pulled.n ? `, ${o.pulled.reached} reached` : ''})
                  </div>
                )}
                <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left' }}>Appeared</th>
                        <th style={{ ...th, textAlign: 'right' }}>Size</th>
                        <th style={{ ...th, textAlign: 'right' }}>Level</th>
                        <th style={{ ...th, textAlign: 'right' }}>Price then</th>
                        <th style={{ ...th, textAlign: 'right' }}>Moved</th>
                        <th style={{ ...th, textAlign: 'left' }}>Ended</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.walls.map((w, i) => (
                        <tr key={i}>
                          <td style={{ ...td, fontSize: 11, color: muted }}>
                            {fmtTime(w.ts)} <span style={{ color: w.side === 'ask' ? '#ef4444' : '#22c55e' }}>{sideWord(w.side)}</span>
                          </td>
                          <td style={{ ...td, textAlign: 'right' }}>{num(w.size)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>${w.price.toFixed(2)}</td>
                          <td style={{ ...td, textAlign: 'right', color: muted }}>{w.pxAt ? `$${w.pxAt.toFixed(2)}` : '—'}</td>
                          <td style={{
                            ...td, textAlign: 'right', fontWeight: 600,
                            color: w.movePct == null ? muted : w.movePct > 0.1 ? '#22c55e' : w.movePct < -0.1 ? '#ef4444' : muted,
                          }}>
                            {pct(w.movePct)}{w.reached ? <span style={{ fontSize: 10, color: muted }}> · reached</span> : null}
                          </td>
                          <td style={{ ...td, fontSize: 11, color: w.ended === 'eaten' ? '#22c55e' : w.ended === 'pulled' ? '#ef4444' : muted }}>
                            {w.ended}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

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
