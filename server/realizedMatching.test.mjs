/**
 * Closes that cannot be fully matched against the opening history.
 * Run: node server/realizedMatching.test.mjs
 *
 * The matcher consumes opening lots as it goes and then decided whether to book
 * anything, which meant a close that ran the stack dry lost BOTH halves: the
 * lots were already popped, and `if (left === 0)` skipped the booking. The
 * contract then reported less realized P&L than it made, silently and
 * permanently.
 *
 * One duplicate close row is enough to cause it, and this database has known
 * duplicates. Which is the point: the matcher has to behave sanely on a trade
 * history that is not perfectly paired, because real ones are not.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_realmatch_${process.pid}.db`)
process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38499'
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
  const { getDatabase } = await import('./services/database.js')
  await import('./index.js')
  await new Promise(r => setTimeout(r, 1500))

  await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'realmatch', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'realmatch', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('realmatch').id

  const ins = (symbol, date, code, n, amount, isBuy) => db.prepare(`
    INSERT INTO trades (user_id, symbol, trans_date, trans_code, quantity, contracts, price, amount,
                        is_option, is_buy, upload_date, description)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)
  `).run(userId, symbol, date, code, n, n, amount, isBuy ? 1 : 0, date, symbol)

  // One underlying per case, so each reads independently.
  const CLEAN = 'ABNB 12/18/2026 Call $200.00'    // 1 open, 1 close
  ins(CLEAN, '2026-09-01', 'STO', 1, 500, false)
  ins(CLEAN, '2026-09-10', 'BTC', 1, 200, true)   // +300

  const OVER = 'ABNB 12/18/2026 Call $220.00'     // 1 open, 2 closed
  ins(OVER, '2026-09-01', 'STO', 1, 400, false)
  ins(OVER, '2026-09-10', 'BTC', 2, 200, true)    // only 1 can match

  const ORPHAN = 'ABNB 12/18/2026 Call $210.00'   // a duplicate close, then a clean pair
  ins(ORPHAN, '2026-09-01', 'STO', 1, 400, false)
  ins(ORPHAN, '2026-09-10', 'BTC', 1, 100, true)  // +300
  ins(ORPHAN, '2026-09-11', 'BTC', 1, 100, true)  // orphan — nothing left
  ins(ORPHAN, '2026-09-20', 'STO', 1, 300, false)
  ins(ORPHAN, '2026-09-25', 'BTC', 1, 100, true)  // +200

  const res = await (await fetch(
    `${BASE}/api/options-pnl/ytd?startDate=2026-01-01&realizedTrades=1`,
    { headers: { cookie } })).json()
  const rows = res.realizedOptionTrades || []
  const at = (strike, date) => rows.find(r => r.strike === strike && r.date === date)
  const abnb = (res.byUnderlying || []).find(r => r.ticker === 'ABNB')

  console.log('\nA clean pair still books exactly what it did before')

  test('1 opened, 1 closed books the full figure', () => {
    const r = at(200, '2026-09-10')
    assert.ok(r, 'the clean close is missing')
    assert.ok(Math.abs(r.realizedPnl - 300) < 0.02, `expected +300, got ${r.realizedPnl}`)
    assert.equal(r.unmatchedContracts, 0, 'a clean pair has no shortfall')
  })

  console.log('\nClosing more than was opened')

  test('the matched part is booked instead of the whole trade being dropped', () => {
    // Was: the lot got consumed, `left` stayed 1, nothing was booked, and the
    // 400 credit vanished from realized P&L for good.
    const r = at(220, '2026-09-10')
    assert.ok(r, 'the over-close booked nothing at all')
    // 1 of 2 contracts matched, so proceeds pro-rate to 100 against the 400
    // credit: +300.
    assert.ok(Math.abs(r.realizedPnl - 300) < 0.02,
      `expected +300 on the matched contract, got ${r.realizedPnl}`)
  })

  test('proceeds are pro-rated, not taken whole', () => {
    // `amount` is the entire closing trade. Charging all 200 against one matched
    // contract would under-report by 100.
    const r = at(220, '2026-09-10')
    assert.ok(Math.abs(r.costBasis - 100) < 0.02,
      `matched proceeds should be 100 of the 200, got ${r.costBasis}`)
  })

  test('the shortfall is reported, not hidden', () => {
    const r = at(220, '2026-09-10')
    assert.equal(r.unmatchedContracts, 1,
      'one contract had nothing to match against and that should be visible')
  })

  test('the ticker carries the shortfall too', () => {
    // So a realized total built over an incomplete history can say so rather
    // than presenting a smaller number as the whole.
    assert.ok(abnb?.unmatchedCloses, 'no unmatchedCloses on the row')
    assert.ok(abnb.unmatchedCloses.contracts >= 2,
      `expected at least 2 unmatched contracts (the over-close and the orphan), got ${abnb.unmatchedCloses.contracts}`)
  })

  console.log('\nAn orphan close must not poison what follows')

  test('the pair before the orphan books normally', () => {
    const r = at(210, '2026-09-10')
    assert.ok(r, 'the first close is missing')
    assert.ok(Math.abs(r.realizedPnl - 300) < 0.02, `expected +300, got ${r.realizedPnl}`)
  })

  test('the orphan books nothing and consumes nothing', () => {
    const r = at(210, '2026-09-11')
    assert.ok(!r, 'an orphan close has no cost basis and must not invent a figure')
  })

  test('the pair AFTER the orphan still books in full', () => {
    // The cascade this guards: if the orphan had eaten the next opening lot, this
    // close would have had nothing to match and the 300 credit would be lost too.
    const r = at(210, '2026-09-25')
    assert.ok(r, 'the close after the orphan booked nothing')
    assert.ok(Math.abs(r.realizedPnl - 200) < 0.02, `expected +200, got ${r.realizedPnl}`)
  })

  console.log('\nThe total still equals its parts')

  test('the rows sum to Options Total', () => {
    const sum = rows.filter(r => r.ticker === 'ABNB').reduce((a, r) => a + r.realizedPnl, 0)
    assert.ok(Math.abs(sum - abnb.totalRealized) < 0.05,
      `rows sum to ${sum.toFixed(2)} but Options Total is ${abnb.totalRealized}`)
  })

  test('and it is the figure the trades imply', () => {
    // 300 (clean) + 300 (over-close, matched part) + 300 + 200 (orphan group).
    assert.ok(Math.abs(abnb.totalRealized - 1100) < 0.05,
      `expected 1100, got ${abnb.totalRealized}`)
  })

  console.log(`\n${passed} passed\n`)
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 100)
}
