/**
 * Black-Scholes pricing and implied-vol inversion.
 *
 * Used for two jobs:
 *  - marking illiquid contracts when the data plan serves no live quote
 *  - repricing options during pre/post market, where the underlying trades but
 *    the option doesn't. There we calibrate sigma to the contract's own 4pm
 *    closing mark, then hold it constant and move only the underlying. Because
 *    sigma is calibrated, bsPrice(S_close, sigma) reproduces the closing mark
 *    exactly, so the estimate is continuous with the close instead of jumping
 *    to a model price at 4pm.
 */

export const RISK_FREE_RATE = 0.045

// Abramowitz & Stegun 26.2.17 — accurate to ~7.5e-8, plenty for marking.
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp(-x * x / 2)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x > 0 ? 1 - p : p
}

export function bsCall(S, K, T, r, sig) {
  if (T <= 0 || sig <= 0 || S <= 0 || K <= 0) return Math.max(0, S - K)
  const d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * Math.sqrt(T))
  const d2 = d1 - sig * Math.sqrt(T)
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
}

// Put-call parity: P = C - S + K·e^(-rT)
export function bsPut(S, K, T, r, sig) {
  if (T <= 0 || sig <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S)
  return bsCall(S, K, T, r, sig) - S + K * Math.exp(-r * T)
}

export function bsPrice(type, S, K, T, r, sig) {
  return type === 'put' ? bsPut(S, K, T, r, sig) : bsCall(S, K, T, r, sig)
}

/**
 * Invert price → sigma by bisection. Price is monotonically increasing in vol
 * for both calls and puts, so one search serves either.
 *
 * Returns 0 when inputs are unusable. A return at the solver bounds (0.001 or 5)
 * means the price is outside what any vol can produce — usually a stale or
 * crossed quote — and callers should reject it rather than store it.
 */
export function impliedVol(price, S, K, T, r, type = 'call') {
  if (price <= 0 || S <= 0 || K <= 0 || T <= 0) return 0
  let lo = 0.001, hi = 5, mid = 0
  if (price <= bsPrice(type, S, K, T, r, lo)) return lo
  if (price >= bsPrice(type, S, K, T, r, hi)) return hi
  for (let i = 0; i < 64; i++) {
    mid = (lo + hi) / 2
    const p = bsPrice(type, S, K, T, r, mid)
    if (Math.abs(p - price) < 1e-4) return mid
    if (p < price) lo = mid; else hi = mid
  }
  return mid
}

export function impliedVolCall(price, S, K, T, r) {
  return impliedVol(price, S, K, T, r, 'call')
}

/**
 * Reprice a contract from its last known mark after the underlying moved.
 *
 * Uses Black-Scholes for the *change* only, anchoring the level on the real
 * closing mark:
 *
 *     estMark = closeMark + [ BS(S1, T1) - BS(S0, T0) ]
 *
 * When sigma was calibrated to closeMark the bracket's second term equals
 * closeMark, so this reduces to plain BS repricing. The difference form matters
 * when sigma is poorly determined — a deep ITM contract is nearly all intrinsic,
 * so its price carries almost no vol information and the solver pins near zero.
 * Repricing off that degenerate sigma directly would throw away the extrinsic
 * still in the mark; taking the difference instead gives the change in intrinsic,
 * which is exactly right for a delta-1 contract, and preserves the real level.
 *
 * Returns null if inputs are unusable. Never returns less than intrinsic.
 */
export function repriceFromClose({ type, closeMark, S0, S1, K, T0, T1, sigma, r = RISK_FREE_RATE }) {
  if (!(closeMark >= 0) || !(S0 > 0) || !(S1 > 0) || !(K > 0) || !(T1 > 0)) return null
  if (!(sigma > 0)) return null
  const before = bsPrice(type, S0, K, T0, r, sigma)
  const after = bsPrice(type, S1, K, T1, r, sigma)
  const est = closeMark + (after - before)
  const intrinsic = type === 'put' ? Math.max(0, K - S1) : Math.max(0, S1 - K)
  return Math.max(intrinsic, est, 0)
}
