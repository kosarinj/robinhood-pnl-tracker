/**
 * Webull "Orders Records" CSV → the same trade shape the Robinhood parser emits.
 *
 * Header (as exported Aug 2026):
 *   Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time
 *
 * Differences from the Robinhood export that this has to bridge:
 *  - No Amount column. Webull gives price and quantity; amount is computed.
 *    There is also no fee/commission field, so realized P&L from an orders
 *    export is gross of fees and won't tie exactly to a Webull statement.
 *  - Price is prefixed with '@' ("@211.4000000000").
 *  - Timestamps carry a zone suffix ("08/07/2026 11:01:13 EDT").
 *  - Rows include unfilled and cancelled orders; only filled quantity counts.
 *  - Side is Buy/Sell rather than Robinhood's BTO/STO/BTC/STC trans codes.
 */

import Papa from 'papaparse'

const num = (v) => {
  if (v === null || v === undefined) return 0
  const cleaned = String(v).replace(/[@$,\s]/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

/**
 * "08/07/2026 11:01:13 EDT" → "2026-08-07".
 *
 * Deliberately takes the calendar date as printed rather than converting to
 * local time: the trade happened on that date in the broker's own statement,
 * and shifting it can move a trade across a year boundary and land it in the
 * wrong tax year.
 */
export function parseWebullDate(value) {
  if (!value) return null
  const m = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  const [, mo, day, yr] = m
  return `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/**
 * Webull option rows aren't in this account's export yet, so this recognizes
 * the shapes Webull is known to use and normalizes them to the Robinhood
 * description the rest of the app parses:
 *
 *     "PLTR 01/17/2025 Call $155.00"
 *
 * Returns null for a plain stock row. UNVERIFIED against real Webull option
 * data — when a genuine option export exists, check this against it first.
 */
export function normalizeWebullOption(symbol, name) {
  const candidates = [symbol, name].filter(Boolean).map(s => String(s).trim())

  for (const raw of candidates) {
    // OCC-style: "PLTR250117C00155000" (optionally spaced)
    const occ = raw.replace(/\s+/g, '').match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
    if (occ) {
      const [, ticker, yy, mm, dd, cp, strike] = occ
      const strikeNum = parseInt(strike, 10) / 1000
      return `${ticker} ${mm}/${dd}/20${yy} ${cp === 'C' ? 'Call' : 'Put'} $${strikeNum.toFixed(2)}`
    }

    // Human-readable: "PLTR 01/17/2025 155 Call" / "PLTR 250117 155C" etc.
    const human = raw.match(
      /^([A-Z]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+\$?([\d.]+)\s*(Call|Put|C|P)\b/i
    )
    if (human) {
      const [, ticker, mm, dd, yr, strike, cp] = human
      const year = yr.length === 2 ? `20${yr}` : yr
      const type = /^c/i.test(cp) ? 'Call' : 'Put'
      return `${ticker} ${mm.padStart(2, '0')}/${dd.padStart(2, '0')}/${year} ${type} $${parseFloat(strike).toFixed(2)}`
    }

    // Already in Robinhood form
    if (/^[A-Z]+\s+\d{1,2}\/\d{1,2}\/\d{4}\s+(Call|Put)\s+\$?[\d.]+/i.test(raw)) return raw
  }
  return null
}

/**
 * Map a filled Webull order to a trans code the P&L engine understands.
 *
 * Webull's orders export says only Buy/Sell — it doesn't distinguish opening
 * from closing. For stocks that's fine (the engine matches buys to sells).
 * For options the engine wants BTO/STO/BTC/STC, and an orders export can't
 * tell us which. We emit the opening codes and let position matching sort it
 * out, which is correct for the common case of opening then closing, but
 * cannot represent an option position that was open before this export begins.
 */
function transCodeFor(side, isOption) {
  const buy = /buy/i.test(side)
  if (!isOption) return buy ? 'Buy' : 'Sell'
  return buy ? 'BTO' : 'STO'
}

/**
 * Parse a Webull orders CSV.
 *
 * `input` may be a File/Blob (browser), a string, or a Buffer.
 * Returns { trades, skipped, warnings }.
 */
export function parseWebullOrders(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input
  const results = Papa.parse(text, { header: true, skipEmptyLines: true })

  const trades = []
  const warnings = []
  let skipped = 0

  const rows = results.data || []
  if (rows.length && !('Filled' in rows[0]) && !('Symbol' in rows[0])) {
    throw new Error('This does not look like a Webull orders export (missing Symbol/Filled columns)')
  }

  rows.forEach((row, index) => {
    const status = (row['Status'] || '').trim()
    const symbolRaw = (row['Symbol'] || '').trim()
    const side = (row['Side'] || '').trim()
    if (!symbolRaw || !side) { skipped++; return }

    // Cancelled/pending orders never moved shares. "Partially Filled" did —
    // for the amount that actually filled.
    const filled = num(row['Filled'])
    if (!(filled > 0)) { skipped++; return }
    if (/cancel|reject|expire/i.test(status) && filled === 0) { skipped++; return }

    const date = parseWebullDate(row['Filled Time'] || row['Placed Time'])
    if (!date) { skipped++; warnings.push(`Row ${index + 2}: unreadable date`); return }

    // Avg Price is the fill price; Price is the order's limit price.
    const price = num(row['Avg Price']) || num(row['Price'])
    if (!(price > 0)) { skipped++; warnings.push(`Row ${index + 2}: no fill price for ${symbolRaw}`); return }

    const optionDesc = normalizeWebullOption(symbolRaw, row['Name'])
    const isOption = !!optionDesc
    const isBuy = /buy/i.test(side)

    // An option's price is per share; the contract is 100 of them.
    const gross = isOption ? price * filled * 100 : price * filled
    // Sign matches the Robinhood convention: buys cost money (negative),
    // sells bring it in (positive).
    const amount = isBuy ? -Math.abs(gross) : Math.abs(gross)

    trades.push({
      date,
      transDate: date,
      symbol: isOption ? optionDesc : symbolRaw,
      instrument: isOption ? optionDesc : symbolRaw,
      description: isOption ? optionDesc : (row['Name'] || symbolRaw),
      transCode: transCodeFor(side, isOption),
      isOption,
      isBuy,
      isExpiry: false,
      // Options carry quantity 1 / price = amount, matching the Robinhood
      // parser so downstream contract math lines up.
      contracts: isOption ? filled : 1,
      quantity: isOption ? 1 : filled,
      price: isOption ? amount : price,
      amount,
      broker: 'webull',
    })
  })

  if (trades.some(t => t.isOption)) {
    warnings.push(
      'Option rows were detected. The Webull option format has not been verified ' +
      'against a real export — check a few contracts before trusting the P&L.'
    )
  }

  return { trades, skipped, warnings }
}

export default parseWebullOrders
