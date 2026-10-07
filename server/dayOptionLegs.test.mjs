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
  // Strikes chosen so every leg gets a mark in this environment. Polygon is
  // given a dummy key so every quote fails; a short CALL still gets a
  // Black-Scholes mark from its short_call_entries row, but a short put and a
  // bought leg have no model fallback, so they are only marked if exercise value
  // is positive. Struck deep in the money, they are -- which is what puts all
  // three of the handler's leg loops on the board, the whole point of the
  // coverage assertions below.
  const SHORT_CALL = sym('Call', 500)
  const SHORT_PUT = sym('Put', 900)
  const LONG_PUT = sym('Put', 800)

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

  console.log('\nTheta and the what-if cover the same legs as Open P&L')

  test('every priced leg is in the theta projection', () => {
    // The bug this pins: the projection was written out in two of the three leg
    // loops and omitted from the third, and the long-leg copy was additionally
    // gated behind basis=corrected -- which the YTD panel does not send. So the
    // panel differenced a complete Open P&L against a projection holding only
    // the short calls that had a short_call_entries row, and rendered the
    // difference as decay. A short put or a bought leg showed its whole P&L as
    // though theta had produced it.
    assert.ok(row.openProjected, 'no projection at all')
    for (const h of ['1W', '2W', '1M', '2M', '3M', '6M']) {
      assert.ok(row.openProjected[h], `missing horizon ${h}`)
      assert.equal(row.openProjected[h].totalLegs, row.openLegsPriced,
        `${h} projects ${row.openProjected[h].totalLegs} legs but Open P&L prices ${row.openLegsPriced}`)
    }
  })

  test('all three leg loops reach the projection, not just the first', () => {
    // A short put can never be in short_call_entries, so it reaches the
    // projection only through the uncovered-shorts loop that had no projection
    // code; a bought leg reaches it only through the longs loop, whose copy was
    // gated behind a basis the panel never sends. Three positions, three loops,
    // so anything under 3 means a loop is still missing.
    assert.equal(row.openLegsPriced, 3,
      `fixture should price all 3 legs, priced ${row.openLegsPriced} / unpriced ${row.openLegsUnpriced}`)
    assert.equal(row.openProjected['1W'].totalLegs, 3,
      `only ${row.openProjected['1W'].totalLegs} leg(s) projected -- a whole loop is still missing`)
  })

  test('the what-if covers those legs too', () => {
    // Same omission, same consequence: the grid substitutes the what-if for Open
    // P&L inside Net + Open, so a partial scenario silently drops the rest.
    assert.ok(row.openScenario && Object.keys(row.openScenario).length > 0, 'no what-if at all')
    for (const m of ['-10', '10']) {
      assert.equal(typeof row.openScenario[m], 'number', `missing move ${m}`)
    }
  })

  test('a 0% move is not published, so nothing competes with Open P&L', () => {
    // At 0% the figure IS Open P&L; publishing it twice invites the two to
    // disagree by rounding and makes the column look wrong at rest.
    assert.equal(row.openScenario['0'], undefined)
  })

  console.log('\nClose Now, off the live IBKR book')

  // Polygon answers /v3/quotes with 403 Not Entitled on this plan, so the only
  // source of a real bid/ask is the order-flow recorder's book. Push one for
  // every leg and the column must come alive; every caller used to narrow
  // optionMark() to its mid on the way in, which is why it never could.
  const pushBook = async (strike, right, bid, ask) => {
    const r = await fetch(`${BASE}/api/orderflow/option-marks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ marks: [{ ticker: 'AAPL', expiry, strike, right, bid, ask }] }),
    })
    assert.ok(r.ok, `option-marks push failed: ${r.status}`)
  }
  // Wide markets on purpose: the spread IS the figure this column exists to show.
  await pushBook(500, 'C', 1.00, 1.40)
  await pushBook(900, 'P', 700.00, 702.00)
  await pushBook(800, 'P', 600.00, 602.00)

  const res2 = await (await fetch(`${BASE}/api/options-pnl/ytd`, { headers: { cookie } })).json()
  const row2 = (res2.byUnderlying || []).find(r => r.ticker === 'AAPL')

  test('Close Now is no longer blank once a two-sided book exists', () => {
    assert.ok(row2, 'no AAPL row on the second pass')
    assert.ok(Number.isFinite(row2.openExitPnL),
      `openExitPnL is ${row2.openExitPnL} -- the IBKR book is still being discarded`)
  })

  test('it is worse than Open P&L, because crossing the spread costs money', () => {
    // Shorts are bought back at the ask and longs sold at the bid, so this can
    // never flatter the mid-based figure. If it ever does, a mid has leaked in.
    assert.ok(Number.isFinite(row2.openUnrealizedPnL), 'no Open P&L to compare against')
    assert.ok(row2.openExitPnL <= row2.openUnrealizedPnL + 0.01,
      `Close Now (${row2.openExitPnL}) must not beat Open P&L (${row2.openUnrealizedPnL})`)
  })

  test('the spread toll is reported and positive', () => {
    // This is the number that actually decides whether a roll is worth it.
    assert.ok(Number.isFinite(row2.exitSpreadCost), 'no exitSpreadCost')
    assert.ok(row2.exitSpreadCost > 0, `expected a real toll, got ${row2.exitSpreadCost}`)
  })

  test('all three leg loops contribute to it, short puts included', () => {
    // The uncovered-shorts loop never touched this column, and a short put can
    // only ever reach it from there. A partial exit figure sitting beside a
    // complete valuation is the same trap as the theta gap.
    //
    // Checked by arithmetic rather than a leg count, since the column carries no
    // leg list: the three books above imply a specific total.
    //   short 500C : premium 3.00/sh - ask 1.40 = +1.60 x 100
    //   short 900P : premium 2.00/sh - ask 702.00 = -700.00 x 200
    //   long  800P : bid 600.00 - cost 1.30/sh = +598.70 x 200
    const want = (3.00 - 1.40) * 100 + (2.00 - 702.00) * 200 + (600.00 - 1.30) * 200
    assert.ok(Math.abs(row2.openExitPnL - want) < 1,
      `expected about ${want.toFixed(2)}, got ${row2.openExitPnL} -- a loop is still missing`)
  })

  console.log('')
  console.log('Theta broken down by leg')

  test('a per-leg projection is carried for every horizon', () => {
    assert.ok(Array.isArray(row.projectionLegs), `projectionLegs is ${typeof row.projectionLegs}`)
    assert.equal(row.projectionLegs.length, row.openProjected['1W'].totalLegs,
      'the leg list and the leg count must describe the same set')
    for (const l of row.projectionLegs) {
      for (const h of ['1W', '2W', '1M', '2M', '3M', '6M']) {
        assert.ok(l.byHorizon?.[h], `leg $${l.strike} missing horizon ${h}`)
        assert.equal(typeof l.byHorizon[h].pnl, 'number')
      }
    }
  })

  test('the legs add to the column at every horizon', () => {
    // The whole point. A breakdown that explains a different number than the one
    // on screen is worse than none, because it invites you to trust it -- the
    // same standard the Day Options split is held to.
    for (const h of ['1W', '2W', '1M', '2M', '3M', '6M']) {
      const sum = row.projectionLegs.reduce((a, l) => a + l.byHorizon[h].pnl, 0)
      assert.ok(Math.abs(sum - row.openProjected[h].pnl) < 0.05,
        `${h}: legs sum to ${sum.toFixed(2)} but the column says ${row.openProjected[h].pnl}`)
    }
  })

  test("each leg's today figure adds to Open P&L", () => {
    // Makes the per-leg GAIN column trustworthy: it is projPnl - nowPnl, so the
    // baseline has to be the same set of legs the projection covers.
    const sum = row.projectionLegs.reduce((a, l) => a + l.nowPnl, 0)
    assert.ok(Math.abs(sum - row.openUnrealizedPnL) < 0.05,
      `legs' today P&L sums to ${sum.toFixed(2)} but Open P&L is ${row.openUnrealizedPnL}`)
  })

  test('settled and decaying legs are distinguishable', () => {
    // The distinction the popover is built around, and the one the leg COUNT
    // alone could not express: a settled leg ends at today's price, a decaying
    // one pays for waiting.
    for (const h of ['1W', '6M']) {
      const flagged = row.projectionLegs.filter(l => l.byHorizon[h].expired).length
      assert.equal(flagged, row.openProjected[h].expiredLegs,
        `${h}: ${flagged} legs flagged expired but the count says ${row.openProjected[h].expiredLegs}`)
    }
  })

  test('each leg says which side it is, so a sign can be read', () => {
    for (const l of row.projectionLegs) {
      assert.ok(l.side === 'short' || l.side === 'long', `bad side ${l.side}`)
      assert.ok(l.contracts > 0, `bad contracts ${l.contracts}`)
      assert.ok(l.strike > 0 && l.expiry, 'leg is not identifiable')
    }
  })

  console.log('')
  console.log("Today's closing IBKR book outranks the model")

  // The outage case. A live mark expires ten minutes after the last recorder
  // push, so once IB Gateway stops -- or the session simply ends -- every leg
  // used to fall past Polygon (which serves no option quotes on this plan) to a
  // model whose vol is backed out of the ORIGINAL sale, months and many dollars
  // ago. Every push also persists the two-sided mids it saw, so a real market in
  // the contract from today is already on disk; these prove it is now used.
  //
  // A FOURTH leg, deliberately given no live push, because the three above have
  // fresh marks and a fresh mark rightly outranks a close. Added after the
  // assertions above have run against their own fetches, so it cannot disturb
  // them.
  const LATE_CALL = sym('Call', 600)
  const CLOSE_BID = 4.20, CLOSE_ASK = 4.60, CLOSE_MID = (CLOSE_BID + CLOSE_ASK) / 2
  const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const lateKey = `AAPL|${expiry.replace(/-/g, '')}|600|C`

  addTrade(LATE_CALL, 'STO', 1, 250, false)
  db.prepare(`
    INSERT INTO short_call_entries (user_id, symbol, ticker, strike, expiry, contracts, premium, sale_date, underlying_close)
    VALUES (?, ?, 'AAPL', 600, ?, 1, 250, date('now','-3 day'), 310)
  `).run(userId, LATE_CALL, expiry)

  const { databaseService: dbs } = await import('./services/database.js')
  dbs.saveIbkrOptionCloses(userId, etToday,
    [{ key: lateKey, mid: CLOSE_MID, bid: CLOSE_BID, ask: CLOSE_ASK }])

  const res3 = await (await fetch(`${BASE}/api/options-pnl/ytd`, { headers: { cookie } })).json()
  const row3 = (res3.byUnderlying || []).find(r => r.ticker === 'AAPL')

  test('a stored close is readable for TODAY, not only for prior days', () => {
    // getPriorIbkrOptionCloses reads mark_date < today by design, because its job
    // is the Day P&L baseline. Marking after the close needs the SAME day, which
    // is why a second reader exists rather than loosening that one.
    const back = dbs.getIbkrOptionClosesOn(userId, etToday)
    assert.ok(back[lateKey], `nothing stored under ${lateKey}: ${JSON.stringify(Object.keys(back))}`)
    assert.ok(Math.abs(back[lateKey].mid - CLOSE_MID) < 1e-9, `mid ${back[lateKey].mid}`)
    // The sides matter as much as the mid: exiting pays the ask on a short and
    // takes the bid on a long, so Close Now cannot work from a mid alone.
    assert.ok(Math.abs(back[lateKey].bid - CLOSE_BID) < 1e-9, `bid ${back[lateKey].bid}`)
    assert.ok(Math.abs(back[lateKey].ask - CLOSE_ASK) < 1e-9, `ask ${back[lateKey].ask}`)
  })

  test('the leg with no live mark is priced from that close, not modelled', () => {
    assert.ok(row3, 'no AAPL row after storing a close')
    const src = row3.openMarkSources || {}
    const fromClose = (src.ibkrClose || 0) + (src.agedIbkrClose || 0)
    assert.ok(fromClose > 0,
      `no leg marked from the stored close; sources were ${JSON.stringify(src)}`)
  })

  test('a fresh mark still beats a stored close', () => {
    // Order matters both ways. The close is a fallback for when the book is
    // gone, not a replacement for a live one -- three legs here do have live
    // books and must still be using them.
    const src = row3.openMarkSources || {}
    assert.ok((src.ibkr || 0) >= 3,
      `expected the 3 pushed legs to stay on the live book, sources ${JSON.stringify(src)}`)
  })

  test('Close Now covers the leg whose only book is the stored close', () => {
    // The practical payoff: the column needs a bid/ask, and once the session
    // ends the stored close is the only one left.
    assert.ok(Number.isFinite(row3.openExitPnL),
      'Close Now went blank even though a two-sided close is on disk')
    // premium 2.50/sh - ask 4.60 = -2.10 x 100 on the new leg, on top of the
    // three already checked. Only the direction is asserted, because the other
    // legs' contribution is verified by its own test above.
    assert.ok(row3.openExitPnL < row3.openUnrealizedPnL + 0.01,
      'exiting must still cost more than the mid-based valuation')
  })

console.log(`\n${passed} passed\n`)
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 100)
}
