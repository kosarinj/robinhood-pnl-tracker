/**
 * Charles Schwab "Transactions" CSV → the trade / dividend / deposit shapes the
 * rest of the app uses.
 *
 * Header (as exported Aug 2026):
 *   "Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
 *
 * Richer than the Webull orders export — this one carries dividends, interest
 * and cash transfers, so it can feed the income and deposits paths too.
 *
 * Things this has to bridge:
 *  - Dates can read "12/16/2025 as of 12/15/2025": posted date, then the date it
 *    actually applies to. The "as of" date is the real event date and is what
 *    decides the tax year, so that's the one used.
 *  - Currency is formatted ("-$301.55", "$234.8757") and Amount is signed and
 *    already net of fees, so Amount is authoritative rather than qty x price.
 *  - Action is a verb, not a trans code: Buy/Sell for stock, Buy to Open and
 *    friends for options, plus non-trade rows (dividends, interest, transfers).
 */

import Papa from 'papaparse'

const money = (v) => {
  if (v === null || v === undefined) return 0
  const raw = String(v).trim()
  if (!raw) return 0
  // Schwab writes negatives with a leading minus outside the symbol: -$301.55
  const negative = raw.startsWith('-') || (raw.startsWith('(') && raw.endsWith(')'))
  const n = parseFloat(raw.replace(/[$,()\s-]/g, ''))
  if (!Number.isFinite(n)) return 0
  return negative ? -n : n
}

const qty = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? Math.abs(n) : 0
}

/**
 * "07/31/2026" or "12/16/2025 as of 12/15/2025" → "2025-12-15".
 *
 * Prefers the "as of" date: that's when the transaction actually applied, and
 * using the posted date could push a late-December item into the wrong tax year.
 */
export function parseSchwabDate(value) {
  if (!value) return null
  const raw = String(value).trim()
  const asOf = raw.match(/as of\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i)
  const m = asOf || raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  const [, mo, day, yr] = m
  return `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`
}

// Schwab's option Action verbs map onto the trans codes the P&L engine expects.
const ACTION_TO_CODE = {
  'buy': 'Buy',
  'sell': 'Sell',
  'buy to open': 'BTO',
  'sell to open': 'STO',
  'buy to close': 'BTC',
  'sell to close': 'STC',
  'assigned': 'OASGN',
  'expired': 'OEXP',
  'exchange or exercise': 'OEXC',
}

const DIVIDEND_ACTIONS = /dividend|cash div|reinvest div/i
const INTEREST_ACTIONS = /interest/i
const DEPOSIT_ACTIONS = /moneylink|journal|wire|transfer|contribution|deposit/i

/**
 * Schwab option rows aren't in this account's export, so this recognizes the
 * documented shapes and normalizes to the Robinhood description the rest of the
 * app parses ("PLTR 01/17/2025 Call $155.00"). Returns null for a stock row.
 *
 * UNVERIFIED against a real Schwab option export.
 */
export function normalizeSchwabOption(symbol, description) {
  for (const raw of [symbol, description].filter(Boolean).map(s => String(s).trim())) {
    // "AAPL 01/17/2026 200.00 C" / "AAPL 01/17/2026 200.00 CALL"
    let m = raw.match(/^([A-Z]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\$?([\d.]+)\s*(C|P|CALL|PUT)\b/i)
    if (m) {
      const [, ticker, mo, day, yr, strike, cp] = m
      const type = /^c/i.test(cp) ? 'Call' : 'Put'
      return `${ticker} ${mo.padStart(2, '0')}/${day.padStart(2, '0')}/${yr} ${type} $${parseFloat(strike).toFixed(2)}`
    }
    // "CALL AAPL 01/17/2026 200" — verb first
    m = raw.match(/^(CALL|PUT)\s+([A-Z]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\$?([\d.]+)/i)
    if (m) {
      const [, cp, ticker, mo, day, yr, strike] = m
      const type = /^c/i.test(cp) ? 'Call' : 'Put'
      return `${ticker} ${mo.padStart(2, '0')}/${day.padStart(2, '0')}/${yr} ${type} $${parseFloat(strike).toFixed(2)}`
    }
    // Already in Robinhood form
    if (/^[A-Z]+\s+\d{1,2}\/\d{1,2}\/\d{4}\s+(Call|Put)\s+\$?[\d.]+/i.test(raw)) return raw
  }
  return null
}

/**
 * Parse a Schwab transactions CSV.
 *
 * Returns { trades, dividendsAndInterest, deposits, totalPrincipal, skipped, warnings }.
 */
export function parseSchwabTransactions(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)
  // Schwab sometimes prefixes a title line before the header row.
  const cleaned = text.replace(/^﻿/, '')
  const lines = cleaned.split(/\r?\n/)
  const headerIdx = lines.findIndex(l => /"?Date"?\s*,\s*"?Action"?/i.test(l))
  const body = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : cleaned

  const results = Papa.parse(body, { header: true, skipEmptyLines: true })
  const rows = results.data || []
  if (rows.length && !('Action' in rows[0])) {
    throw new Error('This does not look like a Schwab transactions export (no Action column)')
  }

  const trades = []
  const dividendsAndInterest = []
  const deposits = []
  const warnings = []
  let skipped = 0

  rows.forEach((row, index) => {
    const action = (row['Action'] || '').trim()
    if (!action) { skipped++; return }
    const date = parseSchwabDate(row['Date'])
    if (!date) { skipped++; warnings.push(`Row ${index + 2}: unreadable date`); return }

    const symbol = (row['Symbol'] || '').trim()
    const description = (row['Description'] || '').trim()
    const amount = money(row['Amount'])
    const key = action.toLowerCase()

    // ── Income ──
    if (DIVIDEND_ACTIONS.test(action) || INTEREST_ACTIONS.test(action)) {
      const isDividend = DIVIDEND_ACTIONS.test(action)
      dividendsAndInterest.push({
        id: index,
        date: new Date(`${date}T12:00:00`),
        symbol,
        amount: Math.abs(amount),
        transCode: isDividend ? 'CDIV' : 'INT',
        isDividend,
        isInterest: !isDividend,
        description: description || action,
        broker: 'schwab',
      })
      return
    }

    // ── Cash in/out ──
    if (DEPOSIT_ACTIONS.test(action)) {
      // Only money coming IN is principal; withdrawals would overstate it.
      if (amount > 0) {
        deposits.push({
          date: new Date(`${date}T12:00:00`),
          amount: Math.abs(amount),
          description: description || action,
          broker: 'schwab',
        })
      }
      return
    }

    // ── Trades ──
    const transCode = ACTION_TO_CODE[key]
    if (!transCode) { skipped++; return }   // corporate actions, journals, etc.

    const optionDesc = normalizeSchwabOption(symbol, description)
    const isOption = !!optionDesc
    const filled = qty(row['Quantity'])
    const price = money(row['Price'])
    if (!symbol && !optionDesc) { skipped++; return }
    if (!(filled > 0)) { skipped++; return }

    const isBuy = ['Buy', 'BTO', 'BTC'].includes(transCode)
    // Amount is already signed and net of fees; fall back to qty x price only
    // when Schwab left it blank (assignments and expirations often do).
    const gross = isOption ? price * filled * 100 : price * filled
    const signed = amount !== 0 ? amount : (isBuy ? -Math.abs(gross) : Math.abs(gross))

    trades.push({
      date,
      transDate: date,
      symbol: isOption ? optionDesc : symbol,
      instrument: isOption ? optionDesc : symbol,
      description: isOption ? optionDesc : (description || symbol),
      transCode,
      isOption,
      isBuy,
      isExpiry: transCode === 'OEXP' || transCode === 'OASGN' || transCode === 'OEXC',
      // Options carry quantity 1 / price = amount, matching the Robinhood parser
      // so downstream contract math lines up.
      contracts: isOption ? filled : 1,
      quantity: isOption ? 1 : filled,
      price: isOption ? signed : price,
      amount: signed,
      broker: 'schwab',
    })
  })

  if (trades.some(t => t.isOption)) {
    warnings.push(
      'Option rows were detected. The Schwab option format has not been verified ' +
      'against a real export — check a few contracts before trusting the P&L.'
    )
  }

  const totalPrincipal = deposits.reduce((s, d) => s + d.amount, 0)
  return { trades, dividendsAndInterest, deposits, totalPrincipal, skipped, warnings }
}

export default parseSchwabTransactions
