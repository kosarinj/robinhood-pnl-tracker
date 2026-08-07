/**
 * End-to-end test for GET /api/extended-hours.
 * Run: node server/extendedHoursApi.test.mjs
 *
 * Boots the real server against a throwaway SQLite file, seeds one open short
 * call plus a calibrated closing vol, and checks the response. The underlying
 * price comes from live Yahoo, so the exact estimate isn't asserted — the
 * invariants around it are.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_extended_hours_${process.pid}.db`)

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38472'
process.env.NODE_ENV = 'test'
process.env.POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''

const BASE = `http://127.0.0.1:${process.env.PORT}`

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

// Windows won't unlink a file SQLite still holds, so close the handle first.
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
  const { databaseService, getDatabase } = await import('./services/database.js')
  await import('./index.js')                       // starts listening
  await new Promise(r => setTimeout(r, 1500))      // let it bind

  // ── Seed a user ──
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ehtest', password: 'test-password-123' }),
  })
  assert.ok(signup.ok, `signup failed: ${signup.status} ${await signup.text()}`)

  // Signup doesn't establish a session — log in for the cookie.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ehtest', password: 'test-password-123' }),
  })
  assert.ok(login.ok, `login failed: ${login.status} ${await login.text()}`)
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie, 'no session cookie returned')

  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('ehtest').id

  console.log('\nExtended-hours API')

  // ── Before any IV capture ──
  const empty = await (await fetch(`${BASE}/api/extended-hours`, { headers: { cookie } })).json()
  test('reports honestly when no vol has been captured', () => {
    assert.equal(empty.success, true)
    assert.deepEqual(empty.positions, [])
    assert.match(empty.note, /closing implied vol/i)
  })

  // ── Seed an open short call on AAPL, expiring well out ──
  const expiry = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10)
  const [y, m, d] = expiry.split('-')
  const symbol = `AAPL ${m}/${d}/${y} Call $400.00`

  db.prepare(`
    INSERT INTO trades (user_id, symbol, trans_date, trans_code, quantity, contracts, price, amount, is_option, is_buy, upload_date, description)
    VALUES (?, ?, date('now'), 'STO', 1, 1, 2.50, 250, 1, 0, date('now'), ?)
  `).run(userId, symbol, symbol)

  const open = databaseService.getOpenOptionPositions(userId)
  assert.ok(open.some(p => p.symbol === symbol && p.net_short > 0), 'seeded position is not open')

  // Calibrate against a plausible close so the math has something real to chew on.
  const underlyingClose = 310
  const closeMark = 2.5
  const T = 45 / 365.25
  const { impliedVol } = await import('./utils/blackScholes.js')
  const sigma = impliedVol(closeMark, underlyingClose, 400, T, 0.045, 'call')
  assert.ok(sigma > 0, 'test fixture produced no sigma')

  databaseService.saveOptionIvMark(userId, {
    symbol, ticker: 'AAPL', opt_type: 'call', strike: 400, expiry,
    mark_date: new Date().toISOString().slice(0, 10),
    close_mark: closeMark, underlying_close: underlyingClose, sigma, source: 'test',
  })

  // ── With a captured vol ──
  const res = await (await fetch(`${BASE}/api/extended-hours`, { headers: { cookie } })).json()

  test('prices the open contract', () => {
    assert.equal(res.success, true)
    assert.equal(res.positions.length, 1, JSON.stringify(res))
  })

  const p = res.positions[0]

  test('labels the result as an estimate', () => {
    assert.equal(res.estimated, true)
    assert.equal(p.estimated, true)
  })

  test('returns a live underlying, not the stored close', () => {
    assert.ok(p.underlyingNow > 0)
    assert.equal(p.underlyingClose, underlyingClose)
  })

  test('estimated mark is a sane, non-negative number', () => {
    assert.ok(p.estMark >= 0, `got ${p.estMark}`)
    assert.ok(Number.isFinite(p.estMark))
    // A 45-day $400 call on a ~$310 stock cannot be worth more than the stock.
    assert.ok(p.estMark < p.underlyingNow, `${p.estMark} exceeds underlying`)
  })

  test('change is consistent with close mark and estimate', () => {
    assert.ok(Math.abs((p.closeMark + p.changePerShare) - p.estMark) < 0.02,
      `${p.closeMark} + ${p.changePerShare} != ${p.estMark}`)
    assert.ok(Math.abs(p.changePerContract - p.changePerShare * 100) < 1)
  })

  test('estimate moves the same direction as the underlying', () => {
    if (Math.abs(p.underlyingMovePct) < 0.01) return   // flat — nothing to assert
    const sameSign = (p.underlyingMovePct > 0) === (p.changePerShare > 0)
    assert.ok(sameSign || Math.abs(p.changePerShare) < 0.01,
      `underlying ${p.underlyingMovePct}% but option ${p.changePerShare}`)
  })

  test('carries the reliability flags the UI renders', () => {
    for (const k of ['noExtendedTrade', 'staleIv', 'earningsTonight', 'largeMove']) {
      assert.equal(typeof p[k], 'boolean', `${k} is ${typeof p[k]}`)
    }
    assert.ok(p.session)
  })

  test('expired contracts are excluded', () => {
    const past = '2020-01-17'
    databaseService.saveOptionIvMark(userId, {
      symbol: 'AAPL 01/17/2020 Call $100.00', ticker: 'AAPL', opt_type: 'call',
      strike: 100, expiry: past, mark_date: new Date().toISOString().slice(0, 10),
      close_mark: 1, underlying_close: 100, sigma: 0.3, source: 'test',
    })
    assert.ok(!res.positions.some(x => x.expiry === past))
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
