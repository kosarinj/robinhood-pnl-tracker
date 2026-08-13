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

console.log(`\n${passed} passed\n`)
