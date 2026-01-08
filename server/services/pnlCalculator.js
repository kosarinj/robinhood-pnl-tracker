// Helper to extract parent instrument from option description
// e.g., "AAPL 01/15/2024 $150 Call" -> "AAPL"
const extractParentInstrument = (description) => {
  if (!description) return null

  // Options typically start with the ticker symbol
  // Match word characters at the beginning before a space or date
  const match = description.match(/^([A-Z]+)/)
  const result = match ? match[1] : null

  // Debug first 5 options
  if (!result) {
    console.log(`⚠️ No parent found for: "${description}"`)
  }

  return result
}

// Helper to check if an option has expired relative to a specific date
// e.g., "PLTR 11/14/2025 Call $190.00" expired on 11/14/2025
// If asofDate is 12/15/2025, this option is expired
// If asofDate is 10/15/2025, this option is NOT expired yet
const isOptionExpired = (symbol, asofDate = null) => {
  if (!symbol) return false

  // Match date pattern MM/DD/YYYY
  const dateMatch = symbol.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!dateMatch) return false

  const [, month, day, year] = dateMatch
  const expirationDate = new Date(year, month - 1, day) // month is 0-indexed
  expirationDate.setHours(0, 0, 0, 0)

  // Use provided asofDate or today's date
  const referenceDate = asofDate ? new Date(asofDate) : new Date()
  referenceDate.setHours(0, 0, 0, 0)

  return expirationDate < referenceDate
}

// Calculate P&L using Average Cost, FIFO, and LIFO methods
export const calculatePnL = (trades, currentPrices, rollupOptions = true, debugCallback = null, asofDate = null, dividendsAndInterest = []) => {
  const debugLog = (msg) => {
    if (debugCallback) debugCallback(msg)
  }

  // Debug: Count input options
  const inputOptions = trades.filter(t => t.isOption).length
  debugLog(`Input: ${trades.length} trades, ${inputOptions} are options`)

  // Group trades by symbol
  const tradesBySymbol = trades.reduce((acc, trade) => {
    if (!acc[trade.symbol]) {
      acc[trade.symbol] = []
    }
    acc[trade.symbol].push(trade)
    return acc
  }, {})

  const results = []
  const optionsByParent = {} // Track options by their parent instrument

  // Calculate P&L for each symbol
  Object.keys(tradesBySymbol).forEach((symbol) => {
    const symbolTrades = tradesBySymbol[symbol]
    const currentPrice = currentPrices[symbol] || 0

    // Determine if this symbol represents options
    const isOption = symbolTrades.some(t => t.isOption)

    // Calculate Real P&L (simple buy/sell matching)
    const real = calculateReal(symbolTrades, currentPrice, symbol, dividendsAndInterest)

    // Calculate Average Cost P&L
    const avgCost = calculateAverageCost(symbolTrades, currentPrice)

    // Calculate FIFO P&L
    const fifo = calculateFIFO(symbolTrades, currentPrice)

    // Calculate LIFO P&L
    const lifo = calculateLIFO(symbolTrades, currentPrice)

    // Extract parent instrument from description for options
    const description = symbolTrades[0].description || symbolTrades[0].instrument || symbol
    const parentInstrument = isOption ? extractParentInstrument(description) : null

    const item = {
      symbol,
      instrument: symbolTrades[0].instrument,
      isOption,
      currentPrice,
      real,
      avgCost,
      fifo,
      lifo,
      parentInstrument
    }

    // Check if this is an expired option relative to the data date - if so, set position to 0
    if (isOption && isOptionExpired(symbol, asofDate)) {
      debugLog(`⏰ Expired option detected: ${symbol} (as of ${asofDate || 'today'}) - Realized P&L: $${item.real.realizedPnL}`)
      // Keep realized P&L but zero out position and unrealized P&L
      item.real.position = 0
      item.real.unrealizedPnL = 0
      item.real.totalPnL = item.real.realizedPnL // Recalculate total to only include realized

      item.avgCost.position = 0
      item.avgCost.unrealizedPnL = 0

      item.fifo.position = 0
      item.fifo.unrealizedPnL = 0
      item.fifo.totalPnL = item.fifo.realizedPnL // Recalculate total to only include realized

      item.lifo.position = 0
      item.lifo.unrealizedPnL = 0
      item.lifo.totalPnL = item.lifo.realizedPnL // Recalculate total to only include realized
    }

    results.push(item)

    // Track options by parent for aggregation
    if (isOption && parentInstrument) {
      debugLog(`✓ Option: ${symbol} -> Parent: ${parentInstrument}`)
      if (!optionsByParent[parentInstrument]) {
        optionsByParent[parentInstrument] = []
      }
      optionsByParent[parentInstrument].push(item)
    } else if (isOption && !parentInstrument) {
      debugLog(`✗ Option without parent: ${symbol}`)
    }
  })

  // Debug: Show what we found
  const totalOptionsTracked = Object.values(optionsByParent).reduce((sum, opts) => sum + opts.length, 0)
  debugLog(`Tracked ${totalOptionsTracked} options across ${Object.keys(optionsByParent).length} parent stocks`)
  if (Object.keys(optionsByParent).length > 0) {
    debugLog(`Parents: ${Object.keys(optionsByParent).join(', ')}`)
  }

  // Add options P&L to stocks
  results.forEach(item => {
    if (!item.isOption && optionsByParent[item.symbol]) {
      // This stock has options - calculate total options P&L
      const options = optionsByParent[item.symbol]

      debugLog(`\n📊 ${item.symbol} has ${options.length} options:`)
      options.forEach(opt => {
        debugLog(`   ${opt.symbol}: P&L=$${opt.real.totalPnL}`)
      })

      const totalOptionsPnL = options.reduce((sum, opt) => sum + (opt.real.totalPnL || 0), 0)
      item.optionsPnL = totalOptionsPnL
      item.optionsCount = options.length
      item.options = options // Store options array for trade history

      debugLog(`   TOTAL Options P&L for ${item.symbol}: $${totalOptionsPnL} (${options.length} options)`)
      console.log(`📊 ${item.symbol}: optionsPnL = $${item.optionsPnL}, options count = ${item.optionsCount}`)
    } else {
      item.optionsPnL = 0
      item.optionsCount = 0
      item.options = []
    }
  })

  // Filter out individual options, keep only stocks
  const stocksOnly = results.filter(item => !item.isOption)
  const optionsFiltered = results.filter(item => item.isOption)

  console.log(`🔍 calculatePnL returning ${stocksOnly.length} stocks (filtered out ${optionsFiltered.length} individual options)`)
  if (optionsFiltered.length > 0) {
    console.log(`   Filtered options: ${optionsFiltered.map(o => o.symbol).slice(0, 5).join(', ')}${optionsFiltered.length > 5 ? '...' : ''}`)
  }

  return stocksOnly.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

// Rollup options under their parent instrument
const rollupOptionsByParent = (pnlData) => {
  const grouped = {}
  const stocksAndOthers = []

  pnlData.forEach(item => {
    if (item.isOption && item.parentInstrument) {
      // Group option under parent instrument
      if (!grouped[item.parentInstrument]) {
        grouped[item.parentInstrument] = {
          symbol: item.parentInstrument,
          instrument: item.parentInstrument,
          isOption: false,
          isRollup: true,
          currentPrice: 0, // Parent stock price would need to be fetched separately
          options: [],
          // Initialize aggregated P&L values
          real: { realizedPnL: 0, unrealizedPnL: 0, totalPnL: 0, position: 0, avgCostBasis: 0, percentageReturn: 0, lowestOpenBuyPrice: 0, lowestOpenBuyDaysAgo: 0, recentLowestBuyPrice: 0, recentLowestBuyDaysAgo: 0, recentLowestSellPrice: 0, recentLowestSellDaysAgo: 0 },
          avgCost: { unrealizedPnL: 0, position: 0, avgCostBasis: 0 },
          fifo: { realizedPnL: 0, unrealizedPnL: 0, totalPnL: 0, position: 0, avgCostBasis: 0 },
          lifo: { realizedPnL: 0, unrealizedPnL: 0, totalPnL: 0, position: 0, avgCostBasis: 0 }
        }
      }

      // Add this option to the parent's options array
      grouped[item.parentInstrument].options.push(item)

      // Aggregate P&L values
      const parent = grouped[item.parentInstrument]
      parent.real.realizedPnL += item.real.realizedPnL || 0
      parent.real.unrealizedPnL += item.real.unrealizedPnL || 0
      parent.real.totalPnL += item.real.totalPnL || 0

      parent.avgCost.unrealizedPnL += item.avgCost.unrealizedPnL || 0

      parent.fifo.realizedPnL += item.fifo.realizedPnL || 0
      parent.fifo.unrealizedPnL += item.fifo.unrealizedPnL || 0
      parent.fifo.totalPnL += item.fifo.totalPnL || 0

      parent.lifo.realizedPnL += item.lifo.realizedPnL || 0
      parent.lifo.unrealizedPnL += item.lifo.unrealizedPnL || 0
      parent.lifo.totalPnL += item.lifo.totalPnL || 0
    } else {
      // Not an option or no parent found - keep as is
      stocksAndOthers.push(item)
    }
  })

  // Combine stocks with rolled-up option groups
  const rolledUpParents = Object.values(grouped)

  return [...stocksAndOthers, ...rolledUpParents].sort((a, b) => {
    // Sort by symbol alphabetically
    return a.symbol.localeCompare(b.symbol)
  })
}

// Real P&L calculation - Simple approach: sum all buy/sell amounts
const calculateReal = (trades, currentPrice, symbol, dividendsAndInterest = []) => {
  let totalBuyAmount = 0
  let totalSellAmount = 0
  let totalBuyShares = 0
  let totalSellShares = 0
  let position = 0

  // Track buy queue to calculate lowest open buy price (using FIFO)
  const buyQueue = []

  // Track ALL buys to find the lowest buy price ever
  let lowestBuyEver = null

  // Track most recent buys - keep top 10 most recent by date
  let mostRecentBuys = []
  // Track most recent sells - keep top 10 most recent by date
  let mostRecentSells = []
  const maxToTrack = 10 // Track up to 10 of each

  trades.forEach((trade) => {
    if (trade.isBuy) {
      totalBuyAmount += trade.quantity * trade.price
      totalBuyShares += trade.quantity
      position += trade.quantity
      buyQueue.push({
        quantity: trade.quantity,
        price: trade.price,
        date: trade.date || trade.transDate
      })

      const tradeDate = new Date(trade.date || trade.transDate)
      tradeDate.setHours(0, 0, 0, 0)

      // Track lowest buy ever (including sold positions)
      if (!lowestBuyEver || trade.price < lowestBuyEver.price) {
        lowestBuyEver = {
          price: trade.price,
          date: trade.date || trade.transDate
        }
      }

      // Track all buys for most recent buys list
      mostRecentBuys.push({
        price: trade.price,
        date: trade.date || trade.transDate,
        dateObj: tradeDate
      })
    } else {
      totalSellAmount += trade.quantity * trade.price
      totalSellShares += trade.quantity
      position -= trade.quantity

      const tradeDate = new Date(trade.date || trade.transDate)
      tradeDate.setHours(0, 0, 0, 0)

      // Track all sells for most recent sells list
      mostRecentSells.push({
        price: trade.price,
        date: trade.date || trade.transDate,
        dateObj: tradeDate
      })

      // Remove sold shares from buy queue (FIFO)
      let remainingSellQty = trade.quantity
      while (remainingSellQty > 0 && buyQueue.length > 0) {
        const oldestBuy = buyQueue[0]
        if (oldestBuy.quantity <= remainingSellQty) {
          remainingSellQty -= oldestBuy.quantity
          buyQueue.shift()
        } else {
          oldestBuy.quantity -= remainingSellQty
          remainingSellQty = 0
        }
      }
    }
  })

  // Calculate total dividends and interest for this symbol
  let totalDividends = 0
  let totalInterest = 0

  dividendsAndInterest.forEach(item => {
    if (item.symbol === symbol) {
      if (item.isDividend) {
        totalDividends += item.amount
      } else if (item.isInterest) {
        totalInterest += item.amount
      }
    }
  })

  // Realized P&L = Total sell amount - Total buy amount + Dividends - Interest
  const realizedPnL = totalSellAmount - totalBuyAmount + totalDividends - totalInterest

  // Unrealized P&L = Current value of remaining position
  let unrealizedPnL = 0
  let avgCostBasis = 0
  let lowestOpenBuyPrice = 0
  let lowestOpenBuyDaysAgo = 0
  let recentLowestBuyPrice = 0
  let recentLowestBuyDaysAgo = 0
  let recentLowestSellPrice = 0
  let recentLowestSellDaysAgo = 0

  if (position > 0) {
    unrealizedPnL = position * currentPrice
    avgCostBasis = totalBuyAmount > 0 ? totalBuyAmount / totalBuyShares : 0
  }

  // Find the lowest buy price from ALL buys (not just open positions)
  if (lowestBuyEver) {
    lowestOpenBuyPrice = lowestBuyEver.price

    // Calculate how many days ago this buy was made
    const buyDate = new Date(lowestBuyEver.date)
    buyDate.setHours(0, 0, 0, 0)
    const todayCalc = new Date()
    todayCalc.setHours(0, 0, 0, 0)
    lowestOpenBuyDaysAgo = Math.floor((todayCalc - buyDate) / (1000 * 60 * 60 * 24))
  }

  // Sort and keep top 10 most recent buys (by date descending, then price ascending)
  mostRecentBuys.sort((a, b) => {
    // First sort by date (descending - newest first)
    const dateDiff = b.dateObj - a.dateObj
    if (dateDiff !== 0) return dateDiff
    // Then by price (ascending - lowest first) for same-day buys
    return a.price - b.price
  })
  mostRecentBuys = mostRecentBuys.slice(0, maxToTrack)

  // Calculate days ago for each buy
  const todayCalc = new Date()
  todayCalc.setHours(0, 0, 0, 0)
  const recentBuysWithDays = mostRecentBuys.map(buy => {
    const buyDate = new Date(buy.date)
    buyDate.setHours(0, 0, 0, 0)
    const daysAgo = Math.floor((todayCalc - buyDate) / (1000 * 60 * 60 * 24))
    return {
      price: roundToTwo(buy.price),
      date: buy.date,
      daysAgo: daysAgo
    }
  })

  // Sort and keep top 10 most recent sells (by date, descending)
  mostRecentSells.sort((a, b) => b.dateObj - a.dateObj)
  mostRecentSells = mostRecentSells.slice(0, maxToTrack)

  // Calculate days ago for each sell
  const recentSellsWithDays = mostRecentSells.map(sell => {
    const sellDate = new Date(sell.date)
    sellDate.setHours(0, 0, 0, 0)
    const daysAgo = Math.floor((todayCalc - sellDate) / (1000 * 60 * 60 * 24))
    return {
      price: roundToTwo(sell.price),
      date: sell.date,
      daysAgo: daysAgo
    }
  })

  // Set legacy single values for backwards compatibility (first item from each array)
  if (recentBuysWithDays.length > 0) {
    recentLowestBuyPrice = recentBuysWithDays[0].price
    recentLowestBuyDaysAgo = recentBuysWithDays[0].daysAgo
  }
  if (recentSellsWithDays.length > 0) {
    recentLowestSellPrice = recentSellsWithDays[0].price
    recentLowestSellDaysAgo = recentSellsWithDays[0].daysAgo
  }

  // Total P&L = Realized + Unrealized
  const totalPnL = realizedPnL + unrealizedPnL

  // Calculate percentage return: Total P&L / total invested
  const percentageReturn = totalBuyAmount > 0 ? (totalPnL / totalBuyAmount) * 100 : 0

  return {
    realizedPnL: roundToTwo(realizedPnL),
    unrealizedPnL: roundToTwo(unrealizedPnL),
    totalPnL: roundToTwo(totalPnL),
    position: roundToTwo(position),
    avgCostBasis: roundToTwo(avgCostBasis),
    percentageReturn: roundToTwo(percentageReturn),
    lowestOpenBuyPrice: roundToTwo(lowestOpenBuyPrice),
    lowestOpenBuyDaysAgo: lowestOpenBuyDaysAgo,
    recentLowestBuyPrice: roundToTwo(recentLowestBuyPrice),
    recentLowestBuyDaysAgo: recentLowestBuyDaysAgo,
    recentLowestSellPrice: roundToTwo(recentLowestSellPrice),
    recentLowestSellDaysAgo: recentLowestSellDaysAgo,
    recentLowestBuys: recentBuysWithDays,  // Array of top 10 most recent
    recentSells: recentSellsWithDays  // Array of top 10 most recent
  }
}

// Average Cost calculation - simple weighted average of all purchases
const calculateAverageCost = (trades, currentPrice) => {
  let totalShares = 0
  let totalCost = 0

  // Track all buys and sells
  trades.forEach((trade) => {
    if (trade.isBuy) {
      totalShares += trade.quantity
      totalCost += trade.quantity * trade.price
    } else {
      totalShares -= trade.quantity
    }
  })

  // Calculate average cost basis and unrealized P&L
  let avgCostBasis = 0
  let unrealizedPnL = 0

  if (totalShares > 0 && totalCost > 0) {
    // Calculate weighted average cost across all purchases
    avgCostBasis = totalCost / (totalShares + trades.filter(t => !t.isBuy).reduce((sum, t) => sum + t.quantity, 0))
    unrealizedPnL = (currentPrice - avgCostBasis) * totalShares
  }

  return {
    unrealizedPnL: roundToTwo(unrealizedPnL),
    position: roundToTwo(totalShares),
    avgCostBasis: roundToTwo(avgCostBasis)
  }
}

// FIFO (First In, First Out) calculation
const calculateFIFO = (trades, currentPrice) => {
  const buyQueue = []
  let realizedPnL = 0
  let totalShares = 0

  trades.forEach((trade) => {
    if (trade.isBuy) {
      // Add to buy queue
      buyQueue.push({
        quantity: trade.quantity,
        price: trade.price,
        date: trade.date
      })
      totalShares += trade.quantity
    } else {
      // Sell - match with oldest buys first (FIFO)
      let remainingSellQty = trade.quantity
      const sellPrice = trade.price

      while (remainingSellQty > 0 && buyQueue.length > 0) {
        const oldestBuy = buyQueue[0]

        if (oldestBuy.quantity <= remainingSellQty) {
          // Fully consume this buy
          realizedPnL += (sellPrice - oldestBuy.price) * oldestBuy.quantity
          remainingSellQty -= oldestBuy.quantity
          totalShares -= oldestBuy.quantity
          buyQueue.shift()
        } else {
          // Partially consume this buy
          realizedPnL += (sellPrice - oldestBuy.price) * remainingSellQty
          oldestBuy.quantity -= remainingSellQty
          totalShares -= remainingSellQty
          remainingSellQty = 0
        }
      }
    }
  })

  // Calculate unrealized P&L on remaining position
  let unrealizedPnL = 0
  let avgCostBasis = 0
  const position = buyQueue.reduce((sum, buy) => sum + buy.quantity, 0)

  // Only calculate unrealized if position is meaningfully greater than zero (not just rounding errors)
  if (buyQueue.length > 0 && position > 0.0001) {
    const totalCost = buyQueue.reduce((sum, buy) => sum + (buy.price * buy.quantity), 0)
    avgCostBasis = totalCost / position
    unrealizedPnL = (currentPrice - avgCostBasis) * position
  }

  return {
    realizedPnL: roundToTwo(realizedPnL),
    unrealizedPnL: position > 0.0001 ? roundToTwo(unrealizedPnL) : 0,
    totalPnL: roundToTwo(realizedPnL + (position > 0.0001 ? unrealizedPnL : 0)),
    position: position > 0.0001 ? roundToTwo(position) : 0,
    avgCostBasis: roundToTwo(avgCostBasis)
  }
}

// LIFO (Last In, First Out) calculation
const calculateLIFO = (trades, currentPrice) => {
  const buyStack = []
  let realizedPnL = 0
  let totalShares = 0

  trades.forEach((trade) => {
    if (trade.isBuy) {
      // Add to buy stack
      buyStack.push({
        quantity: trade.quantity,
        price: trade.price,
        date: trade.date
      })
      totalShares += trade.quantity
    } else {
      // Sell - match with newest buys first (LIFO)
      let remainingSellQty = trade.quantity
      const sellPrice = trade.price

      while (remainingSellQty > 0 && buyStack.length > 0) {
        const newestBuy = buyStack[buyStack.length - 1]

        if (newestBuy.quantity <= remainingSellQty) {
          // Fully consume this buy
          realizedPnL += (sellPrice - newestBuy.price) * newestBuy.quantity
          remainingSellQty -= newestBuy.quantity
          totalShares -= newestBuy.quantity
          buyStack.pop()
        } else {
          // Partially consume this buy
          realizedPnL += (sellPrice - newestBuy.price) * remainingSellQty
          newestBuy.quantity -= remainingSellQty
          totalShares -= remainingSellQty
          remainingSellQty = 0
        }
      }
    }
  })

  // Calculate unrealized P&L on remaining position
  let unrealizedPnL = 0
  let avgCostBasis = 0
  const position = buyStack.reduce((sum, buy) => sum + buy.quantity, 0)

  // Only calculate unrealized if position is meaningfully greater than zero (not just rounding errors)
  if (buyStack.length > 0 && position > 0.0001) {
    const totalCost = buyStack.reduce((sum, buy) => sum + (buy.price * buy.quantity), 0)
    avgCostBasis = totalCost / position
    unrealizedPnL = (currentPrice - avgCostBasis) * position
  }

  return {
    realizedPnL: roundToTwo(realizedPnL),
    unrealizedPnL: position > 0.0001 ? roundToTwo(unrealizedPnL) : 0,
    totalPnL: roundToTwo(realizedPnL + (position > 0.0001 ? unrealizedPnL : 0)),
    position: position > 0.0001 ? roundToTwo(position) : 0,
    avgCostBasis: roundToTwo(avgCostBasis)
  }
}

// Helper function to round to 2 decimal places
const roundToTwo = (num) => {
  return Math.round((num + Number.EPSILON) * 100) / 100
}
