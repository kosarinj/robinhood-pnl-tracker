/**
 * A bought option that expires out of the money books its premium as a loss —
 * on BOTH bases.
 * Run: node server/expiryRealized.test.mjs
 *
 * The legacy basis used to skip settlements entirely. That faithfully reproduced
 * an older bug (a settlement's symbol carried an "Option Expiration for" prefix
 * and never matched the contract it closed) and was kept so Options YTD read as
 * it always had. It was calibrated on a book whose expiries were mostly SHORT
 * calls expiring worthless, where booking nothing and keeping the premium land
 * in about the same place.
 *
 * It is wrong for bought options. A weekly habit of cheap OTM puts, most of them
 * expiring worthless, put those losses nowhere at all — while the Dashboard, on
 * the corrected basis, booked them correctly the whole time.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_expreal_${process.pid}.db`)
process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38491'
process.env.NODE_ENV = 'test'
process.env.POLYGON_API_KEY = ''      // no network: marks stay null, realized is unaffected

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
  const { getDatabase } = await import('./services/database.js')
  await import('./index.js')
  await new Promise(r => setTimeout(r, 1500))

  await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'exptest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'exptest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('exptest').id

  const ins = db.prepare(`
    INSERT INTO trades (upload_date, trans_date, trans_code, symbol, quantity, price, amount,
                        description, is_buy, is_option, contracts, user_id, broker)
    VALUES (@d, @d, @tc, @sym, 1, @amt, @amt, @sym, @isBuy, 1, @n, @uid, 'robinhood')
  `)
  const yr = new Date().getFullYear()
  const add = (d, tc, sym, n, amt, isBuy) =>
    ins.run({ d, tc, sym, n, amt, isBuy: isBuy ? 1 : 0, uid: userId })

  // A cheap OTM put: paid 300, expired worthless.
  const PUT = `PLTR 2/14/${yr} Put $150.00`
  add(`${yr}-02-10`, 'BTO', PUT, 2, -300, true)
  add(`${yr}-02-14`, 'OEXP', PUT, 2, 0, false)

  // A sold call that expired worthless — premium kept. Unchanged by this fix.
  const CALL = `PLTR 2/14/${yr} Call $400.00`
  add(`${yr}-02-10`, 'STO', CALL, 1, 500, false)
  add(`${yr}-02-14`, 'OEXP', CALL, 1, 0, false)

  const ytd = async (basis) => {
    const url = `${BASE}/api/options-pnl/ytd${basis ? `?basis=${basis}` : ''}`
    const r = await fetch(url, { headers: { Cookie: cookie } })
    const d = await r.json()
    const rows = d.byUnderlying || []
    return rows.find(x => x.ticker === 'PLTR') || null
  }

  const legacy = await ytd(null)
  const corrected = await ytd('corrected')

  test('the ticker appears on both bases', () => {
    assert.ok(legacy, 'no PLTR row on the legacy basis')
    assert.ok(corrected, 'no PLTR row on the corrected basis')
  })

  test('a long put expiring worthless books -300 on the LEGACY basis', () => {
    assert.equal(legacy.realizedLongPuts, -300)
  })

  test('a long put expiring worthless books -300 on the CORRECTED basis', () => {
    assert.equal(corrected.realizedLongPuts, -300)
  })

  test('the two bases now agree on settlement losses', () => {
    assert.equal(legacy.realizedLongPuts, corrected.realizedLongPuts)
  })

  test('a short call expiring worthless still keeps its premium', () => {
    assert.equal(legacy.realizedShortCalls, 500)
    assert.equal(corrected.realizedShortCalls, 500)
  })

  console.log(`\n${passed} passed`)
} catch (e) {
  console.error('Test harness error:', e)
  process.exitCode = 1
} finally {
  // The app keeps a listening server, so the process needs an explicit exit.
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
