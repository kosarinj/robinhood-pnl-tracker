/**
 * Same-day fills at the same price must not collapse.
 * Run: node server/optionFillCollapse.test.mjs
 *
 * The realized walk used to read getOptionTradesForYTD, which groups by
 * (date, symbol, code, is_buy, amount) and takes `contracts` from one arbitrary
 * row per group rather than summing. Buy the same contract twice in a day at
 * the same price and the stack gets one lot instead of two; the close for two
 * then cannot be filled, and the `left === 0` guard drops the whole close
 * WITHOUT booking anything.
 *
 * Measured on real data (PLTR): grouped read -4,884.95 with 35 closes dropped
 * and 78 contracts lost, raw read -3,462.15 with none dropped, against
 * -3,434.48 from the independent cash identity. The dropped closes were mostly
 * winning STCs, so the panel came out more negative than the cash allowed.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_collapse_${process.pid}.db`)
process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38517'
process.env.NODE_ENV = 'test'
process.env.POLYGON_API_KEY = ''

const BASE = `http://127.0.0.1:${process.env.PORT}`

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
  await import('./index.js')
  await new Promise(r => setTimeout(r, 1500))

  await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'collapsetest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'collapsetest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('collapsetest').id

  const ins = db.prepare(`
    INSERT INTO trades (upload_date, trans_date, trans_code, symbol, quantity, price, amount,
                        description, is_buy, is_option, contracts, user_id, broker)
    VALUES (@d, @d, @tc, @sym, 1, @amt, @amt, @sym, @isBuy, 1, @n, @uid, 'robinhood')
  `)
  const yr = new Date().getFullYear()
  const add = (d, tc, sym, n, amt, isBuy) =>
    ins.run({ d, tc, sym, n, amt, isBuy: isBuy ? 1 : 0, uid: userId })

  // Two identical same-day fills: 1 contract at 100 each. These are the rows the
  // GROUP BY collapsed into one.
  const SYM = `PLTR 2/20/${yr} Call $200.00`
  add(`${yr}-02-02`, 'BTO', SYM, 1, -100, true)
  add(`${yr}-02-02`, 'BTO', SYM, 1, -100, true)
  // Closed together for 300 — a 100 gain.
  add(`${yr}-02-10`, 'STC', SYM, 2, 300, false)

  test('the raw accessor keeps both fills', () => {
    const raw = databaseService.getRawOptionTrades(userId).filter(t => t.symbol === SYM)
    const bto = raw.filter(t => t.trans_code === 'BTO')
    assert.equal(bto.length, 2, 'both BTO rows should survive')
    assert.equal(bto.reduce((s, t) => s + t.contracts, 0), 2)
  })

  test('the grouped accessor is what loses one — the bug this guards', () => {
    const grp = databaseService.getOptionTradesForYTD(userId).filter(t => t.symbol === SYM)
    const btoContracts = grp.filter(t => t.trans_code === 'BTO')
      .reduce((s, t) => s + (t.contracts || 1), 0)
    assert.equal(btoContracts, 1, 'grouping collapses the two fills to one contract')
  })

  const r = await fetch(`${BASE}/api/options-pnl/ytd`, { headers: { Cookie: cookie } })
  const d = await r.json()
  const row = (d.byUnderlying || []).find(x => x.ticker === 'PLTR')

  test('the close books, rather than being silently dropped', () => {
    assert.ok(row, 'no PLTR row')
    // Paid 200, sold for 300.
    assert.equal(row.totalRealized, 100)
  })

  test('the gain is not lost to an unfillable stack', () => {
    // Under the grouped rows the stack held 1 contract, the 2-contract STC could
    // not be filled, and the whole 100 gain booked as nothing.
    assert.notEqual(row.totalRealized, 0)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('Test harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
