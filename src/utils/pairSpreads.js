const r2 = n => Math.round(n * 100) / 100

/**
 * Pair open option legs into verticals.
 *
 * Each short is matched with the nearest long of the same underlying, expiry
 * and type — nearest by strike, because that is the leg actually capping the
 * risk. A short 78 put protected by a 77 is a $1 spread whatever else is held
 * further out. Quantities are consumed as they pair, so an uneven position (3
 * short against 2 long) yields a 2-lot spread and leaves 1 naked short behind
 * rather than silently overstating the protection.
 *
 * `singles` carries what is left unpaired, each with `remaining` contracts and
 * `remainingPnl` — the leftover's share of the leg's P&L, prorated by contract
 * count. Callers that judge legs on their own merit (the roll-candidates pill)
 * must use those rather than the whole leg's figures, or a partly-paired leg
 * reports the spread's gain as if it were standalone.
 *
 * Shared by SpreadsPanel and RollCandidatesAlert so the two can never disagree
 * about what counts as a spread.
 */
export function pairSpreads(positions) {
  const legs = (positions || []).filter(p => (p.openContracts || 0) > 0)
  const groups = new Map()
  for (const p of legs) {
    const k = `${p.ticker}|${p.expiry}|${p.optionType}`
    groups.set(k, [...(groups.get(k) || []), { ...p, left: p.openContracts }])
  }
  const spreads = []
  for (const group of groups.values()) {
    const shorts = group.filter(p => !p.isLong).sort((a, b) => a.strike - b.strike)
    const longs = group.filter(p => p.isLong)
    for (const s of shorts) {
      while (s.left > 0) {
        const avail = longs.filter(l => l.left > 0)
        if (!avail.length) break
        avail.sort((a, b) => Math.abs(a.strike - s.strike) - Math.abs(b.strike - s.strike))
        const l = avail[0]
        const n = Math.min(s.left, l.left)
        s.left -= n; l.left -= n

        // avgCostPerContract is per contract; markPrice is per share. Mixing
        // the two — or forgetting the ×100 — is how this goes quietly wrong.
        const credit = r2((s.avgCostPerContract - l.avgCostPerContract) * n)
        const nowCost = r2(((s.markPrice || 0) - (l.markPrice || 0)) * 100 * n)
        const width = r2(Math.abs(s.strike - l.strike) * 100 * n)
        const isCredit = credit >= 0
        spreads.push({
          ticker: s.ticker, type: s.optionType, expiry: s.expiry, n,
          lo: Math.min(s.strike, l.strike), hi: Math.max(s.strike, l.strike),
          shortStrike: s.strike, longStrike: l.strike,
          shortSymbol: s.symbol, longSymbol: l.symbol,
          // Per-share marks, kept so the caller can back out implied vol from
          // the short leg and handicap the spread.
          shortMark: s.markPrice || null, longMark: l.markPrice || null,
          credit, nowCost, width, isCredit,
          pnl: r2(credit - nowCost),
          maxProfit: isCredit ? credit : r2(width - Math.abs(credit)),
          maxLoss: isCredit ? r2(width - credit) : Math.abs(credit),
          stock: s.stockPrice ?? l.stockPrice ?? null,
          priced: !!(s.markSource && l.markSource),
          // In the money against you: the short leg is the one that hurts.
          breached: s.stockPrice > 0 &&
            (s.optionType === 'put' ? s.stockPrice < s.strike : s.stockPrice > s.strike),
        })
      }
    }
  }
  spreads.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1
    : a.ticker.localeCompare(b.ticker)))

  const singles = []
  for (const group of groups.values()) {
    for (const p of group) {
      if (p.left <= 0) continue
      const share = p.left / p.openContracts
      singles.push({
        ...p,
        remaining: p.left,
        remainingPnl: p.unrealizedPnl == null ? null : r2(p.unrealizedPnl * share),
      })
    }
  }
  singles.sort((a, b) => (a.expiry < b.expiry ? -1 : 1))
  return { spreads, singles }
}

/**
 * Every leg at one ticker, expiry and type, netted into one row.
 *
 * The spread rows answer "what did this vertical do", which is a correct
 * question and the wrong one for a position with extra protection under it.
 * Sell a 182.50 put against a 180, then buy a 175 as well: pairSpreads matches
 * the short with the NEAREST long, so the 182.50/180 is the spread and the 175
 * falls out as a loose leg. On a selloff the spread shows a loss while the 175
 * pays -- and the loss is real, so crediting it to the spread would be a lie.
 * They are one decision though, and this is the grouping that says so.
 *
 * Keyed on expiry as well as ticker and type: the extra put is bought at the
 * same expiry, so it belongs with that week's structure rather than with every
 * put ever held on the name. A diagonal would need the key relaxed, and would
 * read as two structures here.
 */
export function buildStructures(spreads, singles) {
  const m = new Map()
  const touch = (ticker, expiry, type) => {
    const k = `${ticker}|${expiry}|${type}`
    if (!m.has(k)) {
      m.set(k, {
        key: k, ticker, expiry, type,
        pnl: 0, spreadPnl: 0, loosePnl: 0,
        spreads: 0, looseLegs: 0, parts: [],
        priced: true,
      })
    }
    return m.get(k)
  }

  for (const s of spreads) {
    const g = touch(s.ticker, s.expiry, s.type)
    g.pnl += s.pnl || 0
    g.spreadPnl += s.pnl || 0
    g.spreads += 1
    if (!s.priced) g.priced = false
    g.parts.push({
      kind: 'spread',
      label: `${s.lo}/${s.hi} ${s.type === 'put' ? 'put' : 'call'} ×${s.n}`,
      pnl: s.pnl || 0,
    })
  }

  for (const p of singles) {
    const g = touch(p.ticker, p.expiry, p.optionType)
    // remainingPnl, not the whole leg's: a partly-paired leg has already given
    // its paired contracts to a spread above, and counting the leg twice would
    // inflate the structure.
    const v = p.remainingPnl
    if (v == null) g.priced = false
    g.pnl += v || 0
    g.loosePnl += v || 0
    g.looseLegs += 1
    g.parts.push({
      kind: 'loose',
      label: `${p.isLong ? 'long' : 'short'} $${p.strike} ×${p.remaining}`,
      pnl: v,
    })
  }

  // Only the ones where the question even arises. A lone vertical with nothing
  // beside it is already answered by its own row, and listing it again here
  // would bury the cases that differ.
  return [...m.values()]
    .filter(g => g.spreads > 0 && g.looseLegs > 0)
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1
      : a.ticker.localeCompare(b.ticker)))
}

export default pairSpreads
