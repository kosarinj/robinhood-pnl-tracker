/**
 * Multi-broker correctness tests.
 * Run: node server/services/multiBroker.test.mjs
 *
 * The thing under test: buy/sell matching must stay inside a broker. A sale at
 * one broker closing a lot at another would silently produce wrong realized
 * P&L, which is the kind of bug that looks fine until tax time.
 */
import assert from 'node:assert/strict'
import { calculatePnL } from './pnlCalculator.js'
import { parseWebullOrders, normalizeWebullOption, parseWebullDate } from './webullParser.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

const trade = (o) => ({
  symbol: 'AAPL', instrument: 'AAPL', description: 'Apple', isOption: false,
  quantity: 1, price: 100, amount: -100, isBuy: true, contracts: 1,
  date: '2026-01-02', transDate: '2026-01-02', transCode: 'Buy', broker: 'robinhood',
  ...o,
})

// Silence the calculator's console noise during tests.
const realLog = console.log
const quiet = (fn) => { console.log = () => {}; try { return fn() } finally { console.log = realLog } }

console.log('\nBroker-scoped matching')

test('a sale at one broker cannot close a lot at another', () => {
  // Bought 1 @ $100 at Robinhood. Bought 1 @ $200 at Webull, sold it @ $250.
  // Webull realized = $50. If matching crossed brokers, FIFO would pair the
  // $250 sale against the $100 Robinhood lot and report $150.
  const trades = [
    trade({ broker: 'robinhood', price: 100, amount: -100, isBuy: true }),
    trade({ broker: 'webull', price: 200, amount: -200, isBuy: true, date: '2026-01-03', transDate: '2026-01-03' }),
    trade({ broker: 'webull', price: 250, amount: 250, isBuy: false, transCode: 'Sell', date: '2026-01-04', transDate: '2026-01-04' }),
  ]
  const [row] = quiet(() => calculatePnL(trades, { AAPL: 300 }))
  assert.equal(row.fifo.realizedPnL, 50, `expected $50 realized, got ${row.fifo.realizedPnL}`)
})

test('positions from both brokers add up', () => {
  const trades = [
    trade({ broker: 'robinhood', quantity: 10, amount: -1000 }),
    trade({ broker: 'webull', quantity: 5, amount: -500 }),
  ]
  const [row] = quiet(() => calculatePnL(trades, { AAPL: 100 }))
  assert.equal(row.real.position, 15, `expected 15 shares, got ${row.real.position}`)
})

test('merged row reports both brokers', () => {
  const trades = [
    trade({ broker: 'robinhood' }),
    trade({ broker: 'webull' }),
  ]
  const [row] = quiet(() => calculatePnL(trades, { AAPL: 100 }))
  assert.deepEqual([...row.brokers].sort(), ['robinhood', 'webull'])
  assert.equal(row.broker, 'multiple')
})

test('byBroker keeps each broker\'s own untouched numbers', () => {
  // Guards a shallow-copy bug where merging mutated the first broker's row.
  const trades = [
    trade({ broker: 'robinhood', quantity: 10, amount: -1000 }),
    trade({ broker: 'webull', quantity: 5, amount: -500 }),
  ]
  const [row] = quiet(() => calculatePnL(trades, { AAPL: 100 }))
  assert.equal(row.byBroker.robinhood.real.position, 10, 'robinhood leg was mutated by the merge')
  assert.equal(row.byBroker.webull.real.position, 5)
})

test('cost basis is weighted by size, not averaged', () => {
  // 100 shares @ $10 and 1 share @ $500. A naive average gives $255;
  // the correct weighted basis is ~$14.85.
  const trades = [
    trade({ broker: 'robinhood', quantity: 100, price: 10, amount: -1000 }),
    trade({ broker: 'webull', quantity: 1, price: 500, amount: -500 }),
  ]
  const [row] = quiet(() => calculatePnL(trades, { AAPL: 20 }))
  assert.ok(Math.abs(row.real.avgCostBasis - 14.85) < 0.2,
    `expected ~14.85 weighted basis, got ${row.real.avgCostBasis}`)
})

test('a single-broker account is completely unaffected', () => {
  const trades = [
    trade({ quantity: 10, amount: -1000 }),
    trade({ quantity: 4, amount: 600, isBuy: false, transCode: 'Sell', price: 150, date: '2026-02-01', transDate: '2026-02-01' }),
  ]
  const [row] = quiet(() => calculatePnL(trades, { AAPL: 120 }))
  assert.equal(row.real.position, 6)
  assert.equal(row.brokers.length, 1)
  assert.equal(row.broker, 'robinhood')
})

test('trades with no broker default to robinhood', () => {
  const t = trade({})
  delete t.broker
  const [row] = quiet(() => calculatePnL([t], { AAPL: 100 }))
  assert.equal(row.broker, 'robinhood')
})

console.log('\nWebull parser')

test('parses dates without shifting the calendar day', () => {
  // 11pm EDT must not roll into the next day (or a different tax year).
  assert.equal(parseWebullDate('08/07/2026 11:01:13 EDT'), '2026-08-07')
  assert.equal(parseWebullDate('12/31/2026 23:59:00 EST'), '2026-12-31')
})

test('reads a filled stock order', () => {
  const csv = [
    'Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time',
    'Apple Inc,AAPL,Buy,Filled,2,2,@310.0500000000,310.0500000000,DAY,06/01/2026 07:21:12 EDT,06/01/2026 07:21:32 EDT',
  ].join('\n')
  const { trades } = parseWebullOrders(csv)
  assert.equal(trades.length, 1)
  const t = trades[0]
  assert.equal(t.symbol, 'AAPL')
  assert.equal(t.quantity, 2)
  assert.equal(t.isBuy, true)
  assert.equal(t.broker, 'webull')
  assert.ok(Math.abs(t.amount - -620.10) < 0.01, `amount ${t.amount}`)
})

test('a buy costs money and a sell brings it in', () => {
  const csv = [
    'Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time',
    'Apple Inc,AAPL,Buy,Filled,1,1,@100,100,DAY,06/01/2026 07:21:12 EDT,06/01/2026 07:21:32 EDT',
    'Apple Inc,AAPL,Sell,Filled,1,1,@150,150,DAY,06/02/2026 07:21:12 EDT,06/02/2026 07:21:32 EDT',
  ].join('\n')
  const { trades } = parseWebullOrders(csv)
  assert.equal(trades[0].amount, -100)
  assert.equal(trades[1].amount, 150)
})

test('skips cancelled orders and uses filled quantity on partials', () => {
  const csv = [
    'Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time',
    'Apple Inc,AAPL,Buy,Cancelled,0,5,@100,,DAY,06/01/2026 07:21:12 EDT,',
    'Apple Inc,AAPL,Buy,Partially Filled,2,5,@100,100,DAY,06/01/2026 07:21:12 EDT,06/01/2026 07:21:32 EDT',
  ].join('\n')
  const { trades, skipped } = parseWebullOrders(csv)
  assert.equal(trades.length, 1, 'cancelled order should be dropped')
  assert.equal(skipped, 1)
  assert.equal(trades[0].quantity, 2, 'should use Filled, not Total Qty')
})

test('rejects a file that is not a Webull export', () => {
  assert.throws(() => parseWebullOrders('Activity Date,Instrument,Amount\n01/01/2026,AAPL,100'))
})

console.log('\nWebull option normalization (unverified against real data)')

test('converts OCC-style contract codes', () => {
  assert.equal(normalizeWebullOption('PLTR250117C00155000', ''), 'PLTR 01/17/2025 Call $155.00')
  assert.equal(normalizeWebullOption('AAPL260619P00200000', ''), 'AAPL 06/19/2026 Put $200.00')
})

test('converts human-readable contract descriptions', () => {
  assert.equal(normalizeWebullOption('PLTR 01/17/2025 155 Call', ''), 'PLTR 01/17/2025 Call $155.00')
})

test('leaves plain stock symbols alone', () => {
  assert.equal(normalizeWebullOption('AAPL', 'Apple Inc'), null)
  assert.equal(normalizeWebullOption('TQQQ', 'ProShares UltraPro QQQ'), null)
})

console.log(`\n${passed} passed\n`)
