/**
 * End-to-end test for the broker upload + tab flow.
 * Run: node server/brokerTabs.test.mjs
 *
 * Drives the real socket upload path with the real Webull file, then checks
 * /api/brokers and the broker filter on the YTD endpoint.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'
import { io as ioClient } from 'socket.io-client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_tabs_${process.pid}.db`)
const REAL_WEBULL = 'C:/Users/jeffk/Downloads/Webull_Orders_Records (2).csv'
const REAL_SCHWAB = 'C:/Users/jeffk/Downloads/Custodial_Brokerage_XXX562_Transactions_20260811-072856.csv'

process.env.DATABASE_PATH = TMP_DB
process.env.PORT = '38474'
process.env.NODE_ENV = 'test'
process.env.POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'test-dummy-key'

const BASE = `http://127.0.0.1:${process.env.PORT}`

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

let socket = null
const cleanup = async () => {
  try { socket?.close() } catch {}
  try {
    const { getDatabase } = await import('./services/database.js')
    getDatabase()?.close()
  } catch {}
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.existsSync(f) && fs.unlinkSync(f) } catch {}
  }
}

const uploadCsv = (csvContent, broker) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`upload timed out (${broker})`)), 45000)
  socket.emit('upload-csv', { csvContent, broker })
  socket.once('csv-processed', (r) => { clearTimeout(timer); resolve(r) })
})

try {
  await import('./index.js')
  await new Promise(r => setTimeout(r, 1500))

  await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tabtest', password: 'test-password-123' }),
  })
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tabtest', password: 'test-password-123' }),
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie, 'no session cookie')

  socket = ioClient(BASE, { extraHeaders: { cookie }, transports: ['websocket'] })
  await new Promise((res, rej) => {
    socket.on('connect', res)
    socket.on('connect_error', e => rej(new Error(`socket connect failed: ${e.message}`)))
    setTimeout(() => rej(new Error('socket connect timeout')), 10000)
  })

  console.log('\nBroker upload flow')

  // ── Robinhood upload, in that broker's CSV format ──
  const rhCsv = [
    'Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount',
    '06/01/2026,06/01/2026,06/03/2026,AAPL,Apple Inc,Buy,10,$300.00,($3000.00)',
    '06/02/2026,06/02/2026,06/04/2026,AAPL,Apple Inc,Sell,4,$320.00,$1280.00',
  ].join('\n')
  const rhRes = await uploadCsv(rhCsv, 'robinhood')

  test('robinhood upload succeeds', () => {
    assert.ok(rhRes.success !== false, `error: ${rhRes.error}`)
  })

  // ── Webull upload, real file ──
  const haveReal = fs.existsSync(REAL_WEBULL)
  if (!haveReal) console.log('  (real Webull file missing — using a fixture)')
  const wbCsv = haveReal ? fs.readFileSync(REAL_WEBULL, 'utf8') : [
    'Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time',
    'Apple Inc,AAPL,Buy,Filled,2,2,@310.05,310.05,DAY,06/01/2026 07:21:12 EDT,06/01/2026 07:21:32 EDT',
  ].join('\n')
  const wbRes = await uploadCsv(wbCsv, 'webull')

  test('webull upload succeeds through the real socket path', () => {
    assert.ok(wbRes.success !== false, `error: ${wbRes.error}`)
  })

  // ── Schwab upload, real file ──
  const haveSchwab = fs.existsSync(REAL_SCHWAB)
  if (!haveSchwab) console.log('  (real Schwab file missing — using a fixture)')
  const scCsv = haveSchwab ? fs.readFileSync(REAL_SCHWAB, 'utf8') : [
    '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
    '"07/31/2026","Buy","AAPL","APPLE INC","1","$301.55","","-$301.55"',
    '"08/11/2025 as of 08/08/2025","MoneyLink Transfer","","FUNDS RECEIVED","","","","$1000.00"',
  ].join('\n')
  const scRes = await uploadCsv(scCsv, 'schwab')

  test('schwab upload succeeds through the real socket path', () => {
    assert.ok(scRes.success !== false, `error: ${scRes.error}`)
  })

  // An unsupported broker must be refused outright — parsing one broker's file
  // with another's parser would produce plausible-looking wrong numbers.
  const badRes = await uploadCsv(wbCsv, 'etrade')
  test('unknown broker is rejected rather than mis-parsed', () => {
    assert.equal(badRes.success, false)
    assert.match(badRes.error || '', /Unknown broker/i)
  })

  console.log('\nBroker tabs API')

  const brokersRes = await (await fetch(`${BASE}/api/brokers`, { headers: { cookie } })).json()

  test('lists all three brokers with trade counts', () => {
    assert.equal(brokersRes.success, true)
    const names = brokersRes.brokers.map(b => b.broker).sort()
    assert.deepEqual(names, ['robinhood', 'schwab', 'webull'], JSON.stringify(brokersRes.brokers))
    brokersRes.brokers.forEach(b => assert.ok(b.trade_count > 0, `${b.broker} has no trades`))
  })

  test('earlier brokers survived each later upload', () => {
    const rh = brokersRes.brokers.find(b => b.broker === 'robinhood')
    assert.equal(rh.trade_count, 2, `expected 2 robinhood trades, got ${rh.trade_count}`)
    const wb = brokersRes.brokers.find(b => b.broker === 'webull')
    assert.ok(wb.trade_count > 0, 'webull trades were lost by the schwab upload')
  })

  console.log('\nBroker filter on YTD')

  const ytd = async (broker) => {
    const q = broker ? `?broker=${broker}` : ''
    return (await fetch(`${BASE}/api/options-pnl/ytd${q}`, { headers: { cookie } })).json()
  }
  const [all, rhOnly, wbOnly] = await Promise.all([ytd(), ytd('robinhood'), ytd('webull')])

  test('every broker filter returns a valid response', () => {
    for (const [name, r] of [['all', all], ['robinhood', rhOnly], ['webull', wbOnly]]) {
      assert.equal(r.success, true, `${name} failed: ${r.error}`)
      assert.ok(Array.isArray(r.byUnderlying), `${name} has no byUnderlying`)
    }
  })

  test('filtering to one broker never returns more than the merged view', () => {
    assert.ok(rhOnly.byUnderlying.length <= all.byUnderlying.length)
    assert.ok(wbOnly.byUnderlying.length <= all.byUnderlying.length)
  })

  console.log(`\n${passed} passed\n`)
} catch (e) {
  console.error('\nTest harness error:', e)
  process.exitCode = 1
} finally {
  await cleanup()
  setTimeout(() => process.exit(process.exitCode || 0), 250)
}
