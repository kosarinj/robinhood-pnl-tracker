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

export default pairSpreads
