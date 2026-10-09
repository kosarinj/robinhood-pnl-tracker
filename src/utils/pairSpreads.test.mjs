/**
 * Structures: a vertical plus whatever else is held at the same expiry.
 * Run: node src/utils/pairSpreads.test.mjs
 *
 * The spread rows price each vertical on its own, which is correct and is the
 * wrong question for a position with protection under it. Sell a 182.50 put
 * against a 180 and also buy a 175: pairSpreads matches the short with the
 * NEAREST long, so 182.50/180 is the spread and the 175 falls out as a loose
 * leg. On a selloff the vertical loses while the 175 pays. Both facts are true,
 * and only together do they describe the decision.
 *
 * Crediting the vertical with the 175's gain would be a lie, so this nets them
 * in a separate grouping instead. What is worth testing is that the netting
 * counts each contract exactly once -- a partly-paired leg has already given
 * its paired contracts to a spread, and counting the whole leg again inflates
 * the structure.
 */
import assert from 'node:assert/strict'
import { pairSpreads, buildStructures } from './pairSpreads.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}
const close = (a, b, tol = 0.02) => Math.abs(a - b) < tol

const EXP = '2026-10-16'
// avgCostPerContract is per contract; markPrice is per share.
const leg = (strike, optionType, isLong, n, cost, mark, extra = {}) => ({
  ticker: 'PLTR', expiry: EXP, optionType, isLong,
  openContracts: n, strike,
  avgCostPerContract: cost, markPrice: mark,
  unrealizedPnl: isLong ? (mark * 100 - cost) * n : (cost - mark * 100) * n,
  markSource: 'quote', stockPrice: 178,
  ...extra,
})

console.log('\nA vertical with an extra long put beneath it')

// The reported shape: short 182.50 / long 180 vertical, plus a 175 long.
// Stock fell, so the vertical is underwater and the 175 has paid.
const shortPut = leg(182.5, 'put', false, 1, 250, 4.60)   // credit 250, now 460 -> -210
const longPut180 = leg(180, 'put', true, 1, 150, 3.10)    // paid 150, now 310 -> +160
const longPut175 = leg(175, 'put', true, 1, 90, 2.40)     // paid 90, now 240 -> +150

const { spreads, singles } = pairSpreads([shortPut, longPut180, longPut175])

test('the short pairs with the NEAREST long, not the furthest', () => {
  // 180 is nearer to 182.50 than 175, and it is the leg actually capping the
  // risk. Pairing with the 175 would overstate the protection.
  assert.equal(spreads.length, 1, `expected one vertical, got ${spreads.length}`)
  assert.equal(spreads[0].shortStrike, 182.5)
  assert.equal(spreads[0].longStrike, 180)
})

test('the extra put falls out as a loose leg', () => {
  assert.equal(singles.length, 1, `expected one loose leg, got ${singles.length}`)
  assert.equal(singles[0].strike, 175)
  assert.equal(singles[0].remaining, 1)
})

test('the vertical reads as a loss, which is the truth about it', () => {
  // -210 on the short, +160 on the long.
  assert.ok(spreads[0].pnl < 0, `expected a loss, got ${spreads[0].pnl}`)
  assert.ok(close(spreads[0].pnl, -50), `expected about -50, got ${spreads[0].pnl}`)
})

const structures = buildStructures(spreads, singles)

test('the structure nets the vertical and the loose leg', () => {
  assert.equal(structures.length, 1, `expected one structure, got ${structures.length}`)
  const g = structures[0]
  // -50 from the vertical, +150 from the 175.
  assert.ok(close(g.pnl, 100), `expected about +100, got ${g.pnl}`)
  assert.ok(close(g.spreadPnl, -50), `spread part ${g.spreadPnl}`)
  assert.ok(close(g.loosePnl, 150), `loose part ${g.loosePnl}`)
})

test('the two parts add to the whole', () => {
  const g = structures[0]
  assert.ok(close(g.spreadPnl + g.loosePnl, g.pnl),
    `${g.spreadPnl} + ${g.loosePnl} != ${g.pnl}`)
})

test('it keys on ticker, expiry and type', () => {
  const g = structures[0]
  assert.equal(g.ticker, 'PLTR')
  assert.equal(g.expiry, EXP)
  assert.equal(g.type, 'put')
})

console.log('\nEach contract is counted once')

test('a partly-paired leg contributes only its unpaired contracts', () => {
  // 4 short against 3 long (two at 180, one at 175): three contracts pair
  // into verticals and one short is left over. Counting the whole short leg
  // again in the structure would double-count the three already inside them.
  //
  // pairSpreads consumes the nearest AVAILABLE long each time, so the 175
  // becomes a spread leg once the 180s are used up -- it is loose only when
  // no short is left wanting it.
  const s4 = leg(182.5, 'put', false, 4, 250, 4.60)   // credit 250/contract
  const l2 = leg(180, 'put', true, 2, 150, 3.10)
  const extra = leg(175, 'put', true, 1, 90, 2.40)
  const r = pairSpreads([s4, l2, extra])
  const loose = r.singles.find(x => x.strike === 182.5)
  assert.ok(loose, 'the leftover short should be a loose leg')
  assert.equal(loose.remaining, 1, `expected 1 unpaired contract, got ${loose.remaining}`)
  // The whole leg is -840 across four contracts; one of them is -210.
  assert.ok(close(loose.remainingPnl, -210),
    `expected a quarter of the leg (-210), got ${loose.remainingPnl}`)

  const g = buildStructures(r.spreads, r.singles)[0]
  const partsSum = g.parts.reduce((a, p) => a + (p.pnl || 0), 0)
  assert.ok(close(partsSum, g.pnl), `parts ${partsSum} != total ${g.pnl}`)
})

console.log('\nWhat it declines to show')

test('a lone vertical is not listed', () => {
  // Already answered by its own row above; repeating it here would bury the
  // cases that actually differ.
  const r = pairSpreads([shortPut, longPut180])
  assert.equal(buildStructures(r.spreads, r.singles).length, 0)
})

test('loose legs with no vertical are not listed either', () => {
  // That is the existing "legs not in a spread" list, and nothing is being
  // netted against anything.
  const r = pairSpreads([longPut175])
  assert.equal(buildStructures(r.spreads, r.singles).length, 0)
})

test('a different expiry is a different structure', () => {
  // The extra put is bought at the same expiry, so expiry is part of the key.
  // A diagonal reads as two structures rather than being silently merged.
  const far = { ...longPut175, expiry: '2026-11-20' }
  const r = pairSpreads([shortPut, longPut180, far])
  const g = buildStructures(r.spreads, r.singles)
  assert.equal(g.length, 0,
    'with the extra leg at another expiry there is no same-expiry structure')
})

test('an unpriced leg marks the total as partial', () => {
  const noMark = { ...longPut175, unrealizedPnl: null, markSource: null }
  const r = pairSpreads([shortPut, longPut180, noMark])
  const g = buildStructures(r.spreads, r.singles)[0]
  assert.ok(g, 'the structure should still appear')
  assert.equal(g.priced, false, 'a missing mark must be visible, not rounded to zero')
})

console.log(`\n${passed} passed\n`)
