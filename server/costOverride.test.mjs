/**
 * Cost overrides are per broker.
 * Run: node server/costOverride.test.mjs
 *
 * The bug: overrides were keyed UNIQUE(user_id, symbol), so setting an avg cost
 * for a ticker at Robinhood also rewrote the Webull row's basis.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_cost_${process.pid}.db`)

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38477'
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
    body: JSON.stringify({ username: 'costtest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'costtest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const db = getDatabase()
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('costtest').id

  // AAPL at both brokers, deliberately different sizes so the weighted blend
  // below can't be confused with a plain average.
  const buy = (broker, qty, price, date) => databaseService.saveTrades([{
    date, transDate: date, transCode: 'Buy', symbol: 'AAPL', quantity: qty, price,
    amount: -(qty * price), isBuy: true, isOption: false, contracts: 1, description: 'Apple',
  }], date, [], 0, userId, broker)

  buy('robinhood', 90, 300, '2026-06-01')   // 90 shares
  buy('webull', 10, 310, '2026-06-02')      // 10 shares

  console.log('\nPer-broker cost overrides')

  databaseService.setCostOverride(userId, 'AAPL', 100, 'robinhood')

  test('an override at one broker does not touch the other', () => {
    assert.equal(databaseService.getCostOverrides(userId, 'robinhood').AAPL, 100)
    assert.equal(databaseService.getCostOverrides(userId, 'webull').AAPL, undefined,
      'webull picked up the robinhood override')
  })

  test('each broker can hold its own override', () => {
    databaseService.setCostOverride(userId, 'AAPL', 250, 'webull')
    assert.equal(databaseService.getCostOverrides(userId, 'robinhood').AAPL, 100)
    assert.equal(databaseService.getCostOverrides(userId, 'webull').AAPL, 250)
  })

  test('merged view weights by shares, not a plain average', () => {
    // 90 @ 100 + 10 @ 250 = 11500 / 100 = 115. A plain average would be 175.
    const merged = databaseService.getCostOverrides(userId).AAPL
    assert.ok(Math.abs(merged - 115) < 0.5, `expected ~115, got ${merged}`)
  })

  test('a broker with no override contributes its real cost, not zero', () => {
    databaseService.deleteCostOverride(userId, 'AAPL', 'webull')
    // 90 @ 100 (override) + 10 @ 310 (actual) = 12100 / 100 = 121
    const merged = databaseService.getCostOverrides(userId).AAPL
    assert.ok(Math.abs(merged - 121) < 0.5, `expected ~121, got ${merged}`)
  })

  test('deleting one broker\'s override leaves the other intact', () => {
    assert.equal(databaseService.getCostOverrides(userId, 'robinhood').AAPL, 100)
    assert.equal(databaseService.getCostOverrides(userId, 'webull').AAPL, undefined)
  })

  console.log('\nAPI guards')

  const put = (body) => fetch(`${BASE}/api/stock-cost-overrides/AAPL`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  })

  const noBroker = await put({ avgCost: 123 })
  const withBroker = await put({ avgCost: 123, broker: 'webull' })

  test('a write without a broker is rejected', () => {
    assert.equal(noBroker.status, 400, `expected 400, got ${noBroker.status}`)
  })

  test('a write with a broker succeeds', async () => {
    assert.equal(withBroker.status, 200, `expected 200, got ${withBroker.status}`)
  })

  test('the write landed on the named broker only', () => {
    assert.equal(databaseService.getCostOverrides(userId, 'webull').AAPL, 123)
    assert.equal(databaseService.getCostOverrides(userId, 'robinhood').AAPL, 100)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
