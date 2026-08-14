/**
 * Per-user view preferences.
 * Run: node server/preferences.test.mjs
 *
 * These were localStorage only, so they were per device. Several decide what
 * Cumulative P&L reports — the week window, manual share/price overrides,
 * hidden tickers — which is how one account showed three different totals
 * across a laptop, a phone browser and the iOS app.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_prefs_${process.pid}.db`)
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

  console.log('\nPreferences')

  test('a saved preference reads back with its type intact', () => {
    databaseService.setPreference(1, 'optionsPnl_cumulativeWeeks', 10)
    assert.equal(databaseService.getPreferences(1).optionsPnl_cumulativeWeeks, 10)
  })

  test('objects and arrays survive the round trip', () => {
    // Column order is an array; the overrides are keyed objects. Stringifying
    // these the naive way turned numbers into "[object Object]".
    const order = ['net', 'netPlusOpen', 'returnPct']
    const shares = { RDDT: 108, PLTR: 300 }
    databaseService.setPreference(1, 'ytdPanel_columnOrder_all', order)
    databaseService.setPreference(1, 'shareOverrides', shares)
    const p = databaseService.getPreferences(1)
    assert.deepEqual(p.ytdPanel_columnOrder_all, order)
    assert.deepEqual(p.shareOverrides, shares)
  })

  test('writing again replaces rather than duplicating', () => {
    databaseService.setPreference(1, 'optionsPnl_cumulativeWeeks', 4)
    assert.equal(databaseService.getPreferences(1).optionsPnl_cumulativeWeeks, 4)
  })

  test('one user cannot see or overwrite another\'s', () => {
    databaseService.setPreference(2, 'optionsPnl_cumulativeWeeks', 52)
    assert.equal(databaseService.getPreferences(1).optionsPnl_cumulativeWeeks, 4)
    assert.equal(databaseService.getPreferences(2).optionsPnl_cumulativeWeeks, 52)
    assert.equal(databaseService.getPreferences(2).shareOverrides, undefined)
  })

  test('an empty array is kept, not treated as unset', () => {
    // "No hidden tickers" is a real choice and must beat a device's stale list.
    databaseService.setPreference(1, 'ytdPanel_hiddenTickers_all', [])
    assert.deepEqual(databaseService.getPreferences(1).ytdPanel_hiddenTickers_all, [])
  })

  test('a falsy value is stored as itself', () => {
    // 0 means "All weeks" for the cumulative window — the opposite of unset.
    databaseService.setPreference(1, 'optionsPnl_cumulativeWeeks', 0)
    assert.equal(databaseService.getPreferences(1).optionsPnl_cumulativeWeeks, 0)
  })

  test('deleting removes only that key', () => {
    databaseService.deletePreference(1, 'optionsPnl_cumulativeWeeks')
    const p = databaseService.getPreferences(1)
    assert.equal(p.optionsPnl_cumulativeWeeks, undefined)
    assert.deepEqual(p.shareOverrides, { RDDT: 108, PLTR: 300 })
  })

  test('a corrupt row is skipped instead of blanking every panel', () => {
    getDatabase().prepare(
      `INSERT INTO user_preferences (user_id, pref_key, value) VALUES (1, 'broken', '{not json')`
    ).run()
    const p = databaseService.getPreferences(1)
    assert.equal(p.broken, undefined)
    assert.deepEqual(p.shareOverrides, { RDDT: 108, PLTR: 300 }, 'the good rows must survive')
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
