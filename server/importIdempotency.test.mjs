/**
 * Importing the same trades twice must not change anything.
 * Run: node server/importIdempotency.test.mjs
 *
 * Every figure in the app is a function of the trades table, so if a re-import
 * moves the table it moves the numbers -- and then no amount of care in the
 * accounting produces a total you can track over time. "I am running another
 * import which I am hoping balances it out" is the symptom: an import is being
 * treated as a correction rather than a no-op.
 *
 * Three shapes, because they fail differently:
 *   same file twice      -- the plain idempotency case
 *   overlapping exports  -- the REAL case, since each broker export covers a
 *                           window ending later and re-sends everything before it
 *   genuine same-day duplicates -- two identical fills are legitimate and must
 *                           survive, which is why the unique index was dropped
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_import_${process.pid}.db`)
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

  // Parser-shaped rows, which is what saveTrades consumes.
  const leg = (date, transCode, symbol, qty, price, amount, isBuy) => ({
    date, transCode, symbol, description: symbol,
    quantity: qty, price, amount,
    isBuy, isOption: true, contracts: qty,
  })

  const SC = 'PLTR 10/2/2026 Call $195.00'
  const LC = 'PLTR 10/2/2026 Call $192.50'

  // An export covering through 10-02.
  const exportA = [
    leg('2026-09-28', 'STO', SC, 1, 1.20, 120, false),
    leg('2026-09-28', 'BTO', LC, 1, 0.80, 80, true),
    leg('2026-10-02', 'BTC', SC, 1, 0.30, 30, true),
    leg('2026-10-02', 'STC', LC, 1, 0.15, 15, false),
  ]
  // The next export: everything above again, plus two later trades. This is how
  // broker exports actually arrive.
  const exportB = [
    ...exportA,
    leg('2026-10-06', 'STO', SC, 1, 1.50, 150, false),
    leg('2026-10-08', 'BTC', SC, 1, 0.40, 40, true),
  ]

  const countRows = () => db.prepare('SELECT COUNT(*) c FROM trades WHERE user_id = ?').get(userId).c
  const countOf = (symbol, date, code) => db.prepare(`
    SELECT COUNT(*) c FROM trades
    WHERE user_id = ? AND symbol = ? AND trans_date = ? AND COALESCE(trans_code,'') = ?
  `).get(userId, symbol, date, code).c

  console.log('\nImporting the same export twice')

  databaseService.saveTrades(exportA, null, [], 0, userId, 'robinhood')
  const afterFirst = countRows()

  test('the first import lands every row', () => {
    assert.equal(afterFirst, exportA.length, `expected ${exportA.length}, got ${afterFirst}`)
  })

  databaseService.saveTrades(exportA, null, [], 0, userId, 'robinhood')

  test('importing it again changes nothing', () => {
    assert.equal(countRows(), afterFirst,
      `row count moved from ${afterFirst} to ${countRows()} on a repeat import`)
  })

  console.log('\nA later export that re-sends the earlier trades')

  databaseService.saveTrades(exportB, null, [], 0, userId, 'robinhood')

  test('the new trades are added', () => {
    assert.equal(countOf(SC, '2026-10-06', 'STO'), 1, 'the 10-06 open is missing')
    assert.equal(countOf(SC, '2026-10-08', 'BTC'), 1, 'the 10-08 close is missing')
  })

  test('the re-sent trades are not duplicated', () => {
    // The one that matters. Each of these appears in both exports exactly once,
    // so each must exist exactly once -- a second copy corrupts the LIFO stack,
    // because the extra open and close then match against each other.
    assert.equal(countOf(SC, '2026-09-28', 'STO'), 1, 'the 9-28 open was duplicated')
    assert.equal(countOf(LC, '2026-09-28', 'BTO'), 1, 'the 9-28 long open was duplicated')
    assert.equal(countOf(SC, '2026-10-02', 'BTC'), 1, 'the 10-02 close was duplicated')
    assert.equal(countOf(LC, '2026-10-02', 'STC'), 1, 'the 10-02 long close was duplicated')
  })

  test('the table holds exactly the union of the two exports', () => {
    assert.equal(countRows(), exportB.length,
      `expected ${exportB.length} rows, got ${countRows()}`)
  })

  test('importing the later export again still changes nothing', () => {
    const before = countRows()
    databaseService.saveTrades(exportB, null, [], 0, userId, 'robinhood')
    assert.equal(countRows(), before, `row count moved from ${before} to ${countRows()}`)
  })

  console.log('\nTwo identical fills on one day are real and must survive')

  test('a genuine repeated trade is kept, not collapsed', () => {
    // Why the unique index was dropped. Selling the same strike twice in a day
    // at the same price is one position of two contracts, not a double-counted
    // one, and dedup must not eat the second.
    const twice = [
      leg('2026-10-09', 'STO', LC, 1, 0.55, 55, false),
      leg('2026-10-09', 'STO', LC, 1, 0.55, 55, false),
    ]
    databaseService.saveTrades(twice, null, [], 0, userId, 'robinhood')
    assert.equal(countOf(LC, '2026-10-09', 'STO'), 2,
      'both fills should be present')
  })

  test('and re-importing that export does not make it four', () => {
    const twice = [
      leg('2026-10-09', 'STO', LC, 1, 0.55, 55, false),
      leg('2026-10-09', 'STO', LC, 1, 0.55, 55, false),
    ]
    databaseService.saveTrades(twice, null, [], 0, userId, 'robinhood')
    assert.equal(countOf(LC, '2026-10-09', 'STO'), 2,
      'the repeat import duplicated a legitimately-repeated trade')
  })

  console.log(`\n${passed} passed\n`)
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 100)
}
