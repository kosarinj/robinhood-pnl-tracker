/**
 * A print-to-print "day move" must be directionally possible.
 * Run: node server/printPairPlausible.test.mjs
 *
 * A short RDDT Sep-2028 $300 call read -715 on a day the stock fell 1.33%: it was
 * marked 25.85 -> 33.00, up 27.7%, on a DOWN day. A call cannot rise while its
 * underlying falls — vol changes the size of a move, never its sign against the
 * underlying — so those two prints were not adjacent sessions. On a barely-traded
 * LEAP, `previous_close` is whenever it last printed, which can be weeks back.
 *
 * The existing stale-print guard missed it because today's print genuinely WAS
 * today's; only the other side was stale. Freshness was verified on one side.
 *
 * The rule is deliberately narrow. Preferring a model to real market data is how
 * several figures here went wrong before, so it rejects only the impossible: the
 * sign must contradict the underlying, and both moves must be big enough to mean
 * something rather than being rounding on a penny option.
 */
import assert from 'node:assert/strict'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}

// Mirrors server/index.js printPairIsPlausible. Kept here rather than exported
// because index.js boots a server on import; if that function changes, this must.
function printPairIsPlausible({ type, markNow, markPrev, underNow, underPrev }) {
  if (!(markNow > 0) || !(markPrev > 0) || !(underNow > 0) || !(underPrev > 0)) return true
  const underMove = (underNow - underPrev) / underPrev
  const markMove = (markNow - markPrev) / markPrev
  if (Math.abs(underMove) < 0.002 || Math.abs(markMove) < 0.10) return true
  const expectedSign = type === 'put' ? -Math.sign(underMove) : Math.sign(underMove)
  return Math.sign(markMove) === expectedSign
}

test('the real RDDT case is rejected: call up 27.7% on a stock down 1.33%', () => {
  assert.equal(printPairIsPlausible({
    type: 'call', markNow: 33.00, markPrev: 25.85, underNow: 156.00, underPrev: 158.10,
  }), false)
})

test('a call rising with its underlying is accepted', () => {
  assert.equal(printPairIsPlausible({
    type: 'call', markNow: 33.00, markPrev: 25.85, underNow: 162.00, underPrev: 158.10,
  }), true)
})

test('a put rising as the underlying falls is accepted', () => {
  assert.equal(printPairIsPlausible({
    type: 'put', markNow: 3.20, markPrev: 2.00, underNow: 150.00, underPrev: 158.10,
  }), true)
})

test('a put rising WITH the underlying is rejected', () => {
  assert.equal(printPairIsPlausible({
    type: 'put', markNow: 3.20, markPrev: 2.00, underNow: 166.00, underPrev: 158.10,
  }), false)
})

test('a big option move on a flat underlying is left alone — no direction to contradict', () => {
  assert.equal(printPairIsPlausible({
    type: 'call', markNow: 33.00, markPrev: 25.85, underNow: 158.20, underPrev: 158.10,
  }), true)
})

test('a small option move is left alone even against the underlying', () => {
  // 5% on a contract is ordinary noise; only an impossible-sized move is rejected.
  assert.equal(printPairIsPlausible({
    type: 'call', markNow: 1.05, markPrev: 1.00, underNow: 150.00, underPrev: 158.10,
  }), true)
})

test('a penny option is never rejected on rounding', () => {
  assert.equal(printPairIsPlausible({
    type: 'call', markNow: 0.02, markPrev: 0.01, underNow: 150.00, underPrev: 158.10,
  }), false, 'a 100% move IS large enough to judge')
  // ...but one that barely moves is not judged at all.
  assert.equal(printPairIsPlausible({
    type: 'call', markNow: 0.0105, markPrev: 0.01, underNow: 150.00, underPrev: 158.10,
  }), true)
})

test('missing inputs never reject — nothing to judge against', () => {
  assert.equal(printPairIsPlausible({ type: 'call', markNow: 33, markPrev: 25.85, underNow: 0, underPrev: 158.10 }), true)
  assert.equal(printPairIsPlausible({ type: 'call', markNow: 33, markPrev: 0, underNow: 156, underPrev: 158.10 }), true)
})

console.log(`\n${passed} passed\n`)
