/**
 * What-if price shock.
 * Run: node server/scenario.test.mjs
 *
 * Same repricing as the theta projection with the axes swapped: there the
 * underlying is held and time moves, here time is held and the underlying
 * moves. The property that matters is continuity — a 0% shock has to reproduce
 * today's number exactly, or the column contradicts the one beside it.
 */
import assert from 'node:assert/strict'
import { RISK_FREE_RATE, impliedVol, repriceFromClose } from './utils/blackScholes.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

// A short call: 100 shares' worth, sold for $3.00/share, stock at 100, strike
// 105, three months out.
const S = 100, K = 105, T = 0.25, MARK = 3.0, PREMIUM = 3.0, SHARES = 100
const sigma = impliedVol(MARK, S, K, T, RISK_FREE_RATE, 'call')

const shock = (movePct, type = 'call', k = K) => repriceFromClose({
  type, closeMark: MARK, S0: S, S1: S * (1 + movePct / 100),
  K: k, T0: T, T1: T, sigma, r: RISK_FREE_RATE,
})
// Short call P&L = premium kept minus what it costs to buy back.
const shortPnl = (mark) => (PREMIUM - mark) * SHARES

console.log('\nPrice shock')

test('vol is recoverable from the mark', () => {
  assert.ok(sigma > 0 && sigma < 5, `implausible sigma ${sigma}`)
})

test('a 0% shock reproduces the current mark exactly', () => {
  // Continuity with the Open P&L column beside it.
  const m = shock(0)
  assert.ok(Math.abs(m - MARK) < 1e-6, `expected ${MARK}, got ${m}`)
})

test('a rally hurts a short call', () => {
  const up = shock(10)
  assert.ok(up > MARK, `mark should rise: ${up} vs ${MARK}`)
  assert.ok(shortPnl(up) < 0, 'short call should be losing after a 10% rally')
})

test('a selloff helps a short call, but only up to the premium', () => {
  const down = shock(-10)
  assert.ok(down < MARK, `mark should fall: ${down} vs ${MARK}`)
  const pnl = shortPnl(down)
  assert.ok(pnl > 0, 'short call should be gaining')
  assert.ok(pnl <= PREMIUM * SHARES + 1e-6,
    `a short call can never make more than the premium: ${pnl} > ${PREMIUM * SHARES}`)
})

test('P&L falls monotonically as the stock rises', () => {
  const moves = [-30, -20, -15, -10, -5, -2.5, 2.5, 5, 10, 15, 20, 30]
  const pnls = moves.map(m => shortPnl(shock(m)))
  for (let i = 1; i < pnls.length; i++) {
    assert.ok(pnls[i] <= pnls[i - 1] + 1e-6,
      `not monotonic at ${moves[i]}%: ${pnls[i]} > ${pnls[i - 1]}`)
  }
})

test('a short put moves the other way', () => {
  const putSigma = impliedVol(MARK, S, 95, T, RISK_FREE_RATE, 'put')
  const rp = (movePct) => repriceFromClose({
    type: 'put', closeMark: MARK, S0: S, S1: S * (1 + movePct / 100),
    K: 95, T0: T, T1: T, sigma: putSigma, r: RISK_FREE_RATE,
  })
  assert.ok(rp(10) < MARK, 'a rally should make a put cheaper')
  assert.ok(rp(-10) > MARK, 'a selloff should make a put dearer')
})

test('a deep ITM call with no vol information still reprices sanely', () => {
  // Priced at pure intrinsic, so no vol can be backed out. The code floors
  // sigma rather than dropping the contract; the mark must still track the
  // stock roughly one-for-one instead of going backwards or NaN.
  const deepMark = 20
  const s = impliedVol(deepMark, S, 80, T, RISK_FREE_RATE, 'call') || 0.001
  const up = repriceFromClose({
    type: 'call', closeMark: deepMark, S0: S, S1: S * 1.1,
    K: 80, T0: T, T1: T, sigma: s, r: RISK_FREE_RATE,
  })
  assert.ok(Number.isFinite(up), 'must not be NaN')
  assert.ok(up > deepMark, `deep ITM call should gain with the stock: ${up}`)
})

console.log('\nLong legs offset short ones')

// A vertical: short the 105, long the 110, both three months out.
const SHORT_K = 105, LONG_K = 110
const shortMark = 3.0, longMark = 1.6
const shortSigma = impliedVol(shortMark, S, SHORT_K, T, RISK_FREE_RATE, 'call')
const longSigma = impliedVol(longMark, S, LONG_K, T, RISK_FREE_RATE, 'call')
const longCostPerShare = 1.4      // paid 1.40/share, now marked 1.60

const legAt = (movePct) => {
  const S1 = S * (1 + movePct / 100)
  const sm = repriceFromClose({ type: 'call', closeMark: shortMark, S0: S, S1, K: SHORT_K, T0: T, T1: T, sigma: shortSigma, r: RISK_FREE_RATE })
  const lm = repriceFromClose({ type: 'call', closeMark: longMark, S0: S, S1, K: LONG_K, T0: T, T1: T, sigma: longSigma, r: RISK_FREE_RATE })
  return {
    short: (PREMIUM - sm) * SHARES,              // premium kept − cost to buy back
    long: (lm - longCostPerShare) * SHARES,      // mark − what was paid
  }
}

test('a long call gains as the stock rises, opposite the short', () => {
  const up = legAt(10)
  assert.ok(up.long > 0, `long leg should gain on a rally: ${up.long}`)
  assert.ok(up.short < 0, `short leg should lose on a rally: ${up.short}`)
})

test('on a rally the pair loses strictly less than the short leg alone', () => {
  // The bug: only short legs were counted, so a rally showed the full short-leg
  // loss with nothing offsetting it. That read far worse than the position did.
  for (const move of [5, 10, 15, 20, 30]) {
    const { short, long } = legAt(move)
    assert.ok(short + long > short,
      `at +${move}% the pair (${(short + long).toFixed(2)}) should beat short-only (${short.toFixed(2)})`)
    assert.ok(long > 0, `at +${move}% the long leg should be positive, got ${long.toFixed(2)}`)
  }
})

test('a long leg reduces the gain on a selloff rather than adding to it', () => {
  // Symmetry check: the offset cuts both ways, so it isn't a free improvement.
  const { short, long } = legAt(-10)
  assert.ok(short > 0, 'short leg gains on a selloff')
  assert.ok(long < 0, 'long leg loses on a selloff')
  assert.ok(short + long < short, 'the pair must gain less than the short leg alone')
})

test('a 0% shock leaves each leg at its current value', () => {
  // Keeps the what-if column continuous with Open P&L now that longs are in it.
  const { short, long } = legAt(0)
  assert.ok(Math.abs(short - (PREMIUM - shortMark) * SHARES) < 1e-6, `short ${short}`)
  assert.ok(Math.abs(long - (longMark - longCostPerShare) * SHARES) < 1e-6, `long ${long}`)
})

console.log(`\n${passed} passed\n`)
