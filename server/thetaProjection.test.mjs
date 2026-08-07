/**
 * End-to-end test for the theta-projection column on /api/options-pnl/ytd.
 * Run: node server/thetaProjection.test.mjs
 *
 * Boots the real server against a throwaway SQLite file with one open short
 * call, then checks the projected Open P&L that the YTD panel renders.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_theta_${process.pid}.db`)

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38473'
process.env.NODE_ENV = 'test'
// The option-pricing block is gated on a Polygon key. With a dummy one the
// Polygon calls fail and fall through to exactly the path this test cares
// about: underlying from Yahoo, option mark from the Black-Scholes model.
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
  } catch { /* never opened */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.existsSync(f) && fs.unlinkSync(f) } catch { /* still locked */ }
  }
}

try {
  const { getDatabase } = await import('./services/database.js')
  await import('./index.js')
  await new Promise(r => setTimeout(r, 1500))

  await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'thetatest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'thetatest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie, 'no session cookie')

  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('thetatest').id

  // A short call ~5 months out, struck far above spot so it should decay toward
  // the full premium rather than run into intrinsic.
  const exp = new Date(Date.now() + 150 * 86400000)
  const yyyy = exp.getFullYear()
  const mm = String(exp.getMonth() + 1).padStart(2, '0')
  const dd = String(exp.getDate()).padStart(2, '0')
  const symbol = `AAPL ${mm}/${dd}/${yyyy} Call $500.00`
  const premium = 300      // $3.00/share on 1 contract

  db.prepare(`
    INSERT INTO trades (user_id, symbol, trans_date, trans_code, quantity, contracts, price, amount, is_option, is_buy, upload_date, description)
    VALUES (?, ?, date('now'), 'STO', 1, 1, 3.00, ?, 1, 0, date('now'), ?)
  `).run(userId, symbol, premium, symbol)

  db.prepare(`
    INSERT INTO short_call_entries (user_id, symbol, ticker, strike, expiry, contracts, premium, sale_date, underlying_close)
    VALUES (?, ?, 'AAPL', 500, ?, 1, ?, date('now'), 310)
  `).run(userId, symbol, `${yyyy}-${mm}-${dd}`, premium)

  const res = await (await fetch(`${BASE}/api/options-pnl/ytd`, { headers: { cookie } })).json()
  const row = (res.byUnderlying || []).find(r => r.ticker === 'AAPL')

  console.log('\nTheta projection API')

  test('the AAPL row exists', () => {
    assert.ok(row, `no AAPL row in ${JSON.stringify(Object.keys(res))}`)
  })

  test('carries a projection for 1, 2 and 3 months', () => {
    assert.ok(row.openProjected, 'openProjected missing')
    for (const m of ['1', '2', '3']) {
      assert.ok(row.openProjected[m], `missing horizon ${m}: ${JSON.stringify(row.openProjected)}`)
      assert.equal(typeof row.openProjected[m].pnl, 'number')
    }
  })

  test('projections improve monotonically for a short call', () => {
    const p1 = row.openProjected['1'].pnl
    const p2 = row.openProjected['2'].pnl
    const p3 = row.openProjected['3'].pnl
    assert.ok(p2 >= p1, `2M (${p2}) should be >= 1M (${p1})`)
    assert.ok(p3 >= p2, `3M (${p3}) should be >= 2M (${p2})`)
  })

  test('projection beats today (decay is the whole point)', () => {
    if (row.openUnrealizedPnL == null) return   // no option price available in this env
    assert.ok(row.openProjected['1'].pnl >= row.openUnrealizedPnL,
      `1M (${row.openProjected['1'].pnl}) should beat today (${row.openUnrealizedPnL})`)
  })

  test('never projects more than the premium collected', () => {
    assert.ok(row.openProjected['3'].pnl <= premium + 0.01,
      `${row.openProjected['3'].pnl} exceeds the ${premium} collected`)
  })

  test('reports how many legs expire inside each horizon', () => {
    for (const m of ['1', '2', '3']) {
      const p = row.openProjected[m]
      assert.equal(typeof p.expiredLegs, 'number')
      assert.equal(typeof p.totalLegs, 'number')
      assert.ok(p.expiredLegs <= p.totalLegs)
    }
    // 150 days out — nothing has expired at 3 months.
    assert.equal(row.openProjected['3'].expiredLegs, 0)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
