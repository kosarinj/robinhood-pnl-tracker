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
