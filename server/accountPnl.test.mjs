/**
 * Account P&L building blocks.
 * Run: node server/accountPnl.test.mjs
 *
 * Cash flow plus market value. The point of computing it this way is that
 * realized + unrealized = proceeds + market value - total cost whichever way
 * cost basis is figured, so this total cannot be moved by FIFO versus average.
 * It changes only when money moves or a price does.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_acct_${process.pid}.db`)
process.env.DATABASE_PATH = TMP_DB
process.env.NODE_ENV = 'test'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}
const cleanup = async () => {
  try { const { getDatabase } = await import('./services/database.js'); getDatabase()?.close() } catch {}
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.existsSync(f) && fs.unlinkSync(f) } catch {}
  }
}

try {
  const { databaseService, getDatabase } = await import('./services/database.js')
  const db = getDatabase()
  const ins = db.prepare(`
    INSERT INTO trades (upload_date, trans_date, trans_code, symbol, quantity, price, amount,
                        description, is_buy, is_option, contracts, user_id, broker)
    VALUES (@d,@d,@tc,@s,@q,@px,@amt,@s,@b,@o,@n,1,@bk)
  `)
  // Amounts are stored ABSOLUTE, so direction has to come from the trans code.
  const stock = (tc, s, q, px, bk='robinhood') => ins.run({ d:'2026-01-05', tc, s, q, px, amt: q*px, b: tc==='Buy'?1:0, o:0, n:1, bk })
  const opt   = (tc, s, n, amt, bk='robinhood') => ins.run({ d:'2026-01-05', tc, s, q:1, px:amt, amt, b:['BTO','BTC'].includes(tc)?1:0, o:1, n, bk })

  console.log('\nCash flows')

  test('stock buys are money out, sells money in', () => {
    stock('Buy', 'AAA', 100, 10)     // -1000
    stock('Sell', 'AAA', 40, 12)     //  +480
    const f = databaseService.getCashFlows(1)
    assert.equal(Math.round(f.stockCash), -520)
  })

  test('sold premium is money in, bought premium money out', () => {
    opt('STO', 'AAA 1/16/2026 Call $20.00', 1, 300)   // +300
    opt('BTO', 'AAA 1/16/2026 Call $25.00', 1, 120)   // -120
    const f = databaseService.getCashFlows(1)
    assert.equal(Math.round(f.optionCash), 180)
  })

  test('an expiry moves no cash', () => {
    // It carries no Amount at all; what it did to the position shows up in
    // market value, not here. Counting it either way would double-book.
    const before = databaseService.getCashFlows(1).optionCash
    opt('OEXP', 'AAA 1/16/2026 Call $20.00', 1, 0)
    assert.equal(databaseService.getCashFlows(1).optionCash, before)
  })

  test('stock and option cash stay separate', () => {
    const f = databaseService.getCashFlows(1)
    assert.equal(Math.round(f.stockCash), -520)
    assert.equal(Math.round(f.optionCash), 180)
  })

  test('the broker tab scopes it', () => {
    stock('Buy', 'BBB', 10, 50, 'webull')   // -500 at webull only
    assert.equal(Math.round(databaseService.getCashFlows(1, 'robinhood').stockCash), -520)
    assert.equal(Math.round(databaseService.getCashFlows(1, 'webull').stockCash), -500)
    assert.equal(Math.round(databaseService.getCashFlows(1).stockCash), -1020)
  })

  test('cash flow does not depend on cost-basis method', () => {
    // The whole reason for computing the total this way.
    const a = databaseService.getCashFlows(1)
    databaseService.getStockPositionsWithCost(1, null, null, 'fifo')
    databaseService.getStockPositionsWithCost(1, null, null, 'average')
    assert.deepEqual(databaseService.getCashFlows(1), a)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
