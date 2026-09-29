/**
 * Payoff curves.
 * Run: node src/utils/optionMath.test.mjs
 *
 * The property the whole chart rests on is continuity: at today's price the
 * curve has to reproduce the unrealized P&L printed beside it, to the cent. If
 * it doesn't, a reader can't tell a modelling artifact from a real move, and
 * every number further out on the axis is suspect too.
 *
 * The rest is shape — which way each kind of leg leans, and that a spread's
 * loss is bounded where the long leg caps it.
 */
import assert from 'node:assert/strict'
import {
  repriceFromAnchor, prepareLeg, pnlAtPrice, priceGrid,
} from './optionMath.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol

// Expiry far enough out that decay isn't the story; the price axis is.
const EXPIRY = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
const SPOT = 100

// The shapes actually held: a short call against shares, a call vertical, a
// long put, and a put vertical.
const shortCall = { strike: 110, optionType: 'call', expiry: EXPIRY, openContracts: 2, isLong: false, avgCostPerContract: 300, markPrice: 2.4 }
const longCall  = { strike: 120, optionType: 'call', expiry: EXPIRY, openContracts: 2, isLong: true,  avgCostPerContract: 120, markPrice: 1.1 }
const longPut   = { strike:  95, optionType: 'put',  expiry: EXPIRY, openContracts: 2, isLong: true,  avgCostPerContract: 400, markPrice: 3.6 }
const shortPut  = { strike:  85, optionType: 'put',  expiry: EXPIRY, openContracts: 2, isLong: false, avgCostPerContract: 180, markPrice: 1.5 }

const ALL = [shortCall, longCall, longPut, shortPut]
const prep = ALL.map(l => prepareLeg(l, SPOT))

// What /api/options-pnl/open-positions prints for each leg today.
const printedPnl = (leg) => leg.isLong
  ? leg.markPrice * 100 * leg.openContracts - leg.avgCostPerContract * leg.openContracts
  : leg.avgCostPerContract * leg.openContracts - leg.markPrice * 100 * leg.openContracts

console.log('\nContinuity with what the panel already prints')

test('every leg recovers a usable vol from its own mark', () => {
  prep.forEach((l, i) => {
    assert.ok(l.priced, `${ALL[i].optionType} ${ALL[i].strike} was not priced`)
    assert.ok(l.sigma > 0 && l.sigma < 5, `implausible sigma ${l.sigma}`)
  })
})

test('at today price the curve equals the sum of the printed leg P&Ls', () => {
  const want = ALL.reduce((s, l) => s + printedPnl(l), 0)
  const got = pnlAtPrice(prep, SPOT, SPOT).today
  assert.ok(close(got, want, 1e-6), `curve ${got} vs printed ${want}`)
})

test('each leg on its own is continuous too', () => {
  ALL.forEach(l => {
    const got = pnlAtPrice([prepareLeg(l, SPOT)], SPOT, SPOT).today
    assert.ok(close(got, printedPnl(l), 1e-6), `${l.optionType} ${l.strike}: ${got} vs ${printedPnl(l)}`)
  })
})

test('a 0% move reproduces the anchor mark exactly', () => {
  const l = prepareLeg(shortCall, SPOT)
  const m = repriceFromAnchor({ type: 'call', mark: l.markPrice, S0: SPOT, S1: SPOT, K: l.strike, T0: l.T, sigma: l.sigma })
  assert.ok(close(m, l.markPrice), `expected ${l.markPrice}, got ${m}`)
})

console.log('\nShape')

test('a short call loses as the stock rises, a long call gains', () => {
  const sc = prepareLeg(shortCall, SPOT), lc = prepareLeg(longCall, SPOT)
  const at = (S) => [pnlAtPrice([sc], SPOT, S).today, pnlAtPrice([lc], SPOT, S).today]
  const [s0, l0] = at(SPOT), [s1, l1] = at(SPOT * 1.15)
  assert.ok(s1 < s0, `short call should lose on a rally: ${s1} vs ${s0}`)
  assert.ok(l1 > l0, `long call should gain on a rally: ${l1} vs ${l0}`)
})

test('a long put gains as the stock falls', () => {
  const lp = prepareLeg(longPut, SPOT)
  const down = pnlAtPrice([lp], SPOT, SPOT * 0.85).today
  const flat = pnlAtPrice([lp], SPOT, SPOT).today
  assert.ok(down > flat, `long put should gain on a selloff: ${down} vs ${flat}`)
})

test('the today curve is monotonic in price for a single call leg', () => {
  const sc = prepareLeg(shortCall, SPOT)
  const grid = priceGrid(SPOT, [110])
  const ys = grid.map(p => pnlAtPrice([sc], SPOT, p).today)
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] <= ys[i - 1] + 1e-6, `not monotonic at ${grid[i].toFixed(2)}: ${ys[i]} > ${ys[i - 1]}`)
  }
})

console.log('\nThe long leg caps the loss')

test('a call vertical loss is bounded; a naked short call is not', () => {
  // The bug this guards: counting only the short leg. A rally then shows an
  // unbounded loss on a position whose long leg caps it, which reads like a
  // margin call that isn't coming.
  const vertical = [shortCall, longCall].map(l => prepareLeg(l, SPOT))
  const nakedOnly = [prepareLeg(shortCall, SPOT)]
  const far = SPOT * 3
  const vExp = pnlAtPrice(vertical, SPOT, far).expiry
  const nExp = pnlAtPrice(nakedOnly, SPOT, far).expiry
  assert.ok(vExp > nExp, `vertical (${vExp}) must beat naked (${nExp}) on a big rally`)
  // Width minus net credit is the floor, and no price goes below it.
  const worst = Math.min(...priceGrid(SPOT, [110, 120], { span: 2 }).map(p => pnlAtPrice(vertical, SPOT, p).expiry))
  const width = (120 - 110) * 100 * 2
  const netCredit = 300 * 2 - 120 * 2
  assert.ok(close(worst, netCredit - width, 1e-6), `floor should be ${netCredit - width}, got ${worst}`)
})

test('a short call can never make more than the premium it collected', () => {
  const sc = prepareLeg(shortCall, SPOT)
  const best = Math.max(...priceGrid(SPOT, [110], { span: 0.9 }).map(p => pnlAtPrice([sc], SPOT, p).expiry))
  assert.ok(close(best, 300 * 2, 1e-6), `max should be the ${300 * 2} credit, got ${best}`)
})

console.log('\nUnpriced legs are counted, not silently dropped')

test('a leg with no mark stays on the expiry curve and is reported missing from today', () => {
  const noMark = prepareLeg({ ...longCall, markPrice: 0 }, SPOT)
  const r = pnlAtPrice([noMark], SPOT, 130)
  assert.equal(r.unpriced, 1, 'should report one leg it could not model')
  assert.equal(r.today, 0, 'contributes nothing to the today curve')
  // At 130 the 120 call is 10 in the money: 10 x 100 x 2 = 2000, less 120 x 2 paid.
  assert.ok(close(r.expiry, 10 * 100 * 2 - 120 * 2, 1e-6), `expiry P&L ${r.expiry}`)
})

test('a leg past its close is settled, not dropped', () => {
  // Open positions are filtered to expiry >= today, so on expiration day after
  // 16:00 ET a leg with no time left is still in the list. There is no vol to
  // back out of it and nothing missing either — it is worth exercise value.
  const past = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  const settling = prepareLeg({ ...shortCall, expiry: past }, SPOT)
  assert.ok(settling.settling, 'should be flagged as settling')
  const r = pnlAtPrice([settling], SPOT, 115)
  assert.equal(r.unpriced, 0, 'nothing is missing — there is just no optionality left')
  assert.ok(close(r.today, r.expiry, 1e-6), 'today and expiry coincide once time is gone')
  assert.ok(close(r.today, 300 * 2 - 5 * 100 * 2, 1e-6), `got ${r.today}`)
})

test('a leg expiring today keeps the hours it still has', () => {
  // Not the same as settled: before the close there is real optionality left,
  // and flattening it to intrinsic would overstate a short seller's profit on
  // the last day — exactly when the position is most worth reading correctly.
  // Expire it tomorrow so the test holds whatever time of day it runs at.
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10)
  const near = prepareLeg({ ...shortCall, expiry: tomorrow }, SPOT)
  assert.ok(!near.settling, 'still has time on it')
  assert.ok(near.priced && near.sigma > 0, 'vol should still come out of the mark')
  const r = pnlAtPrice([near], SPOT, SPOT)
  assert.ok(close(r.today, printedPnl({ ...shortCall, expiry: tomorrow }), 1e-6),
    `continuity must hold on the last day too: ${r.today}`)
  // Curve and settlement differ by whatever extrinsic is left, and the short
  // seller has yet to collect it.
  assert.ok(r.expiry > r.today, `expiry (${r.expiry}) should beat today (${r.today}) for a short`)
})

console.log('\nThe grid')

test('today price and every strike are exact points on the axis', () => {
  const grid = priceGrid(SPOT, [85, 95, 110, 120])
  assert.ok(grid.includes(SPOT), 'spot must be a point, or the curve misses its own anchor')
  for (const k of [85, 95, 110, 120]) {
    assert.ok(grid.includes(k), `strike ${k} must be a point — the kink is there`)
  }
})

test('the grid spans every strike with room past the outermost', () => {
  const grid = priceGrid(SPOT, [85, 95, 110, 120])
  assert.ok(grid[0] < 85, `low end ${grid[0]} should sit below the lowest strike`)
  assert.ok(grid[grid.length - 1] > 120, `high end should sit above the highest strike`)
  assert.ok(grid.every((p, i) => i === 0 || p >= grid[i - 1]), 'must be sorted')
})

test('a far strike widens the axis rather than falling off it', () => {
  // A 200 strike on a 100 stock is outside the default span. Clipping it would
  // hide that leg's kink entirely.
  const grid = priceGrid(SPOT, [200])
  assert.ok(grid.includes(200), 'a strike beyond the default span must still be on the axis')
})

console.log(`\n${passed} passed\n`)
