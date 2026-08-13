/**
 * Robinhood trans-code classification.
 * Run: node server/csvParser.test.mjs
 *
 * Short sales are the case that broke. SS opens a short and BC closes it, and
 * only four codes ever move a stock position: Buy, Sell, SS, BC. Get BC wrong
 * and a short that was opened and closed subtracts its size twice — quietly,
 * because nothing about the row looks unusual.
 */
import assert from 'node:assert/strict'
import { parseTrades } from './services/csvParser.js'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

const HEADER = '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"'
const row = (date, sym, code, qty, price, amount) =>
  `"${date}","${date}","${date}","${sym}","${sym}","${code}","${qty}","${price}","${amount}"`
const csv = (...rows) => [HEADER, ...rows].join('\n')

const net = (trades, sym) => trades
  .filter(t => !t.isOption && t.symbol === sym)
  .reduce((n, t) => n + (t.isBuy ? t.quantity : -t.quantity), 0)

console.log('\nTrans code classification')

await test('BC (Buy to Cover) is a buy, not a sale', async () => {
  const { trades } = await parseTrades(csv(
    row('1/26/2026', 'RDDT', 'BC', '74', '$150.00', '($11,100.00)')
  ))
  assert.equal(trades.length, 1)
  assert.equal(trades[0].isBuy, true, 'BC buys shares back')
})

await test('SS (Short Sale) is still a sale', async () => {
  const { trades } = await parseTrades(csv(
    row('1/26/2026', 'RDDT', 'SS', '74', '$155.00', '$11,470.00')
  ))
  assert.equal(trades[0].isBuy, false)
})

await test('a short opened and covered nets to zero', async () => {
  // The RDDT shape: 74 shares shorted in January and bought back the next day.
  const { trades } = await parseTrades(csv(
    row('1/26/2026', 'RDDT', 'SS', '74', '$155.00', '$11,470.00'),
    row('1/27/2026', 'RDDT', 'BC', '74', '$150.00', '($11,100.00)')
  ))
  assert.equal(net(trades, 'RDDT'), 0, 'a round-trip short must not move the position')
})

await test('a held position survives a covered short alongside it', async () => {
  // 108 shares held, plus a 74-share short opened and closed. Before the fix
  // this read -40 and the symbol dropped out of the positions list entirely.
  const { trades } = await parseTrades(csv(
    row('5/14/2026', 'RDDT', 'Buy', '108', '$155.83', '($16,829.64)'),
    row('1/26/2026', 'RDDT', 'SS', '74', '$155.00', '$11,470.00'),
    row('1/27/2026', 'RDDT', 'BC', '74', '$150.00', '($11,100.00)')
  ))
  assert.equal(net(trades, 'RDDT'), 108)
})

await test('the PLTR shape reads 300, not 200', async () => {
  const { trades } = await parseTrades(csv(
    row('5/14/2026', 'PLTR', 'Buy', '300', '$100.00', '($30,000.00)'),
    row('1/26/2026', 'PLTR', 'SS', '50', '$105.00', '$5,250.00'),
    row('1/28/2026', 'PLTR', 'BC', '50', '$102.00', '($5,100.00)')
  ))
  assert.equal(net(trades, 'PLTR'), 300)
})

await test('ordinary buys and sells are unchanged', async () => {
  const { trades } = await parseTrades(csv(
    row('5/14/2026', 'AAPL', 'Buy', '10', '$200.00', '($2,000.00)'),
    row('5/15/2026', 'AAPL', 'Sell', '4', '$210.00', '$840.00')
  ))
  assert.equal(net(trades, 'AAPL'), 6)
})

await test('option codes are untouched by the BC change', async () => {
  // BTC closes a long option and stays a buy; STO stays a sale.
  const opt = (code, amt) =>
    `"5/14/2026","5/14/2026","5/14/2026","RDDT","RDDT 6/20/2026 Call $150.00","${code}","1","$1.00","${amt}"`
  const { trades } = await parseTrades(csv(opt('BTC', '($100.00)'), opt('STO', '$100.00')))
  const btc = trades.find(t => t.transCode === 'BTC')
  const sto = trades.find(t => t.transCode === 'STO')
  assert.equal(btc.isBuy, true)
  assert.equal(sto.isBuy, false)
  assert.ok(btc.isOption && sto.isOption, 'both should parse as options')
})

console.log(`\n${passed} passed\n`)
