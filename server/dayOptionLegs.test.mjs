/**
 * End-to-end test for the per-leg breakdown behind Day Options on
 * /api/options-pnl/ytd.
 * Run: node server/dayOptionLegs.test.mjs
 *
 * The invariant worth defending is that the parts add to the whole. The column
 * is a sum over three separate leg loops in the handler — short calls with a
 * short_call_entries row, uncovered shorts, and longs — and a breakdown built
 * from only some of them would look authoritative while explaining a different
 * number than the one on screen. That is worse than no breakdown, because it
 * invites you to trust it.
 *
 * Legs that could not be moved are also expected to be PRESENT with a null
 * figure and a reason, rather than absent: they are exactly what makes a day
 * partial, so a popover that dropped them would hide the thing being looked for.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_daylegs_${process.pid}.db`)

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38479'
process.env.NODE_ENV = 'test'
// A dummy key keeps the option-pricing block switched on while every Polygon
// call fails, which is the path that exercises the model/intrinsic fallbacks.
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
    body: JSON.stringify({ username: 'daylegstest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'daylegstest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie, 'no session cookie')

  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('daylegstest').id

  const exp = new Date(Date.now() + 120 * 86400000)
  const yyyy = exp.getFullYear()
  const mm = String(exp.getMonth() + 1).padStart(2, '0')
  const dd = String(exp.getDate()).padStart(2, '0')
  const expiry = `${yyyy}-${mm}-${dd}`
  const sym = (type, strike) => `AAPL ${mm}/${dd}/${yyyy} ${type} $${strike}.00`

  const addTrade = (symbol, code, contracts, amount, isBuy) =>
    db.prepare(`
      INSERT INTO trades (user_id, symbol, trans_date, trans_code, quantity, contracts, price, amount, is_option, is_buy, upload_date, description)
      VALUES (?, ?, date('now','-3 day'), ?, ?, ?, 0, ?, 1, ?, date('now','-3 day'), ?)
    `).run(userId, symbol, code, contracts, contracts, amount, isBuy ? 1 : 0, symbol)

  // One of each kind, so all three of the handler's leg loops contribute:
  //   a short call WITH an entries row  -> the openEntries loop
  //   a short PUT                       -> uncoveredShorts (entries holds only
  //                                        sold calls, so a put can never be there)
  //   a long put                        -> openLongs
  const SHORT_CALL = sym('Call', 500)
  const SHORT_PUT = sym('Put', 150)
  const LONG_PUT = sym('Put', 140)

  addTrade(SHORT_CALL, 'STO', 1, 300, false)
  db.prepare(`
    INSERT INTO short_call_entries (user_id, symbol, ticker, strike, expiry, contracts, premium, sale_date, underlying_close)
    VALUES (?, ?, 'AAPL', 500, ?, 1, 300, date('now','-3 day'), 310)
  `).run(userId, SHORT_CALL, expiry)

  addTrade(SHORT_PUT, 'STO', 2, 400, false)
  addTrade(LONG_PUT, 'BTO', 2, -260, true)

  const res = await (await fetch(`${BASE}/api/options-pnl/ytd`, { headers: { cookie } })).json()
  const row = (res.byUnderlying || []).find(r => r.ticker === 'AAPL')

  console.log('\nDay Options per-leg breakdown')

  test('the AAPL row exists', () => {
    assert.ok(row, `no AAPL row in ${JSON.stringify(Object.keys(res))}`)
  })

  test('a breakdown is present', () => {
    assert.ok(Array.isArray(row.dayOptionLegs), `dayOptionLegs is ${typeof row.dayOptionLegs}`)
    assert.ok(row.dayOptionLegs.length > 0, 'no legs recorded at all')
  })

  test('every open leg is accounted for, moved or not', () => {
    // Three positions were opened, so three legs must appear. A leg that could
    // not be moved still has a row; silence is what this test exists to stop.
    const symbols = new Set(row.dayOptionLegs.map(l => l.symbol))
    for (const s of [SHORT_CALL, SHORT_PUT, LONG_PUT]) {
      assert.ok(symbols.has(s), `${s} missing from the breakdown`)
    }
    assert.equal(row.dayOptionLegs.length, 3,
      `expected 3 legs, got ${row.dayOptionLegs.length}`)
  })

  test('each leg is labelled well enough to identify without re-parsing', () => {
    for (const l of row.dayOptionLegs) {
      assert.ok(l.strike > 0, `no strike: ${JSON.stringify(l)}`)
      assert.ok(l.type === 'call' || l.type === 'put', `bad type ${l.type}`)
      assert.equal(l.expiry, expiry, `bad expiry ${l.expiry}`)
      assert.ok(l.contracts > 0, `bad contracts ${l.contracts}`)
      assert.ok(l.side === 'short' || l.side === 'long', `bad side ${l.side}`)
    }
  })

  test('the sides match how each position was opened', () => {
    const by = Object.fromEntries(row.dayOptionLegs.map(l => [l.symbol, l]))
    assert.equal(by[SHORT_CALL].side, 'short')
    assert.equal(by[SHORT_PUT].side, 'short')
    assert.equal(by[LONG_PUT].side, 'long')
    assert.equal(by[SHORT_PUT].contracts, 2)
    assert.equal(by[LONG_PUT].contracts, 2)
  })

  test('a leg with no figure says why instead of going quiet', () => {
    for (const l of row.dayOptionLegs) {
      if (l.dollars == null) {
        assert.ok(typeof l.reason === 'string' && l.reason.length > 0,
          `leg ${l.symbol} has no figure and no reason`)
      }
    }
  })

  test('the parts add to the column, or the column is blank', () => {
    // The point of the whole feature. A breakdown that explains a different
    // number than the one on screen is worse than none.
    const moved = row.dayOptionLegs.filter(l => l.dollars != null)
    if (row.dayOptionPnl == null) {
      assert.equal(moved.length, 0,
        `column is blank but ${moved.length} legs carry figures`)
      return
    }
    const sum = moved.reduce((s, l) => s + l.dollars, 0)
    assert.ok(Math.abs(sum - row.dayOptionPnl) < 0.02,
      `legs sum to ${sum.toFixed(2)} but the column says ${row.dayOptionPnl}`)
  })

  test('a moved leg carries both marks, not just the move', () => {
    // The move is the part that can be wrong in an interesting way, and the only
    // way to see a prior mark from the wrong session is to show the pair.
    for (const l of row.dayOptionLegs.filter(x => x.dollars != null)) {
      assert.ok(Number.isFinite(l.nowMark), `no current mark on ${l.symbol}`)
      assert.ok(Number.isFinite(l.perShare), `no per-share move on ${l.symbol}`)
      assert.ok(l.basis === 'market' || l.basis === 'model',
        `leg ${l.symbol} has basis ${l.basis}`)
    }
  })

  test('a leg basis never contradicts the ticker-level basis', () => {
    const bases = new Set(row.dayOptionLegs.filter(l => l.dollars != null).map(l => l.basis))
    if (!bases.size || row.dayOptionBasis == null) return
    if (row.dayOptionBasis === 'market') assert.ok(!bases.has('model'), 'ticker says market, a leg says model')
    if (row.dayOptionBasis === 'model') assert.ok(!bases.has('market'), 'ticker says model, a leg says market')
  })

  console.log(`\n${passed} passed\n`)
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 100)
}
