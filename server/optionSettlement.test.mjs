/**
 * Option settlements close the position they belong to.
 * Run: node server/optionSettlement.test.mjs
 *
 * Robinhood writes an expiry as "Option Expiration for MRVL 8/7/2026 Put $148.00".
 * An option's identity in the trades table IS its description, so that prefix made
 * the settlement a different contract from the trade that opened it: nothing
 * matched, every expired option stayed open for good, and the expiry was never
 * booked — a loss on a bought contract, the whole premium on a sold one.
 *
 * The second half is direction. Settlements used to count as long closes only, so
 * an expired SHORT stayed open. The quantity's "1S" suffix looks like a short
 * marker but sits on 405 of 413 contracts opened with BTO, so it can't be trusted;
 * matching the contract and closing whichever side is open is what holds.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_settle_${process.pid}.db`)
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
    VALUES (@d, @d, @tc, @sym, 1, @amt, @amt, @sym, @isBuy, 1, @n, ${userId}, 'robinhood')
  `)
  const add = (d, tc, sym, n, amt, isBuy) => ins.run({ d, tc, sym, n, amt, isBuy: isBuy ? 1 : 0 })

  const LONG = 'MRVL 8/7/2026 Put $148.00'
  const SHORT = 'PLTR 8/7/2026 Call $200.00'
  const LIVE = 'RDDT 12/19/2026 Call $200.00'

  // A bought put that expired worthless.
  add('2026-08-05', 'BTO', LONG, 1, -200, true)
  add('2026-08-07', 'OEXP', LONG, 1, 0, false)
  // A sold call that expired worthless — premium kept.
  add('2026-08-05', 'STO', SHORT, 2, 400, false)
  add('2026-08-07', 'OEXP', SHORT, 2, 0, false)
  // Still genuinely open.
  add('2026-08-05', 'STO', LIVE, 1, 300, false)

  const bySymbol = () => Object.fromEntries(
    databaseService.getOpenOptionPositions(userId).map(p => [p.symbol, p])
  )

  console.log('\nSettlement closes the right side')

  test('an expired LONG is no longer open', () => {
    assert.equal(bySymbol()[LONG], undefined, 'a bought contract that expired must close')
  })

  test('an expired SHORT is no longer open', () => {
    // This is the half that was broken even once symbols matched: settlements
    // only ever reduced net_long, so an expired short stayed open for good.
    assert.equal(bySymbol()[SHORT], undefined, 'a sold contract that expired must close')
  })

  test('a genuinely open position is untouched', () => {
    const p = bySymbol()[LIVE]
    assert.ok(p, 'the open contract must still be reported')
    assert.equal(p.net_short, 1)
    assert.equal(p.net_long, 0)
  })

  test('a partial expiry leaves the remainder open', () => {
    const PART = 'UBER 8/7/2026 Put $64.00'
    add('2026-08-05', 'BTO', PART, 5, -500, true)
    add('2026-08-07', 'OEXP', PART, 2, 0, false)
    const p = bySymbol()[PART]
    assert.ok(p, 'three contracts should remain')
    assert.equal(p.net_long, 3)
  })

  test('a settlement never drives a position negative', () => {
    // Duplicate settlements shouldn't manufacture a short out of a closed long.
    const DUP = 'HOOD 8/7/2026 Put $88.00'
    add('2026-08-05', 'BTO', DUP, 1, -100, true)
    add('2026-08-07', 'OEXP', DUP, 1, 0, false)
    add('2026-08-07', 'OEXP', DUP, 1, 0, false)
    const p = bySymbol()[DUP]
    assert.equal(p, undefined, 'should be closed, not flipped short')
  })

  console.log('\nStored rows are repaired in place')

  test('the migration strips a prefix already in the database', () => {
    // Reimporting cannot fix these: the dedup key includes the symbol, so the
    // stored rows match the file and are skipped rather than rewritten.
    const PREFIXED = 'Option Expiration for CRWV 8/7/2026 Put $80.00'
    add('2026-08-07', 'OEXP', PREFIXED, 1, 0, false)
    const before = db.prepare('SELECT COUNT(*) n FROM trades WHERE symbol LIKE ?').get('Option Expiration for %').n
    assert.equal(before, 1, 'precondition: a prefixed row exists')

    db.prepare(
      `UPDATE trades SET symbol = TRIM(SUBSTR(symbol, ?)) WHERE COALESCE(is_option,0) = 1 AND symbol LIKE ?`
    ).run('Option Expiration for '.length + 1, 'Option Expiration for %')

    const after = db.prepare('SELECT COUNT(*) n FROM trades WHERE symbol LIKE ?').get('Option Expiration for %').n
    assert.equal(after, 0)
    const fixed = db.prepare('SELECT symbol FROM trades WHERE trans_code = ? AND symbol LIKE ?')
      .get('OEXP', 'CRWV%')
    assert.equal(fixed.symbol, 'CRWV 8/7/2026 Put $80.00')
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
