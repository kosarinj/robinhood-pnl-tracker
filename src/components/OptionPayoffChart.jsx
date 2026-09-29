import React, { useMemo, useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, ReferenceDot,
} from 'recharts'
import { prepareLeg, pnlAtPrice, priceGrid, intrinsic } from '../utils/optionMath'

/**
 * P&L on one underlying's open option legs, across a range of prices for that
 * underlying.
 *
 * The panel behind this already says what the position is worth at today's
 * price, and /api/options-pnl/ytd already answers the same question at twelve
 * fixed percentages. Neither answers "what if RDDT is 135", which is the form
 * the question actually gets asked in — so this puts price on the axis and
 * reads the number straight off it.
 *
 * Two curves, and the gap between them is the whole point:
 *
 *   Today   the underlying moves, time and vol stay where they are. What a gap
 *           to that price would do tomorrow morning.
 *   Expiry  every leg settled at exercise value. The same move plus all the
 *           decay still to come, and the ceiling a credit position can reach.
 *
 * On a short position the expiry curve sits above the today curve by whatever
 * extrinsic is left to collect. On a long one it sits below, because that
 * extrinsic is what gets paid away.
 *
 * Vol is held at what each leg's own mark implies (sticky strike). A real
 * selloff lifts vol, so the downside here is the optimistic end of a range, not
 * a forecast — a point the footnote makes on screen rather than leaving to be
 * inferred.
 */
export default function OptionPayoffChart({ ticker, legs, spot, shares = 0, onClose, isDark }) {
  // Change from today rather than the running total, because that is the
  // question being asked — "what would I make or lose if it goes there". It is
  // also the only basis the share line can honestly join: this view knows the
  // share COUNT but not what was paid for them, so shares have a move but no
  // level. Both figures appear in the readout either way; the toggle only
  // decides which one the axis carries.
  const [basis, setBasis] = useState('change')
  const [withShares, setWithShares] = useState(shares > 0)
  const [priceInput, setPriceInput] = useState(null)   // null = follow the spot

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const grid = isDark ? '#2d3748' : '#eef2f7'
  const inset = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'
  const GOOD = '#0ca30c'
  const CRIT = '#d03b3b'
  const TODAY = '#3b82f6'
  const EXPIRY = '#9333ea'
  const SHARES = '#f59e0b'

  const usd = (n) => n == null || !isFinite(n) ? '—'
    : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`
  const signed = (n) => n == null || !isFinite(n) ? '—'
    : `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`
  const pnlColor = (n) => n == null ? textMid : n >= 0 ? GOOD : CRIT

  const prepared = useMemo(
    () => legs.map(l => prepareLeg(l, spot)),
    [legs, spot])

  const { series, lo, hi, base, unpricedLegs } = useMemo(() => {
    const strikes = legs.map(l => l.strike)
    const gridPrices = priceGrid(spot, strikes)
    // Everything is measured against this, so it is computed once from the same
    // function that draws the curve. At today's price the change is exactly
    // zero and the total is exactly the panel's unrealized figure.
    const at0 = pnlAtPrice(prepared, spot, spot)
    const rows = gridPrices.map(p => {
      const r = pnlAtPrice(prepared, spot, p)
      return {
        price: p,
        todayTotal: r.today,
        expiryTotal: r.expiry,
        todayChange: r.today - at0.today,
        expiryChange: r.expiry - at0.expiry,
        sharesChange: shares > 0 ? shares * (p - spot) : null,
      }
    })
    return {
      series: rows,
      lo: gridPrices[0],
      hi: gridPrices[gridPrices.length - 1],
      base: at0,
      unpricedLegs: at0.unpriced,
    }
  }, [prepared, legs, spot, shares])

  const price = priceInput != null && priceInput > 0 ? priceInput : spot
  const at = useMemo(() => pnlAtPrice(prepared, spot, price), [prepared, spot, price])
  const sharesMove = shares > 0 ? shares * (price - spot) : 0
  const optionChange = at.today - base.today
  const combinedChange = optionChange + (withShares ? sharesMove : 0)
  const movePct = spot > 0 ? ((price - spot) / spot) * 100 : 0

  // Where a leg's kink sits. Deduplicated because two legs of a vertical often
  // share one, and a doubled label is unreadable.
  const strikeMarks = useMemo(() => {
    const seen = new Map()
    legs.forEach(l => {
      const k = seen.get(l.strike) || { strike: l.strike, parts: [] }
      k.parts.push(`${l.isLong ? '+' : '−'}${l.openContracts}${l.optionType === 'call' ? 'C' : 'P'}`)
      seen.set(l.strike, k)
    })
    return [...seen.values()].sort((a, b) => a.strike - b.strike)
  }, [legs])

  const yKeys = basis === 'change'
    ? { today: 'todayChange', expiry: 'expiryChange' }
    : { today: 'todayTotal', expiry: 'expiryTotal' }

  const CurveTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const row = payload[0]?.payload
    if (!row) return null
    const combined = row.todayChange + (withShares && row.sharesChange != null ? row.sharesChange : 0)
    return (
      <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 8, padding: '8px 12px', fontSize: 12, color: text }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          {ticker} at ${row.price.toFixed(2)}
          <span style={{ color: textMid, fontWeight: 500 }}>
            {' '}({row.price >= spot ? '+' : '−'}{Math.abs((row.price - spot) / spot * 100).toFixed(1)}%)
          </span>
        </div>
        <div style={{ color: TODAY }}>Options, if it gets there now: {signed(row.todayChange)}</div>
        <div style={{ color: EXPIRY }}>Options, held to expiry: {signed(row.expiryChange)}</div>
        {withShares && row.sharesChange != null && (
          <>
            <div style={{ color: SHARES }}>{shares.toLocaleString()} shares: {signed(row.sharesChange)}</div>
            <div style={{ fontWeight: 700, marginTop: 3, color: pnlColor(combined) }}>
              Together: {signed(combined)}
            </div>
          </>
        )}
      </div>
    )
  }

  const chipStyle = (on) => ({
    padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    borderRadius: 6, border: `1px solid ${on ? TODAY : border}`,
    background: on ? TODAY : 'transparent', color: on ? '#fff' : textMid,
  })

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: surface, borderRadius: 12, padding: 22, width: '94%', maxWidth: 980, maxHeight: '92vh', overflow: 'auto', border: `1px solid ${border}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, color: text }}>{ticker} — P&L if it moves</h2>
            <div style={{ fontSize: 12, color: textMid, marginTop: 2 }}>
              {legs.length} open leg{legs.length !== 1 ? 's' : ''} · now ${spot?.toFixed(2)}
              {shares > 0 && <> · {shares.toLocaleString()} shares held</>}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, width: 30, height: 30, fontSize: 16, cursor: 'pointer', flexShrink: 0 }}
          >×</button>
        </div>

        {/* Price picker. Typing a number is the whole point — "if RDDT goes to
            135" is how the question arrives, not as a percentage. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14, padding: '10px 12px', borderRadius: 8, background: inset, border: `1px solid ${border}` }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: text }}>If {ticker} is</span>
          <span style={{ fontSize: 13, color: textMid }}>$</span>
          <input
            type='number' step='0.01' min='0'
            value={priceInput != null ? priceInput : (spot ? spot.toFixed(2) : '')}
            onChange={(e) => setPriceInput(e.target.value === '' ? null : Number(e.target.value))}
            style={{ width: 92, padding: '5px 8px', fontSize: 14, fontWeight: 700, textAlign: 'right', borderRadius: 6, border: `1px solid ${border}`, background: surface, color: text }}
          />
          <span style={{ fontSize: 12, color: textMid }}>
            {movePct >= 0 ? '+' : '−'}{Math.abs(movePct).toFixed(1)}%
          </span>
          <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
            {[-20, -10, -5, 5, 10, 20].map(m => (
              <button key={m} onClick={() => setPriceInput(Number((spot * (1 + m / 100)).toFixed(2)))}
                style={{ ...chipStyle(false), padding: '3px 7px' }}>
                {m > 0 ? '+' : ''}{m}%
              </button>
            ))}
            <button onClick={() => setPriceInput(null)} style={{ ...chipStyle(false), padding: '3px 7px' }}>now</button>
          </div>
        </div>

        {/* The answer, before the chart — the chart is for the shape around it. */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${shares > 0 ? 3 : 2}, 1fr)`, gap: 8, marginTop: 10 }}>
          <Stat label='Options, if it gets there now' value={signed(optionChange)} color={pnlColor(optionChange)}
                sub={`total open P&L ${usd(at.today)}`} {...{ textMid, border, inset }} />
          <Stat label='Options, if it sits there to expiry' value={signed(at.expiry - base.expiry)} color={pnlColor(at.expiry - base.expiry)}
                sub={`total open P&L ${usd(at.expiry)}`} {...{ textMid, border, inset }} />
          {shares > 0 && (
            <Stat label={`With ${shares.toLocaleString()} shares`} value={signed(optionChange + sharesMove)}
                  color={pnlColor(optionChange + sharesMove)}
                  sub={`shares alone ${signed(sharesMove)}`} {...{ textMid, border, inset }} />
          )}
        </div>

        {/* Axis controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
          <span style={{ fontSize: 11, color: textMid, marginRight: 2 }}>Chart shows</span>
          <button onClick={() => setBasis('change')} style={chipStyle(basis === 'change')}>Change from today</button>
          <button onClick={() => setBasis('total')} style={chipStyle(basis === 'total')}>Total open P&L</button>
          {shares > 0 && basis === 'change' && (
            <button onClick={() => setWithShares(v => !v)}
              style={{ ...chipStyle(withShares), borderColor: withShares ? SHARES : border, background: withShares ? SHARES : 'transparent' }}>
              {withShares ? '✓ ' : ''}{shares.toLocaleString()} shares
            </button>
          )}
        </div>

        <div style={{ width: '100%', height: 330, marginTop: 8 }}>
          <ResponsiveContainer width='100%' height='100%'>
            <ComposedChart
              data={series}
              margin={{ top: 10, right: 20, left: 4, bottom: 4 }}
              onClick={(e) => { if (e?.activeLabel != null) setPriceInput(Number(Number(e.activeLabel).toFixed(2))) }}
            >
              <CartesianGrid stroke={grid} strokeDasharray='3 3' />
              <XAxis dataKey='price' type='number' domain={[lo, hi]} allowDecimals
                     tick={{ fontSize: 11, fill: textMid }} tickFormatter={(v) => `$${Math.round(v)}`} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: textMid }} width={70}
                     tickFormatter={(v) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`}
                     domain={['auto', 'auto']} />
              <Tooltip content={<CurveTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {/* Break-even for whatever the axis is showing. In change mode it
                  is today's price; in total mode it is where the position stops
                  costing money. */}
              <ReferenceLine y={0} stroke={textMid} strokeWidth={1} />
              <ReferenceLine x={spot} stroke={textMid} strokeDasharray='4 3'
                label={{ value: `now $${spot?.toFixed(2)}`, position: 'top', fill: textMid, fontSize: 10 }} />
              {strikeMarks.map(k => (
                <ReferenceLine key={k.strike} x={k.strike} stroke={textMid} strokeDasharray='2 4' strokeOpacity={0.55}
                  label={{ value: `${k.parts.join(' ')} @${k.strike}`, position: 'insideTopRight', fill: textMid, fontSize: 9, angle: -90, offset: 8 }} />
              ))}
              {withShares && basis === 'change' && shares > 0 && (
                <Line type='monotone' dataKey='sharesChange' name={`${shares.toLocaleString()} shares`}
                      stroke={SHARES} strokeWidth={1.5} strokeDasharray='5 3' dot={false} isAnimationActive={false} />
              )}
              <Line type='monotone' dataKey={yKeys.expiry} name='Options — held to expiry'
                    stroke={EXPIRY} strokeWidth={1.8} strokeDasharray='6 4' dot={false} isAnimationActive={false} />
              <Line type='monotone' dataKey={yKeys.today} name='Options — if it gets there now'
                    stroke={TODAY} strokeWidth={2.4} dot={false} isAnimationActive={false} />
              <ReferenceDot x={price} y={basis === 'change' ? optionChange : at.today} r={5}
                            fill={TODAY} stroke={surface} strokeWidth={2} isFront />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Leg by leg at the chosen price — where the number above comes from,
            so a surprising total can be traced to the leg causing it. */}
        <div style={{ fontSize: 12, fontWeight: 700, color: text, marginTop: 14, marginBottom: 6 }}>
          Each leg at ${price.toFixed(2)}
        </div>
        <div style={{ border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.8fr 0.9fr 0.9fr', gap: 8, padding: '6px 12px', fontSize: 10, fontWeight: 700, color: textMid, background: inset, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            <div>Leg</div><div style={{ textAlign: 'right' }}>Mark</div>
            <div style={{ textAlign: 'right' }}>P&L now</div><div style={{ textAlign: 'right' }}>P&L at expiry</div>
          </div>
          {prepared.map((leg, i) => {
            const one = pnlAtPrice([leg], spot, price)
            const settleMark = intrinsic(leg.optionType, price, leg.strike)
            // Back the modelled mark out of the P&L rather than recomputing it,
            // so the column can never disagree with the number beside it.
            const shown = leg.priced && leg.openContracts > 0
              ? (leg.isLong
                  ? (one.today / leg.openContracts + leg.avgCostPerContract) / 100
                  : (leg.avgCostPerContract - one.today / leg.openContracts) / 100)
              : null
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.8fr 0.9fr 0.9fr', gap: 8, alignItems: 'center', padding: '7px 12px', fontSize: 12, color: text, borderTop: `1px solid ${border}` }}>
                <div>
                  <span style={{ fontWeight: 600 }}>${leg.strike} {leg.optionType?.toUpperCase()}</span>
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: leg.isLong ? GOOD : '#f59e0b' }}>
                    {leg.isLong ? 'LONG' : 'SHORT'} {leg.openContracts}
                  </span>
                  <div style={{ fontSize: 10, color: textMid, marginTop: 1 }}>
                    exp {leg.expiry}
                    {leg.settling && ' · settled'}
                    {!leg.priced && ' · no mark'}
                  </div>
                </div>
                <div style={{ textAlign: 'right', color: textMid }}>
                  {shown != null ? `$${shown.toFixed(2)}` : '—'}
                  <div style={{ fontSize: 10 }}>settles ${settleMark.toFixed(2)}</div>
                </div>
                <div style={{ textAlign: 'right', fontWeight: 700, color: leg.priced ? pnlColor(one.today) : textMid }}>
                  {leg.priced ? usd(one.today) : '—'}
                </div>
                <div style={{ textAlign: 'right', fontWeight: 700, color: pnlColor(one.expiry) }}>
                  {usd(one.expiry)}
                </div>
              </div>
            )
          })}
        </div>

        {unpricedLegs > 0 && (
          <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 8 }}>
            {unpricedLegs} leg{unpricedLegs !== 1 ? 's have' : ' has'} no usable mark, so {unpricedLegs !== 1 ? 'they are' : 'it is'} missing
            from the “now” curve. The expiry curve is complete — settlement needs no mark.
          </div>
        )}

        <div style={{ fontSize: 11, color: textMid, marginTop: 10, lineHeight: 1.55 }}>
          Both curves are <strong>Black–Scholes estimates</strong>, anchored on each leg's own current mark, so at
          today's price they reproduce the P&L shown in the panel exactly. The{' '}
          <strong style={{ color: TODAY }}>solid line</strong> holds time and volatility still and moves only the
          stock — a gap to that price tomorrow. The{' '}
          <strong style={{ color: EXPIRY }}>dashed line</strong> settles every leg at exercise value, adding all the
          decay still to come. Volatility is fixed at what each mark implies today; a real selloff would lift it, so
          the downside on the solid line is the <em>optimistic</em> end of the range rather than a forecast.
          {shares > 0 && <> The share line is exact — {shares.toLocaleString()} × the move — and covers only the
          move from here, not what the shares have already made.</>}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, color, textMid, border, inset }) {
  return (
    <div style={{ padding: '9px 12px', borderRadius: 8, background: inset, border: `1px solid ${border}` }}>
      <div style={{ fontSize: 10, color: textMid, fontWeight: 600, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 10, color: textMid, marginTop: 2 }}>{sub}</div>
    </div>
  )
}
