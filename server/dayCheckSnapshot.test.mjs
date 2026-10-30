/**
 * The baseline the Day P&L check measures from.
 * Run: node server/dayCheckSnapshot.test.mjs
 *
 * The check compares Day P&L with how far Net + Open has moved since the
 * panel's snapshot at the previous close. Picking the wrong snapshot makes the
 * check itself wrong: an evening one carries after-hours stock prices, one
 * from another broker or period start measures a different book, and today's
 * own snapshots measure nothing.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DB = join(__dirname, `test_daycheck_${process.pid}.db`)
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
  } catch {}
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.existsSync(f) && fs.unlinkSync(f) } catch {}
  }
}

try {
  const { databaseService, getDatabase } = await import('./services/database.js')
  const db = getDatabase()

  // Epoch seconds for an ET wall-clock time. October 2026 is EDT (UTC-4).
  const et = (date, hm) => Math.floor(new Date(`${date}T${hm}:00-04:00`).getTime() / 1000)
  const save = (asofDate, hm, net, extra = {}) => {
    databaseService.saveNetOpenSnapshot(1, {
      asofDate, broker: 'all', periodStart: '2026-03-15', netPlusOpen: net,
      byTicker: { RDDT: { n: net, px: 134.7, sh: 200 } }, ...extra,
    })
    // saveNetOpenSnapshot stamps "now"; move it to the time under test.
    db.prepare(`UPDATE net_open_snapshots SET captured_at = ? WHERE id = (SELECT MAX(id) FROM net_open_snapshots)`)
      .run(et(asofDate, hm))
  }
  const pick = (opts = {}) => databaseService.getPrevCloseSnapshot(1,
    { broker: 'all', periodStart: '2026-03-15', today: '2026-10-30', ...opts })

  console.log('\nDay P&L check baseline')

  test('nothing to measure from before any snapshot exists', () => {
    assert.equal(pick(), null)
  })

  save('2026-10-29', '11:00', 1000)
  save('2026-10-29', '15:58', 2000)
  save('2026-10-29', '19:30', -4000)     // after hours: RDDT already down $21
  save('2026-10-30', '10:00', 500)       // today's own

  test('takes the last one by the close, not the evening one', () => {
    const s = pick()
    assert.equal(s.asofDate, '2026-10-29')
    assert.equal(s.netPlusOpen, 2000)
    assert.equal(s.capturedEt, '15:58')
    assert.equal(s.afterClose, false)
  })

  test('per-ticker figures come back parsed', () => {
    assert.deepEqual(pick().byTicker.RDDT, { n: 2000, px: 134.7, sh: 200 })
  })

  test('a different broker or period start is a different book', () => {
    assert.equal(pick({ broker: 'ibkr' }), null)
    assert.equal(pick({ periodStart: '2026-01-01' }), null)
  })

  save('2026-10-28', '20:15', 900)

  test('a day with only an evening snapshot is used, but flagged', () => {
    const s = pick({ today: '2026-10-29' })
    assert.equal(s.asofDate, '2026-10-28')
    assert.equal(s.netPlusOpen, 900)
    assert.equal(s.afterClose, true)
  })

  test('snapshots without per-ticker figures are skipped', () => {
    databaseService.saveNetOpenSnapshot(1, { asofDate: '2026-10-29', broker: 'all', periodStart: '2026-03-15', netPlusOpen: 7 })
    db.prepare(`UPDATE net_open_snapshots SET captured_at = ? WHERE id = (SELECT MAX(id) FROM net_open_snapshots)`)
      .run(et('2026-10-29', '16:01'))
    assert.equal(pick().netPlusOpen, 2000)
  })

  console.log(`\n${passed} passed`)
} finally {
  await cleanup()
}
