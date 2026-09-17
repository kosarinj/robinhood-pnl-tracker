/**
 * Tax engine: broker-scoped lot matching.
 * Run: node src/utils/taxCalculator.test.mjs
 *
 * The bug: lots were keyed by symbol alone, so the engine matched across
 * whatever trade list it was handed. "All brokers" therefore matched a buy at
 * one broker against a sell at another, while a single-broker tab did not —
 * two different answers from the same data.
 */
import assert from 'node:assert/strict'
import { buildTaxBase, summarizeTaxYear } from './taxCalculator.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

const t = (o) => ({
  symbol: 'AAPL', isOption: false, quantity: 10, price: 100,
  amount: -1000, isBuy: true, date: '2026-03-02', broker: 'robinhood', ...o,
})

const realizedFor = (trades, year = 2026) =>
  summarizeTaxYear(buildTaxBase(trades, []), year).totalRealizedGain

console.log('\nPer-broker lot matching')

test('a sale only consumes lots from its own broker', () => {
  // RH: buy 10 @ 100. WB: buy 10 @ 200, sell 10 @ 250.
  // Correct WB gain = 500. Cross-broker FIFO would take the $100 lot → 1500.
  const trades = [
    t({ broker: 'robinhood', price: 100, amount: -1000 }),
    t({ broker: 'webull', price: 200, amount: -2000, date: '2026-03-03' }),
    t({ broker: 'webull', price: 250, amount: 2500, isBuy: false, date: '2026-03-10' }),
  ]
  assert.equal(realizedFor(trades), 500)
})

test('the parts sum to the whole', () => {
  // The property the user actually noticed: per-broker tabs must total the
  // All Brokers figure.
  const trades = [
    t({ broker: 'robinhood', price: 100, amount: -1000 }),
    t({ broker: 'robinhood', price: 130, amount: 1300, isBuy: false, date: '2026-04-01' }),
    t({ broker: 'webull', price: 200, amount: -2000, date: '2026-03-03' }),
    t({ broker: 'webull', price: 250, amount: 2500, isBuy: false, date: '2026-03-10' }),
  ]
  const all = realizedFor(trades)
  const rh = realizedFor(trades.filter(x => x.broker === 'robinhood'))
  const wb = realizedFor(trades.filter(x => x.broker === 'webull'))
  assert.equal(rh + wb, all, `${rh} + ${wb} != ${all}`)
  assert.equal(all, 800)   // 300 at RH + 500 at WB
})

test('open lots stay separate per broker', () => {
  const trades = [
    t({ broker: 'robinhood', quantity: 10, price: 100 }),
    t({ broker: 'webull', quantity: 5, price: 200 }),
  ]
  const lots = buildTaxBase(trades, []).openLots
  assert.equal(lots.length, 2, `expected 2 lots, got ${lots.length}`)
  assert.deepEqual(lots.map(l => l.broker).sort(), ['robinhood', 'webull'])
})

console.log('\nTransferred shares (buy at one broker, sell at the other)')

const transferred = [
  t({ broker: 'robinhood', quantity: 10, price: 100, amount: -1000 }),
  t({ broker: 'webull', quantity: 10, price: 150, amount: 1500, isBuy: false, date: '2026-05-01' }),
]

test('the unmatched sale is flagged, not silently dropped', () => {
  const s = summarizeTaxYear(buildTaxBase(transferred, []), 2026)
  assert.equal(s.unreconciled.length, 1, 'transferred sale was not flagged')
  assert.equal(s.unreconciled[0].broker, 'webull')
  assert.equal(s.unreconciled[0].quantity, 10)
  assert.equal(s.unreconciledProceeds, 1500)
})

test('its gain is excluded from the totals, so the warning is not cosmetic', () => {
  // Documents the real limitation: without the buy at that broker there is no
  // basis, so this gain genuinely cannot be computed — hence the banner.
  const s = summarizeTaxYear(buildTaxBase(transferred, []), 2026)
  assert.equal(s.totalRealizedGain, 0)
})

test('the source broker still shows the shares as open', () => {
  const lots = buildTaxBase(transferred, []).openLots
  assert.equal(lots.length, 1)
  assert.equal(lots[0].broker, 'robinhood')
  assert.equal(lots[0].quantity, 10)
})

console.log('\nBackward compatibility')

test('trades with no broker behave exactly as before', () => {
  const trades = [
    { symbol: 'AAPL', isOption: false, quantity: 10, price: 100, amount: -1000, isBuy: true, date: '2026-03-02' },
    { symbol: 'AAPL', isOption: false, quantity: 10, price: 130, amount: 1300, isBuy: false, date: '2026-04-01' },
  ]
  assert.equal(realizedFor(trades), 300)
  assert.equal(summarizeTaxYear(buildTaxBase(trades, []), 2026).unreconciled.length, 0)
})

console.log('\nShort sales (SS opens, BC covers)')

test('a short round trip books sale price less cover price', () => {
  // Short 10 @ 250, cover 10 @ 200 = +500. Nothing else is held.
  const trades = [
    t({ transCode: 'SS', isBuy: false, price: 250, amount: 2500, date: '2026-03-02' }),
    t({ transCode: 'BC', isBuy: true, price: 200, amount: -2000, date: '2026-03-05' }),
  ]
  assert.equal(realizedFor(trades), 500)
})

test('a short does not eat the long lots, and a cover does not create one', () => {
  // The AMD shape: 5 shares held at 100, a 10-share short round trip, then the
  // 5 are sold at 300. Correct: 500 on the short + 1000 on the shares = 1500.
  // Treating SS as a sale and BC as a purchase gave 1250 and invented a lot.
  const trades = [
    t({ quantity: 5, price: 100, amount: -500, isBuy: true, date: '2026-03-01' }),
    t({ transCode: 'SS', isBuy: false, quantity: 10, price: 250, amount: 2500, date: '2026-03-02' }),
    t({ transCode: 'BC', isBuy: true, quantity: 10, price: 200, amount: -2000, date: '2026-03-05' }),
    t({ quantity: 5, price: 300, amount: 1500, isBuy: false, date: '2026-03-10' }),
  ]
  assert.equal(realizedFor(trades), 1500)
  assert.equal(summarizeTaxYear(buildTaxBase(trades, []), 2026).unreconciled.length, 0)
})

test('covering more than was shorted leaves the excess as a real purchase', () => {
  // Short 5 @ 250, cover 8 @ 200: +250 on the short, 3 shares held at 200.
  const trades = [
    t({ transCode: 'SS', isBuy: false, quantity: 5, price: 250, amount: 1250, date: '2026-03-02' }),
    t({ transCode: 'BC', isBuy: true, quantity: 8, price: 200, amount: -1600, date: '2026-03-05' }),
  ]
  const base = buildTaxBase(trades, [])
  assert.equal(summarizeTaxYear(base, 2026).totalRealizedGain, 250)
  const lots = base.openLots.filter(l => l.symbol === 'AAPL')
  assert.equal(lots.length, 1)
  assert.equal(lots[0].quantity, 3)
})

test('the cover date is when it is realised', () => {
  // Shorted in 2025, covered in 2026 — the gain belongs to 2026.
  const trades = [
    t({ transCode: 'SS', isBuy: false, price: 250, amount: 2500, date: '2025-12-20' }),
    t({ transCode: 'BC', isBuy: true, price: 200, amount: -2000, date: '2026-01-06' }),
  ]
  assert.equal(realizedFor(trades, 2025), 0)
  assert.equal(realizedFor(trades, 2026), 500)
})

console.log(`\n${passed} passed\n`)
