/**
 * Schwab transactions parser.
 * Run: node server/services/schwabParser.test.mjs
 *
 * Uses the real downloaded export when present, so the parser is checked
 * against actual Schwab output rather than fixtures written to match it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseSchwabTransactions, parseSchwabDate, normalizeSchwabOption } from './schwabParser.js'

const REAL = 'C:/Users/jeffk/Downloads/Custodial_Brokerage_XXX562_Transactions_20260811-072856.csv'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

const HEADER = '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"'
const csv = (...rows) => [HEADER, ...rows].join('\n')

console.log('\nDates')

test('plain date', () => {
  assert.equal(parseSchwabDate('07/31/2026'), '2026-07-31')
})

test('"as of" wins over the posting date', () => {
  // Posting date can fall in the next tax year; the "as of" date is when the
  // transaction actually applied.
  assert.equal(parseSchwabDate('12/16/2025 as of 12/15/2025'), '2025-12-15')
  assert.equal(parseSchwabDate('01/02/2027 as of 12/31/2026'), '2026-12-31')
})

console.log('\nAmounts and signs')

test('a buy costs money and a sell brings it in', () => {
  const { trades } = parseSchwabTransactions(csv(
    '"07/31/2026","Buy","AAPL","APPLE INC","1","$301.55","","-$301.55"',
    '"07/31/2026","Sell","DIS","DISNEY WALT CO","2","$96.20","","$192.40"',
  ))
  assert.equal(trades.length, 2)
  assert.equal(trades[0].amount, -301.55)
  assert.equal(trades[0].isBuy, true)
  assert.equal(trades[1].amount, 192.40)
  assert.equal(trades[1].isBuy, false)
  assert.equal(trades[1].quantity, 2)
})

test('Amount is used rather than qty x price, so fees are respected', () => {
  // 1 x $100 with $4.95 commission nets -$104.95. Deriving from qty x price
  // would silently drop the fee.
  const { trades } = parseSchwabTransactions(csv(
    '"07/31/2026","Buy","AAPL","APPLE INC","1","$100.00","$4.95","-$104.95"',
  ))
  assert.equal(trades[0].amount, -104.95)
})

test('everything is tagged schwab', () => {
  const { trades } = parseSchwabTransactions(csv(
    '"07/31/2026","Buy","AAPL","APPLE INC","1","$301.55","","-$301.55"',
  ))
  assert.equal(trades[0].broker, 'schwab')
})

console.log('\nNon-trade rows')

test('dividends and interest are split out, not treated as trades', () => {
  const r = parseSchwabTransactions(csv(
    '"07/22/2026","Qualified Dividend","DIS","DISNEY WALT CO","","","","$1.50"',
    '"12/16/2025 as of 12/15/2025","Bank Interest","","BANK INT ...525 SCHWAB BANK","","","","$0.01"',
  ))
  assert.equal(r.trades.length, 0, 'income leaked into trades')
  assert.equal(r.dividendsAndInterest.length, 2)
  assert.equal(r.dividendsAndInterest[0].isDividend, true)
  assert.equal(r.dividendsAndInterest[1].isInterest, true)
})

test('a cash transfer in becomes a deposit', () => {
  const r = parseSchwabTransactions(csv(
    '"08/11/2025 as of 08/08/2025","MoneyLink Transfer","","FUNDS RECEIVED","","","","$1000.00"',
  ))
  assert.equal(r.deposits.length, 1)
  assert.equal(r.deposits[0].amount, 1000)
  assert.equal(r.totalPrincipal, 1000)
  assert.equal(r.trades.length, 0)
})

test('a withdrawal is not counted as principal', () => {
  // Money out would otherwise inflate the deposit total.
  const r = parseSchwabTransactions(csv(
    '"08/11/2025","MoneyLink Transfer","","FUNDS SENT","","","","-$500.00"',
  ))
  assert.equal(r.deposits.length, 0)
  assert.equal(r.totalPrincipal, 0)
})

test('a share journal is separated from cash, not swallowed', () => {
  // "Journaled Shares" matches the same words as a cash transfer but moves
  // STOCK. Treating it as cash would drop it silently and leave the position
  // wrong — the exact failure mode that hides a broker-to-broker move.
  const r = parseSchwabTransactions(csv(
    '"08/01/2026","Journaled Shares","AAPL","JOURNALED SHARES OUT","1","","",""',
  ))
  assert.equal(r.deposits.length, 0, 'a share move was counted as cash')
  assert.equal(r.trades.length, 0, 'a share move was counted as a trade with no basis')
  assert.equal(r.transfers.length, 1)
  assert.equal(r.transfers[0].symbol, 'AAPL')
  assert.equal(r.transfers[0].quantity, 1)
  assert.equal(r.transfers[0].direction, 'out')
  assert.match(r.warnings.join(' '), /cost basis/i)
})

test('a cash transfer with no symbol is still a deposit', () => {
  const r = parseSchwabTransactions(csv(
    '"08/11/2025","MoneyLink Transfer","","FUNDS RECEIVED","","","","$1000.00"',
  ))
  assert.equal(r.transfers.length, 0, 'cash was misread as a share move')
  assert.equal(r.deposits.length, 1)
})

test('rejects a file that is not a Schwab export', () => {
  assert.throws(() => parseSchwabTransactions('Name,Symbol,Side,Status\nApple,AAPL,Buy,Filled'))
})

console.log('\nOption normalization (unverified against real data)')

test('converts Schwab option descriptions', () => {
  assert.equal(normalizeSchwabOption('AAPL 01/17/2026 200.00 C', ''), 'AAPL 01/17/2026 Call $200.00')
  assert.equal(normalizeSchwabOption('CALL AAPL 01/17/2026 200', ''), 'AAPL 01/17/2026 Call $200.00')
  assert.equal(normalizeSchwabOption('PUT PLTR 06/19/2026 155', ''), 'PLTR 06/19/2026 Put $155.00')
})

test('leaves plain stock symbols alone', () => {
  assert.equal(normalizeSchwabOption('AAPL', 'APPLE INC'), null)
  assert.equal(normalizeSchwabOption('DIS', 'DISNEY WALT CO'), null)
})

test('option Action verbs map to the right trans codes', () => {
  const { trades } = parseSchwabTransactions(csv(
    '"07/31/2026","Sell to Open","AAPL 01/17/2026 200.00 C","CALL AAPL","1","$3.00","","$300.00"',
    '"08/31/2026","Buy to Close","AAPL 01/17/2026 200.00 C","CALL AAPL","1","$1.00","","-$100.00"',
  ))
  assert.equal(trades.length, 2)
  assert.equal(trades[0].transCode, 'STO')
  assert.equal(trades[0].isOption, true)
  assert.equal(trades[0].contracts, 1)
  assert.equal(trades[1].transCode, 'BTC')
  assert.equal(trades[1].isBuy, true)
})

if (fs.existsSync(REAL)) {
  console.log('\nAgainst the real export')
  const r = parseSchwabTransactions(fs.readFileSync(REAL, 'utf8'))

  test('every row is accounted for, none silently skipped', () => {
    assert.equal(r.skipped, 0, `${r.skipped} rows were skipped`)
    assert.equal(r.trades.length, 15)
    assert.equal(r.dividendsAndInterest.length, 12)
    assert.equal(r.deposits.length, 1)
  })

  test('positions match a hand count of the file', () => {
    const net = {}
    r.trades.forEach(t => { net[t.symbol] = (net[t.symbol] || 0) + (t.isBuy ? t.quantity : -t.quantity) })
    assert.deepEqual(net, { AAPL: 2, DIS: 0, AMZN: 1, SBUX: 1, VLO: 0 })
  })

  test('no position goes negative (which would mean missing history)', () => {
    const net = {}
    r.trades.forEach(t => { net[t.symbol] = (net[t.symbol] || 0) + (t.isBuy ? t.quantity : -t.quantity) })
    Object.entries(net).forEach(([s, n]) => assert.ok(n >= 0, `${s} is ${n}`))
  })
} else {
  console.log('\n  (real Schwab export not found — skipped those checks)')
}

console.log(`\n${passed} passed\n`)
