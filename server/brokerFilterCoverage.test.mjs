/**
 * Does the broker tab actually filter EVERY column, not just the options?
 * Run: node server/brokerFilterCoverage.test.mjs
 *
 * Seeds stock + short-option positions at two brokers with deliberately
 * different sizes, then checks each broker view reports only its own.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_cover_${process.pid}.db`)

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38475'
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
    body: JSON.stringify({ username: 'covtest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'covtest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('covtest').id

  // Distinct share counts make it obvious which broker a number came from.
  const RH_SHARES = 100
  const WB_SHARES = 7
  const stock = (broker, qty, price) => ({
    date: '2026-06-01', transDate: '2026-06-01', transCode: 'Buy', symbol: 'AAPL',
    quantity: qty, price, amount: -(qty * price), isBuy: true, isOption: false,
    contracts: 1, description: 'Apple',
  })
  databaseService.saveTrades([stock('robinhood', RH_SHARES, 300)], '2026-06-01', [], 0, userId, 'robinhood')
  databaseService.saveTrades([stock('webull', WB_SHARES, 310)], '2026-06-02', [], 0, userId, 'webull')

  // A short call at Robinhood only — Webull must show no open premium.
  const exp = new Date(Date.now() + 60 * 86400000)
  const mm = String(exp.getMonth() + 1).padStart(2, '0')
  const dd = String(exp.getDate()).padStart(2, '0')
  const yyyy = exp.getFullYear()
  const optSymbol = `AAPL ${mm}/${dd}/${yyyy} Call $500.00`
  databaseService.saveTrades([{
    date: '2026-06-03', transDate: '2026-06-03', transCode: 'STO', symbol: optSymbol,
    quantity: 1, price: 300, amount: 300, isBuy: false, isOption: true, contracts: 1,
    description: optSymbol,
  }], '2026-06-03', [], 0, userId, 'robinhood')
  databaseService.upsertShortCallEntry(userId, {
    symbol: optSymbol, ticker: 'AAPL', strike: 500, expiry: `${yyyy}-${mm}-${dd}`,
    contracts: 1, premium: 300, saleDate: '2026-06-03', underlyingClose: 310, broker: 'robinhood',
  })

  console.log('\nDoes the broker filter reach every column?')

  const stockPositions = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/stock-positions-with-prices${q}`, { headers: { cookie } })).json()
  }
  const [allStock, rhStock, wbStock] = await Promise.all([
    stockPositions(), stockPositions('robinhood'), stockPositions('webull'),
  ])
  const sharesOf = (r) => (r.holdings || []).find(h => h.symbol === 'AAPL')?.position ?? 0

  test('stock shares follow the broker filter', () => {
    assert.equal(sharesOf(rhStock), RH_SHARES, `robinhood: ${sharesOf(rhStock)}`)
    assert.equal(sharesOf(wbStock), WB_SHARES, `webull: ${sharesOf(wbStock)}`)
  })

  test('the merged view sums both brokers\' shares', () => {
    assert.equal(sharesOf(allStock), RH_SHARES + WB_SHARES, `all: ${sharesOf(allStock)}`)
  })

  const ytd = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/options-pnl/ytd${q}`, { headers: { cookie } })).json()
  }
  const [allY, rhY, wbY] = await Promise.all([ytd(), ytd('robinhood'), ytd('webull')])
  const rowOf = (r) => (r.byUnderlying || []).find(x => x.ticker === 'AAPL')

  test('open premium is only on the broker that sold the call', () => {
    assert.ok((rowOf(rhY)?.openPremium || 0) > 0, `robinhood open premium: ${rowOf(rhY)?.openPremium}`)
    assert.equal(rowOf(wbY)?.openPremium || 0, 0, `webull should have none: ${rowOf(wbY)?.openPremium}`)
  })

  test('the merged view still shows the open premium', () => {
    assert.ok((rowOf(allY)?.openPremium || 0) > 0, `all: ${rowOf(allY)?.openPremium}`)
  })

  test('theta projection follows the filter too', () => {
    // Webull has no open options, so it must have no projection.
    const wbProj = rowOf(wbY)?.openProjected || {}
    assert.equal(Object.keys(wbProj).length, 0, `webull projected: ${JSON.stringify(wbProj)}`)
  })

  test('short call entries are broker-scoped at the source', () => {
    assert.equal(databaseService.getShortCallEntries(userId, 'robinhood').length, 1)
    assert.equal(databaseService.getShortCallEntries(userId, 'webull').length, 0)
    assert.equal(databaseService.getShortCallEntries(userId).length, 1, 'unfiltered should see all')
  })

  test('open option positions are broker-scoped at the source', () => {
    assert.equal(databaseService.getOpenOptionPositions(userId, 'robinhood').length, 1)
    assert.equal(databaseService.getOpenOptionPositions(userId, 'webull').length, 0)
  })

  console.log('\nShort Call Tracker')

  const shortCalls = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/short-calls${q}`, { headers: { cookie } })).json()
  }
  const [allSC, rhSC, wbSC] = await Promise.all([
    shortCalls(), shortCalls('robinhood'), shortCalls('webull'),
  ])

  test('the tracker follows the broker tab', () => {
    assert.ok((rhSC.entries || []).length > 0,
      `robinhood should list the short call: ${JSON.stringify(rhSC).slice(0, 200)}`)
    assert.equal((wbSC.entries || []).length, 0,
      'webull has no short calls but the tracker listed some')
  })

  test('the merged view still lists it', () => {
    assert.ok((allSC.entries || []).length > 0, 'merged view lost the short call')
  })

  console.log('\nOptions P&L panel')

  const openPositions = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/options-pnl/open-positions${q}`, { headers: { cookie } })).json()
  }
  const [allOP, rhOP, wbOP] = await Promise.all([
    openPositions(), openPositions('robinhood'), openPositions('webull'),
  ])

  test('open positions follow the broker tab', () => {
    assert.ok((rhOP.positions || []).length > 0,
      `robinhood should have the open call: ${JSON.stringify(rhOP).slice(0, 200)}`)
    assert.equal((wbOP.positions || []).length, 0,
      'webull has no open options but the panel listed some')
    assert.ok((allOP.positions || []).length > 0, 'merged view lost the open position')
  })

  const history = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/options-pnl/history${q}`, { headers: { cookie } })).json()
  }
  const [rhH, wbH] = await Promise.all([history('robinhood'), history('webull')])

  test('the stock side of weekly history follows the broker tab too', () => {
    // Robinhood holds 100 AAPL, Webull 7. The stock half of Cumulative P&L was
    // unscoped, so both tabs showed all 107.
    const shares = (h) => Object.values(h.weeklyStockPnL || {}).reduce((s, v) => s + (v?.shares || 0), 0)
    const rhShares = shares(rhH), wbShares = shares(wbH)
    if (rhShares === 0 && wbShares === 0) return   // no weekly stock rows in this fixture
    assert.notEqual(rhShares, wbShares, `both brokers reported ${rhShares} shares — not scoped`)
  })

  test('weekly history follows the broker tab', () => {
    assert.equal(rhH.success, true, `robinhood history failed: ${rhH.error}`)
    assert.equal(wbH.success, true, `webull history failed: ${wbH.error}`)
    // Only Robinhood sold an option, so only it can carry an open option
    // position in the weekly view.
    assert.ok((rhH.openOptionPositions || []).length > 0,
      `robinhood should list the open option: ${JSON.stringify(rhH.openOptionPositions)}`)
    assert.equal((wbH.openOptionPositions || []).length, 0,
      `webull should have none, got ${JSON.stringify(wbH.openOptionPositions)}`)
  })

  test('a broker with no options reports no option underlyings', () => {
    // Webull holds stock only. optionUnderlyingPrices is built from option
    // trades; unscoped, Robinhood's underlyings leaked onto every tab — which
    // is why Schwab showed option values it couldn't have.
    const wbUnderlyings = Object.keys(wbH.optionUnderlyingPrices || {})
    assert.equal(wbUnderlyings.length, 0,
      `webull has no options but reported underlyings: ${wbUnderlyings.join(',')}`)
  })

  test('two brokers do not report identical stock figures', () => {
    // The tell that the filter isn't reaching a calculation at all.
    const total = (h) =>
      Object.values(h.weeklyStockPnL || {}).reduce((s, v) => s + (v?.pnl || 0), 0) + (h.otherStockPnL || 0)
    if (total(rhH) === 0 && total(wbH) === 0) return
    assert.notEqual(total(rhH), total(wbH),
      `both brokers reported ${total(rhH)} — the stock side isn't scoped`)
  })

  console.log('\nExtended hours')

  const extHours = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/extended-hours${q}`, { headers: { cookie } })).json()
  }
  const [rhEH, wbEH] = await Promise.all([extHours('robinhood'), extHours('webull')])

  test('extended hours responds per broker', () => {
    assert.equal(rhEH.success, true, `robinhood: ${rhEH.error}`)
    assert.equal(wbEH.success, true, `webull: ${wbEH.error}`)
    // No closing IV is captured in this fixture, so both are empty — what's
    // being checked is that the broker param is accepted and scoped, not that
    // estimates appear.
    assert.equal((wbEH.positions || []).length, 0)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
