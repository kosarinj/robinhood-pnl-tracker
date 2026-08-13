/**
 * Stock split adjustment.
 * Run: node server/splits.test.mjs
 *
 * The NFLX case: a 10:1 on 2025-11-17 means a share bought before it is now ten
 * shares at a tenth of the price. Get this wrong and cost basis is off by an
 * order of magnitude, quietly.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_splits_${process.pid}.db`)
process.env.DATABASE_PATH = TMP_DB
process.env.NODE_ENV = 'test'
// Adjustment ships off; these tests are about what it does when it's on.
process.env.SPLIT_ADJUSTMENT = 'on'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

const cleanup = async () => {
  try {
    const { getDatabase } = await import('./services/database.js')
    getDatabase()?.close()
  } catch {}
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.existsSync(f) && fs.unlinkSync(f) } catch {}
  }
}

try {
  const { databaseService, getDatabase } = await import('./services/database.js')
  const db = getDatabase()
  const userId = 1

  const buy = (symbol, date, qty, price) => databaseService.saveTrades([{
    date, transDate: date, transCode: 'Buy', symbol,
    quantity: qty, price, amount: -(qty * price),
    isBuy: true, isOption: false, contracts: 1, description: symbol,
  }], date, [], 0, userId, 'robinhood')

  // 1 share at $1,200 before the split; 1 share at $120 after.
  buy('NFLX', '2025-06-02', 1, 1200)
  buy('NFLX', '2026-01-05', 1, 120)
  databaseService.saveSplit('NFLX', '2025-11-17', 10, 'test')

  console.log('\nSplit factor')

  test('applies only to trades before the split', () => {
    const s = databaseService.getSplits(['NFLX']).NFLX
    assert.equal(databaseService.splitFactor(s, '2025-06-02'), 10)
    assert.equal(databaseService.splitFactor(s, '2026-01-05'), 1)
    assert.equal(databaseService.splitFactor(s, '2025-11-17'), 1, 'on the day itself, already adjusted')
  })

  test('two splits compound', () => {
    databaseService.saveSplit('TEST', '2024-06-10', 10, 'test')
    databaseService.saveSplit('TEST', '2025-11-17', 2, 'test')
    const s = databaseService.getSplits(['TEST']).TEST
    assert.equal(databaseService.splitFactor(s, '2024-01-01'), 20, 'before both')
    assert.equal(databaseService.splitFactor(s, '2025-01-01'), 2, 'between them')
    assert.equal(databaseService.splitFactor(s, '2026-01-01'), 1, 'after both')
  })

  console.log('\nPositions and cost basis')

  test('share count reflects the split', () => {
    // 1 pre-split share becomes 10, plus 1 bought after = 11.
    const pos = databaseService.getStockPositionsWithCost(userId).NFLX
    assert.equal(pos.position, 11, `got ${pos.position}`)
  })

  test('avg cost is the real blended cost, not 10x too high', () => {
    // $1,200 + $120 = $1,320 paid for 11 shares = $120.00.
    const pos = databaseService.getStockPositionsWithCost(userId).NFLX
    assert.ok(Math.abs(pos.avgCost - 120) < 0.01, `expected ~120, got ${pos.avgCost}`)
  })

  test('the dollar amount paid is never rescaled', () => {
    // A split changes share count and per-share price. It does not change the
    // cash that left the account.
    const total = db.prepare(
      `SELECT SUM(ABS(amount)) t FROM trades WHERE symbol='NFLX' AND user_id=?`
    ).get(userId).t
    assert.ok(Math.abs(total - 1320) < 0.01, `got ${total}`)
  })

  console.log('\nTrades feed')

  test('a pre-split trade reads as adjusted shares at the adjusted price', () => {
    const t = databaseService.getAllTradesForUser(userId).filter(x => x.symbol === 'NFLX')
    const pre = t.find(x => x.date === '2025-06-02')
    assert.equal(pre.quantity, 10, `quantity ${pre.quantity}`)
    assert.ok(Math.abs(pre.price - 120) < 0.01, `price ${pre.price}`)
    assert.ok(Math.abs(Math.abs(pre.amount) - 1200) < 0.01, 'amount must be untouched')
    assert.equal(pre.splitAdjusted, 10)
  })

  test('a post-split trade is left alone', () => {
    const t = databaseService.getAllTradesForUser(userId).filter(x => x.symbol === 'NFLX')
    const post = t.find(x => x.date === '2026-01-05')
    assert.equal(post.quantity, 1)
    assert.ok(Math.abs(post.price - 120) < 0.01)
    assert.equal(post.splitAdjusted, undefined)
  })

  test('options are never split-adjusted', () => {
    // A split rewrites strikes and deliverables; scaling contracts blindly
    // would invent numbers, so option rows are deliberately untouched.
    const exp = '2026-09-18'
    const sym = `NFLX 09/18/2026 Call $1000.00`
    databaseService.saveTrades([{
      date: '2025-06-02', transDate: '2025-06-02', transCode: 'STO', symbol: sym,
      quantity: 1, price: 300, amount: 300, isBuy: false, isOption: true,
      contracts: 1, description: sym,
    }], '2025-06-02', [], 0, userId, 'robinhood')
    const opt = databaseService.getAllTradesForUser(userId).find(x => x.symbol === sym)
    assert.equal(opt.quantity, 1)
    assert.equal(opt.splitAdjusted, undefined)
  })

  console.log('\nStale split removal')

  test('a split Yahoo no longer reports is removed', () => {
    // The RDDT case. A spurious row was written once, and because nothing ever
    // deleted from this table it kept rewriting the share count on every read.
    databaseService.saveSplit('RDDT', '2026-08-12', 0.667, 'yahoo')
    assert.ok(databaseService.getSplits(['RDDT']).RDDT?.length, 'precondition')

    const removed = databaseService.reconcileYahooSplits('RDDT', [])
    assert.equal(removed, 1)
    assert.equal(databaseService.getSplits(['RDDT']).RDDT, undefined)
  })

  test('a still-confirmed split survives reconciliation', () => {
    databaseService.saveSplit('AAPL', '2020-08-31', 4, 'yahoo')
    const removed = databaseService.reconcileYahooSplits('AAPL', ['2020-08-31'])
    assert.equal(removed, 0)
    assert.equal(databaseService.getSplits(['AAPL']).AAPL.length, 1)
  })

  test('reconciliation drops only the rows no longer reported', () => {
    databaseService.saveSplit('MULT', '2021-01-01', 2, 'yahoo')
    databaseService.saveSplit('MULT', '2023-01-01', 3, 'yahoo')
    const removed = databaseService.reconcileYahooSplits('MULT', ['2023-01-01'])
    assert.equal(removed, 1)
    const left = databaseService.getSplits(['MULT']).MULT
    assert.equal(left.length, 1)
    assert.equal(left[0].date, '2023-01-01')
  })

  test('hand-entered splits are not touched by a Yahoo refresh', () => {
    // NFLX's row is source 'test'. Yahoo disagreeing must not erase a ratio
    // someone entered deliberately.
    const before = databaseService.getSplits(['NFLX']).NFLX.length
    const removed = databaseService.reconcileYahooSplits('NFLX', [])
    assert.equal(removed, 0)
    assert.equal(databaseService.getSplits(['NFLX']).NFLX.length, before)
  })

  test('deleting a symbol clears it whatever the source', () => {
    const deleted = databaseService.deleteSplitsForSymbol('NFLX')
    assert.ok(deleted >= 1)
    assert.equal(databaseService.getSplits(['NFLX']).NFLX, undefined)
  })

  test('share count returns to normal once a bad split is gone', () => {
    // The user-visible symptom: 300 shares reading as 200.
    buy('PLTR', '2025-03-03', 300, 20)
    databaseService.saveSplit('PLTR', '2026-08-12', 0.667, 'yahoo')
    const distorted = databaseService.getStockPositionsWithCost(userId).PLTR
    assert.ok(Math.abs(distorted.position - 200.1) < 0.5,
      `expected the bad ratio to shrink the position, got ${distorted.position}`)

    databaseService.reconcileYahooSplits('PLTR', [])
    const fixed = databaseService.getStockPositionsWithCost(userId).PLTR
    assert.equal(fixed.position, 300)
    assert.ok(Math.abs(fixed.avgCost - 20) < 0.01, `avg cost ${fixed.avgCost}`)
  })

  console.log('\nThe switch')

  test('off means no adjustment, and the rows are still there to inspect', () => {
    // The safe default. Share counts must read exactly as they did before the
    // feature existed, while the table stays visible for diagnosis.
    databaseService.saveSplit('SWCH', '2026-01-01', 4, 'yahoo')
    buy('SWCH', '2025-01-01', 25, 400)

    process.env.SPLIT_ADJUSTMENT = 'on'
    assert.equal(databaseService.getStockPositionsWithCost(userId).SWCH.position, 100,
      'on: 25 pre-split shares read as 100')

    process.env.SPLIT_ADJUSTMENT = 'off'
    assert.equal(databaseService.splitAdjustmentEnabled(), false)
    assert.deepEqual(databaseService.getSplits(['SWCH']), {}, 'off: nothing to apply')
    assert.equal(databaseService.getSplitsRaw(['SWCH']).SWCH.length, 1, 'off: row still inspectable')
    assert.equal(databaseService.getStockPositionsWithCost(userId).SWCH.position, 25,
      'off: the unadjusted share count')

    process.env.SPLIT_ADJUSTMENT = 'on'
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
