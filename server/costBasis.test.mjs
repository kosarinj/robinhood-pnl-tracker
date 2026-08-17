/**
 * Cost basis of the shares still held.
 * Run: node server/costBasis.test.mjs
 *
 * Averaging every buy ever made is only right for someone who bought and held.
 * Trading in and out wrecks it: NFLX was day-traded around $1,200 before its
 * 10:1, closed out, then rebought at ~$75 — and the lifetime average reported
 * $188.27 against a $76 price, a phantom -$11,460 on a position that was
 * roughly flat. Robinhood sells FIFO, so the shares still held are the most
 * RECENT ones bought.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_cost_${process.pid}.db`)
process.env.DATABASE_PATH = TMP_DB
process.env.NODE_ENV = 'test'

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

  const ins = db.prepare(`
    INSERT INTO trades (upload_date, trans_date, trans_code, symbol, quantity, price, amount,
                        description, is_buy, is_option, contracts, user_id, broker)
    VALUES (@d, @d, @tc, @sym, @q, @px, @amt, @sym, @isBuy, 0, 1, ${userId}, 'robinhood')
  `)
  const buy  = (sym, d, q, px) => ins.run({ sym, d, tc: 'Buy',  q, px, amt: -(q * px), isBuy: 1 })
  const sell = (sym, d, q, px) => ins.run({ sym, d, tc: 'Sell', q, px, amt: q * px, isBuy: 0 })

  // 'fifo' is the corrected basis the Dashboard uses; 'average' is what the
  // Options YTD panel deliberately stays on.
  const pos = (sym) => databaseService.getStockPositionsWithCost(userId, null, null, 'fifo')[sym]
  const posAvg = (sym) => databaseService.getStockPositionsWithCost(userId, null, null, 'average')[sym]

  console.log('\nCost basis of the shares held')

  test('a closed-out round trip does not pollute the current basis', () => {
    // The NFLX shape, minus the split: traded at ~$1,200, closed, rebought at $75.
    buy('AAA', '2025-09-15', 40, 1200)
    sell('AAA', '2025-09-16', 40, 1210)
    buy('AAA', '2026-06-29', 100, 75)
    buy('AAA', '2026-07-21', 2, 67.66)
    const p = pos('AAA')
    assert.equal(p.position, 102)
    // Lifetime average would be about $472. What's held cost ~$74.86.
    assert.ok(Math.abs(p.avgCost - 74.86) < 0.02, `expected ~74.86, got ${p.avgCost}`)
  })

  test('a partly sold position keeps the newest lots', () => {
    // FIFO: the oldest shares go first, so the dearest recent ones remain.
    buy('BBB', '2026-01-05', 100, 10)
    buy('BBB', '2026-02-05', 100, 20)
    sell('BBB', '2026-03-05', 100, 15)
    const p = pos('BBB')
    assert.equal(p.position, 100)
    assert.ok(Math.abs(p.avgCost - 20) < 0.01, `expected 20, got ${p.avgCost}`)
  })

  test('a buy-and-hold position is unchanged by the new method', () => {
    buy('CCC', '2026-01-05', 50, 30)
    buy('CCC', '2026-02-05', 50, 40)
    const p = pos('CCC')
    assert.equal(p.position, 100)
    assert.ok(Math.abs(p.avgCost - 35) < 0.01, `expected 35, got ${p.avgCost}`)
  })

  test('a fully closed position is not reported', () => {
    buy('DDD', '2026-01-05', 10, 10)
    sell('DDD', '2026-02-05', 10, 12)
    assert.equal(pos('DDD'), undefined)
  })

  test('sells exceeding the buys on file do not strand lots', () => {
    // An export starts mid-history, so shares can be sold that were bought
    // before it. A forward lot walk would clamp and leave a phantom position —
    // PLTR read 351 against an actual 300 that way.
    buy('EEE', '2026-01-05', 100, 10)
    sell('EEE', '2026-02-05', 150, 12)
    assert.equal(pos('EEE'), undefined, 'net is negative, so nothing is held')
  })

  test('open shares predating the history still get a basis, not zero', () => {
    buy('FFF', '2026-01-05', 10, 50)
    sell('FFF', '2026-01-06', 4, 55)
    // 6 held, all covered by the one buy on file.
    const p = pos('FFF')
    assert.equal(p.position, 6)
    assert.ok(Math.abs(p.avgCost - 50) < 0.01, `expected 50, got ${p.avgCost}`)
  })

  test('fractional shares survive', () => {
    buy('GGG', '2026-01-05', 1.5, 100)
    buy('GGG', '2026-02-05', 0.5, 200)
    const p = pos('GGG')
    assert.ok(Math.abs(p.position - 2) < 1e-6)
    assert.ok(Math.abs(p.avgCost - 125) < 0.01, `expected 125, got ${p.avgCost}`)
  })

  test('a split still lands the basis in post-split terms', () => {
    // 1 share at $1,200 before a 10:1 is 10 at $120 after. Both the pre-split
    // buy and a later one blend to a real post-split average.
    buy('HHH', '2025-06-02', 1, 1200)
    buy('HHH', '2026-01-05', 1, 120)
    databaseService.saveSplit('HHH', '2025-11-17', 10, 'test')
    const p = pos('HHH')
    assert.equal(p.position, 11)
    assert.ok(Math.abs(p.avgCost - 120) < 0.01, `expected 120, got ${p.avgCost}`)
  })

  console.log('\nThe two bases coexist')

  test('average still reports the old lifetime figure', () => {
    // AAA: 40 @ $1,200 traded and closed, then 100 @ $75 and 2 @ $67.66.
    // Lifetime average = 55,635.33 / 142 shares bought = $391.80. The shares
    // actually held cost $74.86 — a fivefold difference on the same position.
    const avg = posAvg('AAA'), fifo = pos('AAA')
    assert.equal(avg.position, fifo.position, 'share count must agree either way')
    assert.ok(Math.abs(avg.avgCost - 391.80) < 0.02, `expected 391.80, got ${avg.avgCost}`)
    assert.ok(Math.abs(fifo.avgCost - 74.86) < 0.02, `expected 74.86, got ${fifo.avgCost}`)
  })

  test('buy-and-hold reads the same on both bases', () => {
    // Nothing sold, so there is no difference to have — a guard that the split
    // isn't inventing one where none exists.
    assert.ok(Math.abs(posAvg('CCC').avgCost - pos('CCC').avgCost) < 0.01)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
