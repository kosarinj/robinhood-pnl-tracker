/**
 * Session-classification tests for the extended-hours parser.
 * Run: node server/services/extendedHours.test.mjs
 *
 * These exist because the pre/post branches can only be observed live at 4am or
 * 6pm ET — the parser is pure so the clock can be supplied instead.
 */
import assert from 'node:assert/strict'
import { parseExtendedHoursChart, currentUsSession } from './priceService.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

// A trading day shaped like Yahoo's: pre 4:00-9:30, regular 9:30-16:00, post 16:00-20:00 ET.
const DAY = 1786104000            // arbitrary 4:00am ET anchor, unix seconds
const PRE = { start: DAY, end: DAY + 5.5 * 3600 }
const REG = { start: DAY + 5.5 * 3600, end: DAY + 12 * 3600 }
const POST = { start: DAY + 12 * 3600, end: DAY + 16 * 3600 }

// Bars every 5 min from 4:00am through 8:00pm, with prices encoding the hour.
function buildChart({ closes = null, regularMarketPrice = 100 } = {}) {
  const timestamp = [], quote = []
  for (let t = DAY; t < DAY + 16 * 3600; t += 300) {
    timestamp.push(t)
    quote.push(closes ? closes(t) : 100 + (t - DAY) / 3600)  // +1.00 per hour
  }
  return {
    meta: {
      regularMarketPrice,
      chartPreviousClose: 99,
      currentTradingPeriod: { pre: PRE, regular: REG, post: POST },
    },
    timestamp,
    indicators: { quote: [{ close: quote }] },
  }
}

console.log('\nSession classification')

test('pre-market at 7:00am', () => {
  const out = parseExtendedHoursChart(buildChart(), DAY + 3 * 3600)
  assert.equal(out.session, 'pre')
  assert.equal(out.stale, false)
})

test('regular at noon', () => {
  assert.equal(parseExtendedHoursChart(buildChart(), DAY + 8 * 3600).session, 'regular')
})

test('post-market at 5:00pm', () => {
  assert.equal(parseExtendedHoursChart(buildChart(), DAY + 13 * 3600).session, 'post')
})

test('closed at 2:00am (before the pre window opens)', () => {
  assert.equal(parseExtendedHoursChart(buildChart(), DAY - 2 * 3600).session, 'closed')
})

test('closed at 9:00pm (after post ends)', () => {
  assert.equal(parseExtendedHoursChart(buildChart(), DAY + 17 * 3600).session, 'closed')
})

console.log('\nBar selection')

test('never reads a bar from the future', () => {
  // The regression this guards: a 1d chart holds the whole day, so without a
  // clock filter a 7am request would return the 8pm bar.
  const nowSec = DAY + 3 * 3600
  const out = parseExtendedHoursChart(buildChart(), nowSec)
  assert.ok(out.asOf <= nowSec * 1000, `asOf ${out.asOf} is after now ${nowSec * 1000}`)
  assert.ok(Math.abs(out.price - 103) < 0.2, `expected ~103 (7am), got ${out.price}`)
})

test('post-market ignores bars from the regular session', () => {
  // Only the 4:00pm bar exists in the post window; everything later is null.
  const chart = buildChart({ closes: t => (t >= POST.start && t < POST.start + 600 ? 150 : null) })
  const out = parseExtendedHoursChart(chart, DAY + 13 * 3600)
  assert.equal(out.session, 'post')
  assert.equal(out.price, 150)
})

test('falls back to the regular close when the session has no trades yet', () => {
  // 4:05am with nothing printed — the common case at the pre-market open.
  const chart = buildChart({ closes: () => null, regularMarketPrice: 123.45 })
  const out = parseExtendedHoursChart(chart, DAY + 300)
  assert.equal(out.stale, true)
  assert.equal(out.price, 123.45)
  assert.equal(out.asOf, null)
})

test('does not leak the prior session into pre-market', () => {
  // Bars exist only before the pre window (i.e. yesterday's post session).
  const chart = buildChart({ closes: t => (t < PRE.start + 600 ? null : null) })
  chart.timestamp.unshift(DAY - 3600)
  chart.indicators.quote[0].close.unshift(999)
  const out = parseExtendedHoursChart(chart, DAY + 1800)
  assert.notEqual(out.price, 999, 'picked up a bar from before the session')
  assert.equal(out.stale, true)
})

test('returns null when there is no usable price at all', () => {
  const chart = buildChart({ closes: () => null, regularMarketPrice: 0 })
  assert.equal(parseExtendedHoursChart(chart, DAY + 300), null)
})

test('returns null for a missing result', () => {
  assert.equal(parseExtendedHoursChart(null, DAY), null)
})

console.log('\nSession from the clock (drives the pre/post price overlay)')

// Build a Date that reads as a given ET wall-clock time.
const at = (dateStr, timeStr) => new Date(`${dateStr}T${timeStr}-04:00`)   // EDT

test('pre-market window is 4:00am–9:30am ET', () => {
  assert.equal(currentUsSession(at('2026-08-10', '04:00:00')), 'pre')
  assert.equal(currentUsSession(at('2026-08-10', '09:06:00')), 'pre')
  assert.equal(currentUsSession(at('2026-08-10', '09:29:59')), 'pre')
})

test('regular session starts at 9:30 ET', () => {
  assert.equal(currentUsSession(at('2026-08-10', '09:30:00')), 'regular')
  assert.equal(currentUsSession(at('2026-08-10', '15:59:00')), 'regular')
})

test('after hours runs 4pm–8pm ET', () => {
  assert.equal(currentUsSession(at('2026-08-10', '16:00:00')), 'post')
  assert.equal(currentUsSession(at('2026-08-10', '19:59:00')), 'post')
})

test('overnight and weekends are closed', () => {
  assert.equal(currentUsSession(at('2026-08-10', '03:00:00')), 'closed')
  assert.equal(currentUsSession(at('2026-08-10', '20:00:00')), 'closed')
  assert.equal(currentUsSession(at('2026-08-08', '10:00:00')), 'closed')  // Saturday
  assert.equal(currentUsSession(at('2026-08-09', '10:00:00')), 'closed')  // Sunday
})

console.log(`\n${passed} passed\n`)
