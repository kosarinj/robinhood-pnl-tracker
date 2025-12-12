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

// Calculate P&L using Average Cost, FIFO, and LIFO methods
export const calculatePnL = (trades, currentPrices, rollupOptions = true, debugCallback = null, previousClosePrices = {}) => {
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
    const previousClose = previousClosePrices[symbol] || 0

    // Determine if this symbol represents options
    const isOption = symbolTrades.some(t => t.isOption)

    // Calculate Real P&L (simple buy/sell matching)
    const real = calculateReal(symbolTrades, currentPrice, symbol)

    // Calculate Average Cost P&L
    const avgCost = calculateAverageCost(symbolTrades, currentPrice)

    // Calculate FIFO P&L
    const fifo = calculateFIFO(symbolTrades, currentPrice)

    // Calculate LIFO P&L
    const lifo = calculateLIFO(symbolTrades, currentPrice)

    // Extract parent instrument from description for options
    const description = symbolTrades[0].description || symbolTrades[0].instrument || symbol
    const parentInstrument = isOption ? extractParentInstrument(description) : null

    // Calculate daily PNL: (Current Price - Previous Close) * Position
    const position = avgCost.position
    const dailyPnL = position > 0 ? (currentPrice - previousClose) * position : 0

    // Debug log for daily PNL issues
    if (position > 0 && dailyPnL === 0 && previousClose === 0) {
      console.warn(`[${symbol}] Daily PNL is 0: previousClose not set (${previousClose}), currentPrice=${currentPrice}, position=${position}`)
    }

    const item = {
      symbol,
      instrument: symbolTrades[0].instrument,
      isOption,
      currentPrice,
      previousClose,
      dailyPnL,
      real,
      avgCost,
      fifo,
      lifo,
      parentInstrument
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
      // This stock has options - calculate total options P&L and daily PNL
      const options = optionsByParent[item.symbol]

      debugLog(`\n📊 ${item.symbol} has ${options.length} options:`)
      options.forEach(opt => {
        debugLog(`   ${opt.symbol}: P&L=$${opt.real.totalPnL}, Daily=$${opt.dailyPnL}`)
      })

      item.optionsPnL = options.reduce((sum, opt) => sum + (opt.real.totalPnL || 0), 0)
      item.optionsDailyPnL = options.reduce((sum, opt) => sum + (opt.dailyPnL || 0), 0)
      item.optionsCount = options.length
      item.options = options // Store options array for trade history

      debugLog(`   TOTAL P&L: $${item.optionsPnL}, TOTAL DAILY: $${item.optionsDailyPnL}`)
    } else {
      item.optionsPnL = 0
      item.optionsDailyPnL = 0
      item.optionsCount = 0
      item.options = []
    }
  })

  // Filter out individual options, keep only stocks
  return results.filter(item => !item.isOption).sort((a, b) => a.symbol.localeCompare(b.symbol))
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
          real: { realizedPnL: 0, unrealizedPnL: 0, totalPnL: 0, position: 0, avgCostBasis: 0, percentageReturn: 0, lowestOpenBuyPrice: 0 },
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
const calculateReal = (trades, currentPrice, symbol) => {
  let totalBuyAmount = 0
  let totalSellAmount = 0
  let totalBuyShares = 0
  let totalSellShares = 0
  let position = 0

  // Track buy queue to calculate lowest open buy price (using FIFO)
  const buyQueue = []

  trades.forEach((trade) => {
    if (trade.isBuy) {
      totalBuyAmount += trade.quantity * trade.price
      totalBuyShares += trade.quantity
      position += trade.quantity
      buyQueue.push({
        quantity: trade.quantity,
        price: trade.price
      })
    } else {
      totalSellAmount += trade.quantity * trade.price
      totalSellShares += trade.quantity
      position -= trade.quantity

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

  // Realized P&L = Total sell amount - Total buy amount
  const realizedPnL = totalSellAmount - totalBuyAmount

  // Calculate average cost basis and unrealized P&L for remaining position
  let unrealizedPnL = 0
  let avgCostBasis = 0
  let lowestOpenBuyPrice = 0

  if (position > 0) {
    if (buyQueue.length > 0) {
      // Calculate average cost of REMAINING shares (not all shares ever bought)
      const totalCostOfRemaining = buyQueue.reduce((sum, buy) => sum + (buy.price * buy.quantity), 0)
      const totalRemainingShares = buyQueue.reduce((sum, buy) => sum + buy.quantity, 0)

      // Debug: Check if buyQueue shares match position
      if (Math.abs(totalRemainingShares - position) > 0.01) {
        console.warn(`[${symbol}] Position mismatch: position=${position}, buyQueue total=${totalRemainingShares}`)
      }

      avgCostBasis = totalRemainingShares > 0 ? totalCostOfRemaining / totalRemainingShares : 0
      lowestOpenBuyPrice = Math.min(...buyQueue.map(buy => buy.price))
    } else {
      // Fallback: If buyQueue is empty but position > 0, use old calculation
      console.warn(`[${symbol}] BuyQueue empty but position=${position}, using fallback calculation`)
      avgCostBasis = totalBuyAmount > 0 ? totalBuyAmount / totalBuyShares : 0
    }

    // Unrealized P&L = (Current Price - Avg Cost) * Position
    unrealizedPnL = (currentPrice - avgCostBasis) * position

    // Debug log for suspicious values
    if (Math.abs(unrealizedPnL) > 10000) {
      console.warn(`[${symbol}] Large unrealized P&L: ${unrealizedPnL}, currentPrice=${currentPrice}, avgCost=${avgCostBasis}, position=${position}`)
    }
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
    lowestOpenBuyPrice: roundToTwo(lowestOpenBuyPrice)
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
