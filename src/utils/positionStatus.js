/**
 * What needs attention on a ticker, as a short list of tags.
 *
 * Shared by the Positions status dots, the strategy pockets and the timeline
 * so all three call the same thing "near strike". Ordered by urgency: the
 * first tag is the one a dot shows.
 *
 * Only short CALLS count as near strike. Assignment on a short put just buys
 * shares the plan is happy to own; a call being assigned is the costly side.
 */

export const STATUS = {
  near:     { label: 'Near strike',        color: '#e5484d' },
  expiring: { label: 'Expiring this week', color: '#f59e0b' },
  exdate:   { label: 'Ex-date soon',       color: '#a855f7' },
  earnings: { label: 'Earnings soon',      color: '#3b82f6' },
  safe:     { label: 'Safe',               color: '#10b981' },
}

// A short call within this much of its strike (or through it) is "near".
export const NEAR_PCT = 3

const dayMs = 86400000
export const daysBetween = (fromIso, toIso) =>
  Math.round((new Date(toIso + 'T12:00:00Z') - new Date(fromIso + 'T12:00:00Z')) / dayMs)

/** The Friday that ends the trading week containing `today` (weekends look ahead). */
export const weekFriday = (today) => {
  const d = new Date(today + 'T12:00:00Z')
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + (dow === 6 ? 6 : dow === 0 ? 5 : 5 - dow))
  return d.toISOString().slice(0, 10)
}

/** Distance of the stock from a short call's strike, in % (negative = through it). */
export const strikeGapPct = (price, strike) =>
  price > 0 && strike > 0 ? Math.round(((strike - price) / price) * 1000) / 10 : null

/**
 * @param price        current stock price
 * @param legs         open legs for this ticker: { type, strike, expiry, isLong, contracts }
 * @param earningsDate ISO or null
 * @param exDates      ISO ex-dividend dates still to come
 */
export function tickerStatus({ price, legs = [], earningsDate = null, exDates = [], today }) {
  const tags = []
  const shortCalls = legs.filter(l => !l.isLong && l.type === 'call')

  const near = shortCalls
    .map(l => ({ l, gap: strikeGapPct(price, l.strike) }))
    .filter(x => x.gap != null && x.gap <= NEAR_PCT)
    .sort((a, b) => a.gap - b.gap)
  if (near.length) {
    const { l, gap } = near[0]
    tags.push({ key: 'near', ...STATUS.near,
      detail: gap <= 0 ? `$${l.strike} call is ${Math.abs(gap)}% in the money`
                       : `$${l.strike} call is ${gap}% from the strike` })
  }

  const fri = weekFriday(today)
  const expiring = legs.filter(l => l.expiry <= fri)
  if (expiring.length) {
    const n = expiring.reduce((a, l) => a + (l.contracts || 0), 0)
    tags.push({ key: 'expiring', ...STATUS.expiring,
      detail: `${n} contract${n !== 1 ? 's' : ''} expire${n === 1 ? 's' : ''} by ${fri.slice(5).replace('-', '/')}` })
  }

  const ex = exDates.filter(d => d >= today).sort()[0]
  if (ex && daysBetween(today, ex) <= 10) {
    tags.push({ key: 'exdate', ...STATUS.exdate,
      detail: `ex-dividend in ${daysBetween(today, ex)}d` + (shortCalls.length ? ' — early assignment risk on the short calls' : '') })
  }

  if (earningsDate && earningsDate >= today && daysBetween(today, earningsDate) <= 7) {
    tags.push({ key: 'earnings', ...STATUS.earnings, detail: `earnings in ${daysBetween(today, earningsDate)}d` })
  }

  if (shortCalls.length && !near.length) {
    const closest = shortCalls.map(l => strikeGapPct(price, l.strike)).filter(g => g != null).sort((a, b) => a - b)[0]
    tags.push({ key: 'safe', ...STATUS.safe,
      detail: closest != null ? `nearest short call ${closest}% away` : 'short calls out of the money' })
  }
  return tags
}

/** Title text for a dot: every tag, one per line. */
export const statusTitle = (tags) => tags.map(t => `${t.label}: ${t.detail}`).join('\n')
