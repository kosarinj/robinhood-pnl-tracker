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

console.log('\nOption settlement rows')

const OPENING = 'MRVL 8/7/2026 Put $148.00'
const EXPIRY_DESC = `Option Expiration for ${OPENING}`

await test('an expiry resolves to the same symbol as the trade that opened it', async () => {
  // The bug: an option's identity here IS its description, so the prefix made
  // the settlement a different contract. Nothing matched, so every expired
  // option stayed open for good and the expiry was never booked.
  const { trades } = await parseTrades(csv(
    `"8/5/2026","8/5/2026","8/5/2026","MRVL","${OPENING}","BTO","1","$2.00","($200.00)"`,
    `"8/7/2026","8/7/2026","8/7/2026","MRVL","${EXPIRY_DESC}","OEXP","1S","",""`
  ))
  assert.equal(trades.length, 2, 'the expiry must survive the price filter')
  assert.equal(trades[0].symbol, trades[1].symbol, 'both rows must name one contract')
  assert.equal(trades[1].symbol, OPENING)
})

await test('the expiry is flagged as one, and "1S" reads as one contract', async () => {
  const { trades } = await parseTrades(csv(
    `"8/7/2026","8/7/2026","8/7/2026","MRVL","${EXPIRY_DESC}","OEXP","1S","",""`
  ))
  const t = trades[0]
  assert.equal(t.isExpiry, true)
  assert.equal(t.contracts, 1, 'the S suffix must not break the contract count')
  assert.equal(t.isOption, true)
})

await test('a multi-contract expiry keeps its size', async () => {
  const { trades } = await parseTrades(csv(
    `"8/7/2026","8/7/2026","8/7/2026","PLTR","Option Expiration for PLTR 8/7/2026 Put $108.00","OEXP","3S","",""`
  ))
  assert.equal(trades[0].contracts, 3)
})

await test('the underlying is recoverable, not the literal word "Option"', async () => {
  // Unstripped, symbol.split(' ')[0] gave "OPTION", which passes a ticker
  // sanity check, so 414 expiries were filed under a phantom ticker.
  const { trades } = await parseTrades(csv(
    `"8/7/2026","8/7/2026","8/7/2026","MRVL","${EXPIRY_DESC}","OEXP","1S","",""`
  ))
  assert.notEqual(trades[0].symbol.split(' ')[0].toUpperCase(), 'OPTION')
  assert.equal(trades[0].symbol.split(' ')[0].toUpperCase(), 'MRVL')
})

await test('assignment and exercise prefixes are stripped too', async () => {
  for (const verb of ['Assignment', 'Exercise', 'Exercise/Assignment']) {
    const { trades } = await parseTrades(csv(
      `"8/7/2026","8/7/2026","8/7/2026","MRVL","Option ${verb} for ${OPENING}","OASGN","1","",""`
    ))
    assert.equal(trades[0].symbol, OPENING, `"${verb}" was not stripped`)
  }
})

await test('an ordinary option description is left alone', async () => {
  const { trades } = await parseTrades(csv(
    `"8/5/2026","8/5/2026","8/5/2026","MRVL","${OPENING}","BTO","1","$2.00","($200.00)"`
  ))
  assert.equal(trades[0].symbol, OPENING)
})

console.log(`\n${passed} passed\n`)
