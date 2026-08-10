/**
 * Stock-only rows in the Positions panel.
 * Run: node server/stockRows.test.mjs
 *
 * The panel used to build rows from option activity alone, so a stock held
 * without options was invisible. These check it now appears, is labelled, and
 * that adding it doesn't drag in every ticker ever traded.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_stockrows_${process.pid}.db`)

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38476'
process.env.NODE_ENV = 'test'
process.env.POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'test-dummy-key'

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
    body: JSON.stringify({ username: 'stocktest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'stocktest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('stocktest').id

  const t = (o) => ({
    quantity: 1, price: 100, amount: -100, isBuy: true, isOption: false, contracts: 1,
    description: '', ...o,
  })

  // RDDT: held, never had options → must appear as a stock-only row.
  // SOLD:  bought and fully sold → must NOT appear (this is the history guard).
  // PLTR:  held AND has an option → normal row, hasOptions true.
  const exp = new Date(Date.now() + 60 * 86400000)
  const mm = String(exp.getMonth() + 1).padStart(2, '0')
  const dd = String(exp.getDate()).padStart(2, '0')
  const optSymbol = `PLTR ${mm}/${dd}/${exp.getFullYear()} Call $500.00`

  databaseService.saveTrades([
    t({ date: '2026-06-01', transDate: '2026-06-01', transCode: 'Buy', symbol: 'RDDT', quantity: 3, price: 180, amount: -540 }),
    t({ date: '2026-06-01', transDate: '2026-06-01', transCode: 'Buy', symbol: 'SOLD', quantity: 5, price: 50, amount: -250 }),
    t({ date: '2026-06-05', transDate: '2026-06-05', transCode: 'Sell', symbol: 'SOLD', quantity: 5, price: 60, amount: 300, isBuy: false }),
    t({ date: '2026-06-01', transDate: '2026-06-01', transCode: 'Buy', symbol: 'PLTR', quantity: 10, price: 130, amount: -1300 }),
    t({ date: '2026-06-03', transDate: '2026-06-03', transCode: 'STO', symbol: optSymbol, price: 300, amount: 300, isBuy: false, isOption: true, description: optSymbol }),
  ], '2026-06-05', [], 0, userId, 'robinhood')

  const res = await (await fetch(`${BASE}/api/options-pnl/ytd?startDate=2026-01-01`, { headers: { cookie } })).json()
  const rows = res.byUnderlying || []
  const row = (tk) => rows.find(r => r.ticker === tk)

  console.log('\nStock-only rows')

  test('a stock held with no options now appears', () => {
    assert.ok(row('RDDT'), `RDDT missing from ${rows.map(r => r.ticker).join(',')}`)
  })

  test('it is flagged as stock-only so the UI can label it', () => {
    assert.equal(row('RDDT').hasOptions, false)
  })

  test('it carries real share data, not zeros', () => {
    assert.equal(row('RDDT').stockPosition, 3, `position ${row('RDDT').stockPosition}`)
    assert.ok(row('RDDT').stockAvgCost > 0, `avgCost ${row('RDDT').stockAvgCost}`)
  })

  test('a fully sold-out ticker does NOT appear', () => {
    // The whole point of "currently held only" — no historical accumulation.
    assert.equal(row('SOLD'), undefined, 'sold-out position leaked into the panel')
  })

  test('a ticker with options is still marked as having them', () => {
    assert.ok(row('PLTR'), 'PLTR missing')
    assert.equal(row('PLTR').hasOptions, true)
  })

  test('option columns on a stock-only row are zero, not absent', () => {
    // The UI reads these directly; undefined would render as NaN.
    const r = row('RDDT')
    assert.equal(r.totalRealized, 0)
    assert.equal(r.openPremium, 0)
    assert.equal(typeof r.openProjected, 'object')
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
