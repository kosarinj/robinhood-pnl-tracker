/**
 * Black-Scholes helpers for valuing and handicapping open spreads.
 *
 * The server already does this for marks (modelOptionMark / impliedVolCall in
 * server/index.js). This is the client-side counterpart, used for the one
 * question the server never answers: what are the odds this spread simply
 * expires worthless and the credit is kept.
 *
 * Risk-free rate matches the server's 0.045 so the two don't disagree.
 */
export const RISK_FREE = 0.045

/** Abramowitz & Stegun 26.2.17 — max error ~7.5e-8, ample for a probability. */
export function normCdf(x) {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937
  const b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419, c = 0.39894228
  const ax = Math.abs(x)
  if (ax > 8) return x > 0 ? 1 : 0
  const t = 1 / (1 + p * ax)
  const y = 1 - c * Math.exp(-ax * ax / 2) * t *
    (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1)
  return x > 0 ? y : 1 - y
}

const d1d2 = (S, K, T, r, sigma) => {
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / v
  return [d1, d1 - v]
}

/** Per-share Black-Scholes price. `type` is 'call' or 'put'. */
export function bsPrice(S, K, T, r, sigma, type) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0)) return null
  // At or past expiry there is no optionality left, only exercise value.
  if (!(T > 0)) return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S)
  const [d1, d2] = d1d2(S, K, T, r, sigma)
  const disc = K * Math.exp(-r * T)
  return type === 'call'
    ? S * normCdf(d1) - disc * normCdf(d2)
    : disc * normCdf(-d2) - S * normCdf(-d1)
}

/**
 * Implied vol by bisection from an observed per-share price.
 *
 * Bisection rather than Newton because vega collapses on deep out-of-the-money
 * contracts — exactly the strikes these spreads are sold at — and Newton then
 * diverges instead of converging. 100 halvings of [0.01, 5] is far more
 * precision than the input price justifies, and it cannot run away.
 */
export function impliedVol(price, S, K, T, r, type) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null
  const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S)
  // Below intrinsic there is no vol that fits; above the underlying, likewise.
  if (price < intrinsic - 1e-6) return null
  let lo = 0.01, hi = 5
  if (bsPrice(S, K, T, r, hi, type) < price) return null
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (bsPrice(S, K, T, r, mid, type) > price) hi = mid; else lo = mid
    if (hi - lo < 1e-7) break
  }
  return (lo + hi) / 2
}

/**
 * Risk-neutral probability the short strike is NOT breached at expiry — i.e.
 * the spread expires worthless and the whole credit is kept.
 *
 * Under the risk-neutral measure P(S_T > K) = N(d2), so a short call keeps its
 * credit with probability N(-d2) and a short put with N(d2).
 *
 * This is the risk-neutral probability, not a real-world forecast: it embeds
 * the market's implied vol and drifts at the risk-free rate, not at whatever
 * the stock is actually expected to do. It is the right number for "what are
 * the market's odds", and it is what option pricing itself is built on.
 */
export function probKeepCredit(S, shortStrike, T, sigma, type, r = RISK_FREE) {
  if (!(S > 0) || !(shortStrike > 0) || !(sigma > 0)) return null
  if (!(T > 0)) return (type === 'call' ? S < shortStrike : S > shortStrike) ? 1 : 0
  const [, d2] = d1d2(S, shortStrike, T, r, sigma)
  return type === 'call' ? normCdf(-d2) : normCdf(d2)
}

/** Years to expiry from a YYYY-MM-DD string, using the 16:00 ET close. */
export function yearsTo(expiry) {
  if (!expiry) return null
  const ms = new Date(`${expiry}T20:00:00Z`).getTime() - Date.now()
  return ms / (365.25 * 24 * 3600 * 1000)
}

// ─────────────────────────────────────────────────────────────────────────────
// Payoff curves — P&L on a ticker's open option legs across a range of
// underlying prices.
//
// The server already answers this at twelve fixed percentages (SCENARIO_MOVES
// in /api/options-pnl/ytd). This is the same repricing on a continuous price
// axis instead, so the question can be "what if RDDT is 135" rather than "what
// if RDDT moves 10%".
// ─────────────────────────────────────────────────────────────────────────────

/** Exercise value per share. */
export function intrinsic(type, S, K) {
  return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S)
}

/**
 * Reprice a contract after the underlying moves, anchored on its real mark.
 *
 * The client-side twin of repriceFromClose in server/utils/blackScholes.js, and
 * deliberately the same difference form:
 *
 *     est = mark + [ BS(S1) - BS(S0) ]
 *
 * Anchoring on the observed mark rather than substituting a model price is what
 * makes the curve pass exactly through today's Open P&L at today's price. A
 * curve that disagreed with the number printed beside it at zero move would be
 * unreadable — you couldn't tell a modelling artifact from a real move.
 *
 * The difference form also survives the deep-ITM case, where the price is all
 * intrinsic, carries no vol information, and the solver pins sigma at its
 * floor. Repricing off that sigma directly would throw away the extrinsic still
 * in the mark; differencing gives the change in intrinsic, which is right for a
 * delta-1 contract, and keeps the level honest.
 */
export function repriceFromAnchor({ type, mark, S0, S1, K, T0, T1 = T0, sigma, r = RISK_FREE }) {
  if (!(mark >= 0) || !(S0 > 0) || !(S1 > 0) || !(K > 0) || !(sigma > 0)) return null
  if (!(T1 > 0)) return intrinsic(type, S1, K)
  const before = bsPrice(S0, K, T0, r, sigma, type)
  const after = bsPrice(S1, K, T1, r, sigma, type)
  if (before == null || after == null) return null
  return Math.max(intrinsic(type, S1, K), mark + (after - before), 0)
}

/**
 * Attach the vol and time a leg needs to be repriced, backed out of its own
 * current mark (sticky strike).
 *
 * Three states come back, and they are not the same thing:
 *   settling  — no time left, so there is no optionality to model; the leg is
 *               worth exercise value at any price and needs no vol.
 *   priced    — vol recovered, the leg can be put on both curves.
 *   otherwise — no usable mark. The expiry curve still knows exactly what this
 *               leg pays, so it stays on that one; only the "today" curve has
 *               nothing to say about it, and the caller is told how many.
 */
export function prepareLeg(leg, spot) {
  const T = yearsTo(leg.expiry)
  const settling = !(T > 0)
  let sigma = null
  if (!settling && leg.markPrice > 0 && spot > 0) {
    // A floor rather than a rejection: a contract priced at pure intrinsic
    // admits no vol, but it is still a real leg with a real payoff.
    sigma = impliedVol(leg.markPrice, spot, leg.strike, T, RISK_FREE, leg.optionType) || 0.001
  }
  return { ...leg, T, sigma, settling, priced: settling || sigma > 0 }
}

/**
 * Dollars of P&L on one leg given a per-share mark.
 *
 * Mirrors /api/options-pnl/open-positions exactly — same cost-basis field, same
 * sign convention — so at today's price this reproduces the leg's printed
 * unrealized P&L to the cent instead of approximately.
 */
export function legPnlFromMark(leg, markPerShare) {
  const value = markPerShare * 100 * leg.openContracts
  const basis = leg.avgCostPerContract * leg.openContracts
  return leg.isLong ? value - basis : basis - value
}

/**
 * P&L on every leg at one underlying price, on two bases.
 *
 *   today  — time and vol held where they are, only the underlying moved. This
 *            is the move's effect on its own, which is what "if it gaps to 135
 *            tomorrow" means.
 *   expiry — every leg settled at exercise value. The move plus all remaining
 *            decay, and the ceiling a short position can reach.
 *
 * Real markets reprice vol on a large move, a selloff especially, so the
 * downside of the `today` curve is the optimistic end of a range rather than a
 * forecast.
 */
export function pnlAtPrice(preparedLegs, spot, S1) {
  let today = 0, expiry = 0, unpriced = 0
  for (const leg of preparedLegs) {
    expiry += legPnlFromMark(leg, intrinsic(leg.optionType, S1, leg.strike))
    if (leg.settling) {
      today += legPnlFromMark(leg, intrinsic(leg.optionType, S1, leg.strike))
    } else if (leg.priced) {
      const m = repriceFromAnchor({
        type: leg.optionType, mark: leg.markPrice, S0: spot, S1,
        K: leg.strike, T0: leg.T, sigma: leg.sigma,
      })
      if (m == null) { unpriced++; continue }
      today += legPnlFromMark(leg, m)
    } else {
      unpriced++
    }
  }
  return { today, expiry, unpriced }
}

/**
 * Price points to draw the curve over.
 *
 * Evenly spaced across the range, then every strike and today's price forced in
 * as their own points. Without that the kinks land wherever the sampling
 * happens to fall and a spread's corners get rounded off — the strikes are
 * exactly where the shape changes, so they are the points that must be exact.
 */
export function priceGrid(spot, strikes, { span = 0.35, steps = 80 } = {}) {
  const ks = strikes.filter(k => k > 0)
  const lo = Math.max(0.01, Math.min(spot * (1 - span), ...ks.map(k => k * 0.9)))
  const hi = Math.max(spot * (1 + span), ...ks.map(k => k * 1.1))
  const out = new Set()
  for (let i = 0; i <= steps; i++) out.add(lo + (hi - lo) * i / steps)
  out.add(spot)
  ks.forEach(k => { out.add(k); out.add(k - 0.01); out.add(k + 0.01) })
  return [...out].filter(p => p >= lo && p <= hi).sort((a, b) => a - b)
}

/**
 * Net + Open P&L for one ticker at a hypothetical underlying price.
 *
 * Anchored on whatever the grid is showing NOW, with only the CHANGES added:
 *
 *     netOpenNow + optionPnl(S1) - optionPnl(spot) + shares x (S1 - spot)
 *
 * Anchoring rather than rebuilding the figure from its parts is deliberate.
 * Net + Open is realized + stock + open options, and the stock term needs a
 * cost basis and a resolved "current" price — both of which the grid picks
 * through a chain of overrides and fallbacks. Reconstructing that here would
 * give two subtly different numbers on one screen. In a difference the cost
 * basis cancels outright, so only the share count is needed and the two figures
 * cannot disagree at today's price.
 *
 * Shares are unconditional. Net + Open includes the stock by definition, so a
 * version without it would be a different quantity wearing the same name — and
 * on a hedged position it would read as a disaster the shares are paying for.
 */
export function netOpenAtPrice({ netOpenNow, optionPnlAt, optionPnlNow, shares = 0, spot, price }) {
  if (netOpenNow == null || !Number.isFinite(netOpenNow)) return null
  if (!Number.isFinite(optionPnlAt) || !Number.isFinite(optionPnlNow)) return null
  const shareMove = shares > 0 && Number.isFinite(spot) && Number.isFinite(price)
    ? shares * (price - spot) : 0
  return netOpenNow + (optionPnlAt - optionPnlNow) + shareMove
}

/**
 * P&L on a set of legs after rolling time forward, with the underlying held.
 *
 * The decay half of the pair: pnlAtPrice moves the stock and holds time, this
 * holds the stock and moves time. Same anchoring, so at `years` = 0 it returns
 * today's figure exactly.
 *
 * Mirrors the server's projectAndShockLeg deliberately — including settling a
 * leg that expires inside the horizon at exercise value rather than decaying it,
 * which for a short is the max-profit case and not a guess. The client needs its
 * own copy because the one question the server cannot answer is this one
 * restricted to UNPAIRED short calls: what counts as a spread is decided by
 * pairSpreads, which is client-side on purpose so SpreadsPanel and the
 * roll-candidates pill can never disagree about it.
 *
 * `expired` counts legs that settle rather than decay, so a caller can say which
 * part of a gain is decay collected and which is a contract simply gone.
 */
export function projectedPnl(preparedLegs, spot, years) {
  let pnl = 0, expired = 0, total = 0, unpriced = 0
  for (const leg of preparedLegs) {
    const settleMark = intrinsic(leg.optionType, spot, leg.strike)
    if (leg.settling) {
      pnl += legPnlFromMark(leg, settleMark); expired++; total++
      continue
    }
    if (!leg.priced) { unpriced++; continue }
    const T1 = leg.T - years
    if (T1 <= 0) {
      pnl += legPnlFromMark(leg, settleMark); expired++; total++
      continue
    }
    const m = repriceFromAnchor({
      type: leg.optionType, mark: leg.markPrice, S0: spot, S1: spot,
      K: leg.strike, T0: leg.T, T1, sigma: leg.sigma,
    })
    if (m == null) { unpriced++; continue }
    pnl += legPnlFromMark(leg, m); total++
  }
  return { pnl, expired, total, unpriced }
}
