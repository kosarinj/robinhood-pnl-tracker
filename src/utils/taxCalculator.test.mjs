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

console.log(`\n${passed} passed\n`)
