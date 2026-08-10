/**
 * Ingestion test: real Webull export + Robinhood rows in one database.
 * Run: node server/brokerIngest.test.mjs
 *
 * Uses the actual downloaded Webull file when present so the parser is
 * exercised against real data, not a fixture I wrote to match my own parser.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'
import { calculatePnL } from './services/pnlCalculator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_broker_${process.pid}.db`)
const REAL_WEBULL = 'C:/Users/jeffk/Downloads/Webull_Orders_Records (2).csv'

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
  } catch { /* never opened */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.existsSync(f) && fs.unlinkSync(f) } catch { /* locked */ }
  }
}

try {
  const { databaseService, getDatabase } = await import('./services/database.js')
  const { parseWebullOrders } = await import('./services/webullParser.js')
  const db = getDatabase()

  console.log('\nMulti-broker ingestion')

  // ── Robinhood rows, saved the way the existing upload path saves them ──
  const rhTrades = [
    { date: '2026-06-01', transCode: 'Buy', symbol: 'AAPL', quantity: 10, price: 300, amount: -3000, isBuy: true, isOption: false, contracts: 1, description: 'Apple' },
    { date: '2026-06-02', transCode: 'Sell', symbol: 'AAPL', quantity: 4, price: 320, amount: 1280, isBuy: false, isOption: false, contracts: 1, description: 'Apple' },
  ]
  databaseService.saveTrades(rhTrades, '2026-06-02', [], 0, 1, 'robinhood')

  test('robinhood trades are tagged robinhood', () => {
    const n = db.prepare(`SELECT COUNT(*) c FROM trades WHERE broker='robinhood'`).get().c
    assert.equal(n, 2, `expected 2, got ${n}`)
  })

  // ── The real Webull export ──
  const haveReal = fs.existsSync(REAL_WEBULL)
  const csv = haveReal
    ? fs.readFileSync(REAL_WEBULL, 'utf8')
    : [
        'Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time',
        'Apple Inc,AAPL,Buy,Filled,2,2,@310.05,310.05,DAY,06/01/2026 07:21:12 EDT,06/01/2026 07:21:32 EDT',
        'REDDIT INC,RDDT,Buy,Filled,3,3,@180.58,180.58,DAY,06/01/2026 07:20:03 EDT,06/01/2026 07:20:11 EDT',
      ].join('\n')
  if (!haveReal) console.log('  (real Webull file not found — using a small fixture)')

  const { trades: wbTrades } = parseWebullOrders(csv)
  wbTrades.forEach(t => { t.broker = 'webull' })
  databaseService.saveTrades(wbTrades, '2026-08-07', [], 0, 1, 'webull')

  test('webull trades land tagged webull', () => {
    const n = db.prepare(`SELECT COUNT(*) c FROM trades WHERE broker='webull'`).get().c
    assert.equal(n, wbTrades.length, `expected ${wbTrades.length}, got ${n}`)
  })

  test('robinhood trades survived the webull upload', () => {
    const n = db.prepare(`SELECT COUNT(*) c FROM trades WHERE broker='robinhood'`).get().c
    assert.equal(n, 2, 'webull upload clobbered robinhood rows')
  })

  test('re-uploading webull is idempotent and leaves robinhood alone', () => {
    databaseService.saveTrades(wbTrades, '2026-08-07', [], 0, 1, 'webull')
    const wb = db.prepare(`SELECT COUNT(*) c FROM trades WHERE broker='webull'`).get().c
    const rh = db.prepare(`SELECT COUNT(*) c FROM trades WHERE broker='robinhood'`).get().c
    assert.equal(wb, wbTrades.length, `webull duplicated: ${wb}`)
    assert.equal(rh, 2, `robinhood lost rows: ${rh}`)
  })

  // ── The same ticker at both brokers ──
  test('AAPL is held at both brokers in this dataset', () => {
    const brokers = db.prepare(
      `SELECT DISTINCT broker FROM trades WHERE symbol='AAPL' ORDER BY broker`
    ).all().map(r => r.broker)
    assert.deepEqual(brokers, ['robinhood', 'webull'], `got ${brokers}`)
  })

  test('P&L merges AAPL to one row but matched per broker', () => {
    const rows = db.prepare(`SELECT * FROM trades WHERE user_id=1`).all().map(r => ({
      symbol: r.symbol, quantity: r.quantity, price: r.price, amount: r.amount,
      isBuy: !!r.is_buy, isOption: !!r.is_option, contracts: r.contracts,
      date: r.trans_date, transDate: r.trans_date, transCode: r.trans_code,
      description: r.description, instrument: r.symbol, broker: r.broker,
    }))
    const realLog = console.log
    console.log = () => {}
    let pnl
    try { pnl = calculatePnL(rows, {}) } finally { console.log = realLog }

    const aapl = pnl.filter(r => r.symbol === 'AAPL')
    assert.equal(aapl.length, 1, `AAPL should appear once, got ${aapl.length}`)
    assert.deepEqual([...aapl[0].brokers].sort(), ['robinhood', 'webull'])
    // Robinhood: 10 bought, 4 sold = 6 held. Webull's AAPL nets to 0 in the
    // real export, so the combined position is Robinhood's 6.
    assert.ok(aapl[0].real.position >= 6, `position ${aapl[0].real.position}`)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
