/**
 * Day P&L measures a leg from what it was actually opened at, not from
 * yesterday's close, when the position was opened today.
 * Run: node server/optionDayBaseline.test.mjs
 *
 * The real case: a PLTR 9/4 $170 put was sold one day and bought back the next
 * morning for pennies. Day P&L differenced the current mark against yesterday's
 * close — 0.12 against 3.15 — and billed 606 dollars of a collapse the position
 * was flat through. The broker showed about 20 dollars.
 *
 * getOptionDayBaseline reports what was held INTO today separately from what was
 * opened today and at what price, so each part can be priced from the right
 * starting point.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_daybase_${process.pid}.db`)
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

  const YEST = '2026-09-02'
  const TODAY = '2026-09-03'

  // The PLTR case: held, sold yesterday, re-bought this morning at 0.22/share.
  const REBOUGHT = 'PLTR 9/4/2026 Put $170.00'
  add('2026-08-28', 'BTO', REBOUGHT, 2, -700, true)
  add(YEST, 'STC', REBOUGHT, 2, 630, false)
  add(TODAY, 'BTO', REBOUGHT, 2, -44, true)     // 44 / (2 * 100) = 0.22

  // Held straight through — no opens today at all.
  const HELD = 'PLTR 9/11/2026 Put $167.50'
  add('2026-08-28', 'BTO', HELD, 2, -900, true)

  // A short opened today.
  const SHORTED = 'HOOD 12/15/2028 Call $195.00'
  add(TODAY, 'STO', SHORTED, 2, 4800, false)    // 4800 / 200 = 24.00

  // Added to an existing position today — part held, part new.
  const ADDED = 'MRVL 10/16/2026 Call $390.00'
  add('2026-08-28', 'BTO', ADDED, 1, -100, true)
  add(TODAY, 'BTO', ADDED, 2, -60, true)        // 60 / 200 = 0.30

  const base = databaseService.getOptionDayBaseline(userId, TODAY)

  test('a re-bought leg counts as held NOTHING into today', () => {
    assert.equal(base[REBOUGHT].priorLong, 0)
    assert.equal(base[REBOUGHT].openedLong, 2)
    assert.equal(base[REBOUGHT].openedLongPrice, 0.22)
  })

  test('the PLTR $170 day move is measured from 0.22, not yesterday 3.15', () => {
    const b = base[REBOUGHT]
    const nowMark = 0.12
    const held = Math.min(b.priorLong, 2)
    const fresh = 2 - held
    const pnl = (3.15 - 3.15) * held * 100 + (nowMark - b.openedLongPrice) * fresh * 100
    assert.equal(held, 0)
    assert.equal(Math.round(pnl), -20)          // the broker's ~$20, not -606
  })

  test('a leg held straight through reports no opens today', () => {
    assert.equal(base[HELD].priorLong, 2)
    assert.equal(base[HELD].openedLong, 0)
  })

  test('a short opened today carries its own entry price', () => {
    assert.equal(base[SHORTED].priorShort, 0)
    assert.equal(base[SHORTED].openedShort, 2)
    assert.equal(base[SHORTED].openedShortPrice, 24)
  })

  test('adding to a position splits held from new', () => {
    const b = base[ADDED]
    assert.equal(b.priorLong, 1)
    assert.equal(b.openedLong, 2)
    assert.equal(b.openedLongPrice, 0.3)
    // 3 open: 1 priced from yesterday's close, 2 from 0.30.
    const held = Math.min(b.priorLong, 3), fresh = 3 - held
    assert.equal(held, 1)
    assert.equal(fresh, 2)
  })

  test('an unknown symbol is absent rather than guessed at', () => {
    assert.equal(base['NOPE 1/1/2027 Call $1.00'], undefined)
  })

  console.log(`\n${passed} passed`)
} finally {
  await cleanup()
}
