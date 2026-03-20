/**
 * Parse a Robinhood option description into components.
 * Handles: "PLTR 01/17/2025 Call $155.00"
 */
export function parseOptionDescription(description) {
  if (!description) return null
  const match = description.match(/^([A-Z]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(Call|Put)\s+\$?([\d.]+)/i)
  if (!match) return null
  return {
    ticker:  match[1],
    month:   match[2].padStart(2, '0'),
    day:     match[3].padStart(2, '0'),
    year:    match[4],
    type:    match[5].toLowerCase(),
    strike:  parseFloat(match[6])
  }
}

/**
 * Convert to Polygon.io option ticker format.
 * e.g. "PLTR 01/17/2025 Call $155.00" → "O:PLTR250117C00155000"
 */
export function toPolygonTicker(description) {
  const p = parseOptionDescription(description)
  if (!p) return null
  const yy = p.year.slice(2)
  const typeChar = p.type === 'call' ? 'C' : 'P'
  const strikePadded = String(Math.round(p.strike * 1000)).padStart(8, '0')
  return `O:${p.ticker}${yy}${p.month}${p.day}${typeChar}${strikePadded}`
}

/**
 * Calculate premium left (extrinsic value) for an option.
 */
export function calcPremiumLeft(optionPrice, stockPrice, strike, type) {
  const intrinsic = type === 'call'
    ? Math.max(0, stockPrice - strike)
    : Math.max(0, strike - stockPrice)
  const extrinsic = Math.max(0, optionPrice - intrinsic)
  return {
    intrinsic: Math.round(intrinsic * 100) / 100,
    extrinsic: Math.round(extrinsic * 100) / 100,
    itm: intrinsic > 0,
    optionPrice: Math.round(optionPrice * 100) / 100
  }
}
