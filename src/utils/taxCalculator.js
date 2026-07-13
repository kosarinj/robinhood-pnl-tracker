// Tax calculation utilities for the Tax Center tab.
//
// These functions take the same `trades` array the rest of the app uses
// (see server/services/csvParser.js -> parseTrades) and derive the figures
// that show up on a broker's year-end tax documents: cost basis, realized
// short-term vs long-term gains, dividend/interest income, wash-sale flags,
// and a rough tax estimate.
//
// IMPORTANT: This is an informational estimate only, NOT tax advice, and NOT
// a substitute for the official 1099 your broker issues. Cost-basis methods,
// wash-sale rules across accounts, qualified-dividend classification, and
// option straddle rules are simplified here.

const MS_PER_DAY = 24 * 60 * 60 * 1000
const LONG_TERM_DAYS = 365 // held MORE than 1 year = long-term

const toDate = (d) => (d instanceof Date ? d : new Date(d))
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// Is this trade a stock (vs an option contract)?
const isStock = (t) => !t.isOption

// ---------------------------------------------------------------------------
// Realized gains via FIFO lot matching (long positions only for stocks).
// Returns an array of realized "sale" records, each with term + wash-sale flag.
// ---------------------------------------------------------------------------
export function computeStockRealized(trades) {
  const bySymbol = {}
  for (const t of trades) {
    if (!isStock(t)) continue
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = []
    bySymbol[t.symbol].push(t)
  }

  const realized = []

  for (const [symbol, list] of Object.entries(bySymbol)) {
    // chronological order
    const sorted = [...list].sort((a, b) => toDate(a.date) - toDate(b.date))
    const lots = [] // open buy lots: { date, qty, costPerShare }

    for (const t of sorted) {
      const qty = Math.abs(t.quantity)
      const pricePerShare = t.price // per-share for stocks
      if (qty <= 0) continue

      if (t.isBuy) {
        lots.push({ date: toDate(t.date), qty, costPerShare: pricePerShare })
      } else {
        // Sell: consume lots FIFO
        let remaining = qty
        while (remaining > 0.0000001 && lots.length > 0) {
          const lot = lots[0]
          const take = Math.min(remaining, lot.qty)
          const proceeds = take * pricePerShare
          const cost = take * lot.costPerShare
          const holdingDays = Math.floor((toDate(t.date) - lot.date) / MS_PER_DAY)
          realized.push({
            symbol,
            type: 'stock',
            quantity: round2(take),
            buyDate: lot.date,
            sellDate: toDate(t.date),
            proceeds: round2(proceeds),
            costBasis: round2(cost),
            gain: round2(proceeds - cost),
            holdingDays,
            term: holdingDays > LONG_TERM_DAYS ? 'long' : 'short',
            washSale: false
          })
          lot.qty -= take
          remaining -= take
          if (lot.qty <= 0.0000001) lots.shift()
        }
        // If selling more than held (short/oversold from partial data), ignore excess.
      }
    }
  }

  flagWashSales(realized, trades)
  return realized.sort((a, b) => a.sellDate - b.sellDate)
}

// ---------------------------------------------------------------------------
// Options realized P&L. Options in this app use the full contract description
// as the symbol, quantity=1, price=amount. We net buys/sells per contract and
// realize when the contract is fully closed (or expires worthless).
// Classified short/long by time between first open and last close.
// ---------------------------------------------------------------------------
export function computeOptionsRealized(trades) {
  const byContract = {}
  for (const t of trades) {
    if (isStock(t)) continue
    if (!byContract[t.symbol]) byContract[t.symbol] = []
    byContract[t.symbol].push(t)
  }

  const realized = []
  for (const [symbol, list] of Object.entries(byContract)) {
    const sorted = [...list].sort((a, b) => toDate(a.date) - toDate(b.date))
    let buyAmt = 0
    let sellAmt = 0
    let firstDate = null
    let lastDate = null
    for (const t of sorted) {
      firstDate = firstDate || toDate(t.date)
      lastDate = toDate(t.date)
      // Expiry (OEXP) with amount 0 = expired worthless (nothing added).
      if (t.isBuy) buyAmt += t.amount
      else sellAmt += t.amount
    }
    // Only count as realized if there was both an open and a close, OR an expiry.
    const hasExpiry = sorted.some((t) => t.isExpiry)
    const closed = (buyAmt > 0 && sellAmt > 0) || hasExpiry
    if (!closed) continue
    const gain = sellAmt - buyAmt
    const holdingDays = firstDate && lastDate ? Math.floor((lastDate - firstDate) / MS_PER_DAY) : 0
    realized.push({
      symbol,
      type: 'option',
      quantity: 1,
      buyDate: firstDate,
      sellDate: lastDate,
      proceeds: round2(sellAmt),
      costBasis: round2(buyAmt),
      gain: round2(gain),
      holdingDays,
      term: holdingDays > LONG_TERM_DAYS ? 'long' : 'short',
      washSale: false
    })
  }
  return realized.sort((a, b) => a.sellDate - b.sellDate)
}

// ---------------------------------------------------------------------------
// Wash-sale flagging (simplified): a stock sold at a LOSS is flagged if the
// same symbol was bought within 30 days before or after the sale date.
// Real wash-sale rules span accounts and "substantially identical" securities;
// this catches the common same-ticker case only.
// ---------------------------------------------------------------------------
function flagWashSales(realized, trades) {
  const buysBySymbol = {}
  for (const t of trades) {
    if (!isStock(t) || !t.isBuy) continue
    if (!buysBySymbol[t.symbol]) buysBySymbol[t.symbol] = []
    buysBySymbol[t.symbol].push(toDate(t.date))
  }
  for (const r of realized) {
    if (r.type !== 'stock' || r.gain >= 0) continue
    const buys = buysBySymbol[r.symbol] || []
    for (const b of buys) {
      const diff = Math.abs((b - r.sellDate) / MS_PER_DAY)
      // exclude the exact lot that was sold (same day is still a replacement buy)
      if (diff <= 30 && b.getTime() !== r.buyDate.getTime()) {
        r.washSale = true
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Open positions with remaining cost basis (FIFO leftovers). Also reports the
// earliest open-lot date so the UI can show a long-term-treatment countdown.
// ---------------------------------------------------------------------------
export function computeOpenLots(trades) {
  const bySymbol = {}
  for (const t of trades) {
    if (!isStock(t)) continue
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = []
    bySymbol[t.symbol].push(t)
  }

  const open = []
  for (const [symbol, list] of Object.entries(bySymbol)) {
    const sorted = [...list].sort((a, b) => toDate(a.date) - toDate(b.date))
    const lots = []
    for (const t of sorted) {
      const qty = Math.abs(t.quantity)
      if (qty <= 0) continue
      if (t.isBuy) {
        lots.push({ date: toDate(t.date), qty, costPerShare: t.price })
      } else {
        let remaining = qty
        while (remaining > 0.0000001 && lots.length > 0) {
          const lot = lots[0]
          const take = Math.min(remaining, lot.qty)
          lot.qty -= take
          remaining -= take
          if (lot.qty <= 0.0000001) lots.shift()
        }
      }
    }
    const totalQty = lots.reduce((s, l) => s + l.qty, 0)
    if (totalQty <= 0.0000001) continue
    const totalCost = lots.reduce((s, l) => s + l.qty * l.costPerShare, 0)
    const earliestDate = lots.reduce((min, l) => (l.date < min ? l.date : min), lots[0].date)
    open.push({
      symbol,
      quantity: round2(totalQty),
      costBasis: round2(totalCost),
      avgCost: round2(totalCost / totalQty),
      earliestDate,
      earliestHoldingDays: Math.floor((Date.now() - earliestDate) / MS_PER_DAY)
    })
  }
  return open.sort((a, b) => b.costBasis - a.costBasis)
}

// ---------------------------------------------------------------------------
// Dividend / interest income totals (optionally filtered to a tax year).
// ---------------------------------------------------------------------------
export function summarizeIncome(dividendsAndInterest = [], year = null) {
  let dividends = 0
  let interest = 0
  for (const d of dividendsAndInterest) {
    if (year && toDate(d.date).getFullYear() !== year) continue
    if (d.isDividend) dividends += d.amount
    else if (d.isInterest) interest += d.amount
  }
  return { dividends: round2(dividends), interest: round2(interest) }
}

// ---------------------------------------------------------------------------
// Detect any tax withholding entries in the raw CSV rows (backup withholding,
// foreign tax paid, etc.). Robinhood may not export these; returns 0 if none.
// ---------------------------------------------------------------------------
export function detectWithholding(trades = [], dividendsAndInterest = [], year = null) {
  let withheld = 0
  const scan = (rows) => {
    for (const r of rows || []) {
      const desc = ((r.description || r.rawRow?.Description || '') + '').toLowerCase()
      const dt = r.date ? toDate(r.date) : (r.rawRow?.['Activity Date'] ? new Date(r.rawRow['Activity Date']) : null)
      if (year && dt && dt.getFullYear() !== year) continue
      const isWithholding =
        desc.includes('withholding') ||
        desc.includes('backup withhold') ||
        desc.includes('foreign tax')
      if (isWithholding) {
        withheld += Math.abs(r.amount || 0)
      }
    }
  }
  scan(trades)
  scan(dividendsAndInterest)
  return round2(withheld)
}

// ---------------------------------------------------------------------------
// List available tax years present in the data (from sells + income).
// ---------------------------------------------------------------------------
export function availableTaxYears(trades = [], dividendsAndInterest = []) {
  const years = new Set()
  for (const t of trades) {
    if (!t.isBuy) years.add(toDate(t.date).getFullYear())
  }
  for (const d of dividendsAndInterest) {
    years.add(toDate(d.date).getFullYear())
  }
  const arr = [...years].filter((y) => y && !isNaN(y)).sort((a, b) => b - a)
  return arr
}

// ---------------------------------------------------------------------------
// Aggregate everything for a given tax year into a single summary object.
// ---------------------------------------------------------------------------
export function buildTaxSummary(trades = [], dividendsAndInterest = [], year) {
  const stockRealized = computeStockRealized(trades).filter(
    (r) => !year || r.sellDate.getFullYear() === year
  )
  const optionsRealized = computeOptionsRealized(trades).filter(
    (r) => !year || (r.sellDate && r.sellDate.getFullYear() === year)
  )
  const allRealized = [...stockRealized, ...optionsRealized]

  const sum = (arr, key) => round2(arr.reduce((s, r) => s + (r[key] || 0), 0))
  const shortTerm = allRealized.filter((r) => r.term === 'short')
  const longTerm = allRealized.filter((r) => r.term === 'long')

  const income = summarizeIncome(dividendsAndInterest, year)
  const withholding = detectWithholding(trades, dividendsAndInterest, year)
  const openLots = computeOpenLots(trades)
  const washSales = allRealized.filter((r) => r.washSale)

  return {
    year,
    stockRealized,
    optionsRealized,
    allRealized,
    shortTermGain: sum(shortTerm, 'gain'),
    longTermGain: sum(longTerm, 'gain'),
    totalRealizedGain: sum(allRealized, 'gain'),
    totalProceeds: sum(allRealized, 'proceeds'),
    totalCostBasis: sum(allRealized, 'costBasis'),
    shortTermCount: shortTerm.length,
    longTermCount: longTerm.length,
    dividends: income.dividends,
    interest: income.interest,
    withholding,
    openLots,
    openCostBasis: sum(openLots, 'costBasis'),
    washSales,
    washSaleDisallowed: Math.abs(sum(washSales, 'gain'))
  }
}

// ---------------------------------------------------------------------------
// Fallback summary built from the app's aggregated `pnlData` (the same data the
// Dashboard / Positions tabs use) when the full lot-level trade history isn't
// loaded. pnlData has per-symbol totals but NO purchase dates, so short-term vs
// long-term cannot be split and per-lot detail / wash sales are unavailable.
// ---------------------------------------------------------------------------
export function buildSummaryFromPnl(pnlData = [], dividendsAndInterest = [], year = null) {
  const getReal = (p) => p.real || p.avgCost || {}
  const stocks = pnlData.filter((p) => p && !p.isOption && p.symbol)

  const openLots = []
  let openCostBasis = 0
  let stockRealized = 0
  for (const p of stocks) {
    const r = getReal(p)
    const position = r.position || 0
    const avgCost = r.avgCostBasis || 0
    stockRealized += r.realizedPnL || 0
    if (position > 0.01 && avgCost > 0) {
      const costBasis = position * avgCost
      openCostBasis += costBasis
      openLots.push({
        symbol: p.symbol,
        quantity: round2(position),
        avgCost: round2(avgCost),
        costBasis: round2(costBasis),
        currentPrice: p.currentPrice || 0,
        unrealizedFromData: r.unrealizedPnL != null ? round2(r.unrealizedPnL) : null,
        earliestDate: null,
        earliestHoldingDays: null
      })
    }
  }

  let optionsRealized = 0
  for (const p of pnlData) optionsRealized += p.optionsPnL || 0

  const totalRealized = round2(stockRealized + optionsRealized)
  const income = summarizeIncome(dividendsAndInterest, year)
  const withholding = detectWithholding([], dividendsAndInterest, year)

  return {
    year,
    source: 'positions',
    termUnknown: true,
    stockRealized: round2(stockRealized),
    optionsRealizedTotal: round2(optionsRealized),
    allRealized: [],
    shortTermGain: totalRealized,
    longTermGain: 0,
    totalRealizedGain: totalRealized,
    totalProceeds: null,
    totalCostBasis: null,
    shortTermCount: 0,
    longTermCount: 0,
    dividends: income.dividends,
    interest: income.interest,
    withholding,
    openLots: openLots.sort((a, b) => b.costBasis - a.costBasis),
    openCostBasis: round2(openCostBasis),
    washSales: [],
    washSaleDisallowed: 0
  }
}

// ---------------------------------------------------------------------------
// Rough federal tax estimate. All rates are user-supplied. This nets capital
// gains/losses following simplified IRS ordering and applies a $3,000 ordinary
// offset for a net capital loss. Not tax advice.
// ---------------------------------------------------------------------------
export function estimateTax({
  shortTermGain = 0,
  longTermGain = 0,
  dividends = 0,
  interest = 0,
  ordinaryRate = 24, // % marginal ordinary income rate
  longTermRate = 15, // % long-term capital gains rate
  dividendsQualified = true,
  withholding = 0
}) {
  const oRate = ordinaryRate / 100
  const lRate = longTermRate / 100

  // Net short and long term separately, then cross-net if signs differ.
  let netShort = shortTermGain
  let netLong = longTermGain
  if (netShort < 0 && netLong > 0) {
    const offset = Math.min(-netShort, netLong)
    netLong -= offset
    netShort += offset
  } else if (netLong < 0 && netShort > 0) {
    const offset = Math.min(-netLong, netShort)
    netShort -= offset
    netLong += offset
  }

  const netCapital = netShort + netLong
  let capitalLossOffset = 0
  let taxableShort = Math.max(netShort, 0)
  let taxableLong = Math.max(netLong, 0)
  if (netCapital < 0) {
    // Net capital loss: up to $3,000 deductible against ordinary income.
    capitalLossOffset = Math.min(3000, -netCapital)
    taxableShort = 0
    taxableLong = 0
  }

  const ordinaryDividends = dividendsQualified ? 0 : dividends
  const qualifiedDividends = dividendsQualified ? dividends : 0

  // Ordinary-rate income: short-term gains, interest, non-qualified dividends,
  // minus any capital-loss offset (applied against ordinary income).
  const ordinaryBase = Math.max(taxableShort + interest + ordinaryDividends - capitalLossOffset, 0)
  const ordinaryTax = ordinaryBase * oRate

  // Preferential-rate income: long-term gains + qualified dividends.
  const preferentialBase = taxableLong + qualifiedDividends
  const preferentialTax = preferentialBase * lRate

  const estimatedTax = round2(ordinaryTax + preferentialTax)
  const balance = round2(estimatedTax - withholding) // positive = owe, negative = refund

  return {
    netShort: round2(netShort),
    netLong: round2(netLong),
    netCapital: round2(netCapital),
    capitalLossOffset: round2(capitalLossOffset),
    capitalLossCarryover: round2(netCapital < 0 ? Math.max(-netCapital - 3000, 0) : 0),
    ordinaryBase: round2(ordinaryBase),
    ordinaryTax: round2(ordinaryTax),
    preferentialBase: round2(preferentialBase),
    preferentialTax: round2(preferentialTax),
    estimatedTax,
    withholding: round2(withholding),
    balance
  }
}

// ---------------------------------------------------------------------------
// Which IRS forms are likely relevant, given the account activity.
// `status`: 'likely' (data suggests it applies) or 'possible' (only if the
// listed condition is true for this account).
// ---------------------------------------------------------------------------
export function relevantForms(summary) {
  const hasSales = summary.allRealized.length > 0 || Math.abs(summary.totalRealizedGain || 0) > 0 || (summary.openLots && summary.openLots.length > 0)
  const hasDividends = summary.dividends > 0
  const hasInterest = summary.interest > 0
  return [
    {
      form: '1099-B',
      title: 'Proceeds from Broker Transactions',
      desc: 'Reports each sale of stocks/options: proceeds, cost basis, and gain/loss (short vs long term). Flows onto Form 8949 and Schedule D.',
      status: hasSales ? 'likely' : 'na',
      condition: 'You sold securities this year.'
    },
    {
      form: '1099-DIV',
      title: 'Dividends and Distributions',
      desc: 'Reports ordinary and qualified dividends and capital gain distributions. Flows onto Schedule B (and Schedule D for cap-gain distributions).',
      status: hasDividends ? 'likely' : 'na',
      condition: 'You received $10+ in dividends.'
    },
    {
      form: '1099-INT',
      title: 'Interest Income',
      desc: 'Reports interest earned (e.g., cash sweep / margin interest rebates). Flows onto Schedule B.',
      status: hasInterest ? 'likely' : 'na',
      condition: 'You received $10+ in interest.'
    },
    {
      form: '1099-MISC',
      title: 'Miscellaneous Income',
      desc: 'Reports referral stock, promotions, or other miscellaneous income of $600+ (sometimes lower).',
      status: 'possible',
      condition: 'You received referral/promo rewards.'
    },
    {
      form: '1099-R',
      title: 'Distributions From Retirement Accounts',
      desc: 'Reports distributions from an IRA / retirement account. Only applies to retirement accounts, not a standard brokerage account.',
      status: 'possible',
      condition: 'You took a distribution from an IRA/retirement account.'
    },
    {
      form: '5498',
      title: 'IRA Contribution Information',
      desc: 'Reports IRA contributions and year-end fair market value. Informational; issued in May, not needed to file.',
      status: 'possible',
      condition: 'You contributed to an IRA.'
    },
    {
      form: '1042-S',
      title: 'U.S. Source Income for Foreign Persons',
      desc: 'Reports U.S. income and tax withheld for non-resident aliens. Only applies if you are a non-U.S. person for tax purposes.',
      status: 'possible',
      condition: 'You are a non-resident alien / foreign person.'
    },
    {
      form: '8949 + Schedule D',
      title: 'Sales and Dispositions of Capital Assets',
      desc: 'The forms YOU file that itemize each 1099-B sale and total your net capital gain/loss. This tab computes these numbers for you.',
      status: hasSales ? 'likely' : 'na',
      condition: 'You had capital gains/losses.'
    },
    {
      form: 'Schedule B',
      title: 'Interest and Ordinary Dividends',
      desc: 'The form YOU file if total interest + dividends exceed $1,500.',
      status: summary.dividends + summary.interest > 1500 ? 'likely' : (hasDividends || hasInterest ? 'possible' : 'na'),
      condition: 'Interest + dividends over $1,500.'
    }
  ]
}
