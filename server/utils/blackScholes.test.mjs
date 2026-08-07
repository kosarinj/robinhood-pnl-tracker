/**
 * Run: node server/utils/blackScholes.test.mjs
 */
import assert from 'node:assert/strict'
import { bsCall, bsPut, bsPrice, impliedVol, repriceFromClose, RISK_FREE_RATE as r } from './blackScholes.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

console.log('\nBlack-Scholes')

test('call price matches a known reference', () => {
  // S=100 K=100 T=1 r=0.05 sig=0.2 → 10.4506 (standard textbook value)
  const c = bsCall(100, 100, 1, 0.05, 0.2)
  assert.ok(Math.abs(c - 10.4506) < 0.001, `got ${c}`)
})

test('put-call parity holds', () => {
  const S = 100, K = 95, T = 0.5, sig = 0.3
  const lhs = bsCall(S, K, T, r, sig) - bsPut(S, K, T, r, sig)
  const rhs = S - K * Math.exp(-r * T)
  assert.ok(Math.abs(lhs - rhs) < 1e-9, `${lhs} vs ${rhs}`)
})

test('deep ITM call approaches intrinsic', () => {
  const c = bsCall(200, 50, 0.1, r, 0.3)
  assert.ok(c >= 200 - 50 * Math.exp(-r * 0.1) - 0.01, `got ${c}`)
})

test('expired options return intrinsic', () => {
  assert.equal(bsCall(120, 100, 0, r, 0.3), 20)
  assert.equal(bsPut(80, 100, 0, r, 0.3), 20)
  assert.equal(bsCall(80, 100, 0, r, 0.3), 0)
})

console.log('\nImplied vol inversion')

test('round-trips for calls across strikes and tenors', () => {
  for (const K of [80, 100, 130]) {
    for (const T of [0.02, 0.25, 1.5]) {
      for (const sig of [0.15, 0.45, 1.2]) {
        const price = bsCall(100, K, T, r, sig)
        // Vega must be meaningful for vol to be recoverable at all — a price
        // that's essentially pure intrinsic carries no information about sigma.
        const extrinsic = price - Math.max(0, 100 - K * Math.exp(-r * T))
        if (price < 0.01 || extrinsic < 0.05) continue
        const back = impliedVol(price, 100, K, T, r, 'call')
        assert.ok(Math.abs(back - sig) < 0.01, `K=${K} T=${T} sig=${sig} → ${back}`)
      }
    }
  }
})

test('deep ITM price carries no vol information (solver pins low)', () => {
  // Documents the limitation that repriceFromClose is designed around.
  const price = bsCall(100, 80, 0.02, r, 0.15)
  assert.ok(impliedVol(price, 100, 80, 0.02, r, 'call') < 0.01)
})

test('round-trips for puts', () => {
  for (const K of [80, 100, 130]) {
    for (const sig of [0.2, 0.6]) {
      const price = bsPut(100, K, 0.5, r, sig)
      const back = impliedVol(price, 100, K, 0.5, r, 'put')
      assert.ok(Math.abs(back - sig) < 0.01, `K=${K} sig=${sig} → ${back}`)
    }
  }
})

test('rejects unusable input with 0', () => {
  assert.equal(impliedVol(0, 100, 100, 1, r), 0)
  assert.equal(impliedVol(5, 0, 100, 1, r), 0)
  assert.equal(impliedVol(5, 100, 100, 0, r), 0)
})

test('pins at the bound when price is unreachable', () => {
  // Above any achievable vol → returns hi bound, which the caller must reject.
  const sig = impliedVol(99, 100, 100, 1, r, 'call')
  assert.ok(sig >= 4.999, `got ${sig}`)
})

console.log('\nExtended-hours repricing')

test('calibrated sigma reproduces the closing mark exactly', () => {
  // This is the property the whole design rests on: no jump at 4pm.
  const S = 187.42, K = 190, T = 0.19
  const closeMark = 6.35                       // pretend this is the real 4pm mark
  const sigma = impliedVol(closeMark, S, K, T, r, 'call')
  const reproduced = bsPrice('call', S, K, T, r, sigma)
  assert.ok(Math.abs(reproduced - closeMark) < 0.001, `${reproduced} vs ${closeMark}`)
})

test('a pre-market gap moves the mark in the right direction and magnitude', () => {
  const S = 100, K = 105, T = 30 / 365.25
  const closeMark = 1.80
  const sigma = impliedVol(closeMark, S, K, T, r, 'call')

  const up = bsPrice('call', 102, K, T, r, sigma)      // +2% gap up
  const down = bsPrice('call', 98, K, T, r, sigma)     // -2% gap down
  assert.ok(up > closeMark, 'call should gain on a gap up')
  assert.ok(down < closeMark, 'call should lose on a gap down')

  // Delta on a slightly OTM 30-day call is roughly 0.35-0.45, so a $2 move
  // should be worth well under the full $2 and clearly more than nothing.
  const move = up - closeMark
  assert.ok(move > 0.2 && move < 1.4, `implied delta looks wrong: ${move} per $2`)
})

test('puts move opposite to calls on the same gap', () => {
  const S = 100, K = 95, T = 30 / 365.25
  const sigma = impliedVol(1.20, S, K, T, r, 'put')
  assert.ok(bsPrice('put', 98, K, T, r, sigma) > 1.20, 'put should gain on a gap down')
  assert.ok(bsPrice('put', 102, K, T, r, sigma) < 1.20, 'put should lose on a gap up')
})

test('overnight theta decays an unchanged underlying', () => {
  const S = 100, K = 100, T = 30 / 365.25
  const sigma = impliedVol(3.00, S, K, T, r, 'call')
  const nextDay = bsPrice('call', S, K, T - 1 / 365.25, r, sigma)
  assert.ok(nextDay < 3.00, `expected decay, got ${nextDay}`)
  assert.ok(3.00 - nextDay < 0.15, `one day of theta looks too large: ${3.00 - nextDay}`)
})

test('repriceFromClose is continuous with the close', () => {
  const S = 187.42, K = 190, T = 0.19, closeMark = 6.35
  const sigma = impliedVol(closeMark, S, K, T, r, 'call')
  // Same underlying, same instant → must return the closing mark untouched.
  const same = repriceFromClose({ type: 'call', closeMark, S0: S, S1: S, K, T0: T, T1: T, sigma })
  assert.ok(Math.abs(same - closeMark) < 1e-6, `${same} vs ${closeMark}`)
})

test('repriceFromClose handles a deep ITM contract as delta-1', () => {
  // The case that breaks naive repricing: sigma pins near zero, but the mark
  // must still track the underlying dollar-for-dollar.
  const S0 = 100, K = 60, T = 0.05
  const closeMark = 40.2
  const sigma = impliedVol(closeMark, S0, K, T, r, 'call') || 0.001
  const est = repriceFromClose({ type: 'call', closeMark, S0, S1: 103, K, T0: T, T1: T, sigma })
  assert.ok(Math.abs(est - 43.2) < 0.15, `expected ~43.2, got ${est}`)
})

test('repriceFromClose never returns below intrinsic', () => {
  const est = repriceFromClose({
    type: 'call', closeMark: 1.0, S0: 100, S1: 140, K: 100, T0: 0.1, T1: 0.1, sigma: 0.3,
  })
  assert.ok(est >= 40, `got ${est}`)
})

test('repriceFromClose matches plain BS when sigma is well calibrated', () => {
  const S0 = 100, K = 105, T0 = 30 / 365.25, T1 = 29 / 365.25, closeMark = 1.8
  const sigma = impliedVol(closeMark, S0, K, T0, r, 'call')
  const viaDiff = repriceFromClose({ type: 'call', closeMark, S0, S1: 102, K, T0, T1, sigma })
  const viaDirect = bsPrice('call', 102, K, T1, r, sigma)
  // The two differ by exactly the IV solver's residual (closeMark - BS(S0,sigma)),
  // which it stops refining at 1e-4. The difference form is the more accurate of
  // the two here: it lands on the real closing mark rather than the solver's
  // approximation of it.
  assert.ok(Math.abs(viaDiff - viaDirect) < 2e-4, `${viaDiff} vs ${viaDirect}`)
})

console.log(`\n${passed} passed\n`)
