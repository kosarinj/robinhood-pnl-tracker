// Helper to extract parent instrument from option description
// e.g., "AAPL 01/15/2024 $150 Call" -> "AAPL"
const extractParentInstrument = (description) => {
  if (!description) return null

  // Options typically start with the ticker symbol
  // Match word characters at the beginning before a space or date
  const match = description.match(/^([A-Z]+)/)
  return match ? match[1] : null
}

// Calculate P&L using Average Cost, FIFO, and LIFO methods
export const calculatePnL = (trades, currentPrices, rollupOptions = true) => {
  // Group trades by symbol
  const tradesBySymbol = trades.reduce((acc, trade) => {
    if (!acc[trade.symbol]) {
      acc[trade.symbol] = []
    }
    acc[trade.symbol].push(trade)
    return acc
  }, {})

  const results = []

  // Calculate P&L for each symbol
  Object.keys(tradesBySymbol).forEach((symbol) => {
    const symbolTrades = tradesBySymbol[symbol]
    const currentPrice = currentPrices[symbol] || 0

    // Determine if this symbol represents options
    const isOption = symbolTrades.some(t => t.isOption)

    // Calculate Real P&L (simple buy/sell matching)
    const real = calculateReal(symbolTrades, currentPrice)

    // Calculate Average Cost P&L
    const avgCost = calculateAverageCost(symbolTrades, currentPrice)

    // Calculate FIFO P&L
    const fifo = calculateFIFO(symbolTrades, currentPrice)

    // Calculate LIFO P&L
    const lifo = calculateLIFO(symbolTrades, currentPrice)

    results.push({
      symbol,
      instrument: symbolTrades[0].instrument,
      isOption,
      currentPrice,
      real,
      avgCost,
      fifo,
      lifo,
      parentInstrument: isOption ? extractParentInstrument(symbol) : null
    })
  })

  // If rollupOptions is true, group options under their parent instruments
  if (rollupOptions) {
    return rollupOptionsByParent(results)
  }

  return results
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

// Real P&L calculation - hybrid approach: use lowest cost when selling below average, otherwise use average
const calculateReal = (trades, currentPrice) => {
  const buyQueue = [] // Track individual buy lots sorted by price (for finding lowest)
  let totalBought = 0
  let totalBuyCost = 0
  let position = 0
  let realizedPnL = 0

  trades.forEach((trade) => {
    if (trade.isBuy) {
      totalBought += trade.quantity
      totalBuyCost += trade.quantity * trade.price
      position += trade.quantity
      // Track individual buy lots
      buyQueue.push({
        quantity: trade.quantity,
        price: trade.price
      })
      // Keep buy queue sorted by price (lowest first)
      buyQueue.sort((a, b) => a.price - b.price)
    } else {
      // Selling
      const sellPrice = trade.price
      const sellQuantity = trade.quantity
      position -= sellQuantity

      // Calculate average buy price of all remaining shares
      const avgBuyPrice = totalBought > 0 ? totalBuyCost / totalBought : 0

      // Determine which cost basis to use for this sale
      let costBasisForSale
      if (sellPrice < avgBuyPrice) {
        // Selling below average - use lowest outstanding share price to minimize loss
        if (buyQueue.length > 0) {
          const lowestPrice = buyQueue[0].price
          costBasisForSale = lowestPrice
        } else {
          costBasisForSale = avgBuyPrice
        }
      } else {
        // Selling at or above average - use average price
        costBasisForSale = avgBuyPrice
      }

      // Calculate realized P&L for this sale
      realizedPnL += (sellPrice - costBasisForSale) * sellQuantity

      // Remove sold shares from buy queue
      let remainingSellQty = sellQuantity
      while (remainingSellQty > 0 && buyQueue.length > 0) {
        if (sellPrice < avgBuyPrice) {
          // When selling below average, remove from lowest priced lots first
          const lowestBuy = buyQueue[0]

          if (lowestBuy.quantity <= remainingSellQty) {
            // Fully consume this buy lot
            totalBought -= lowestBuy.quantity
            totalBuyCost -= lowestBuy.quantity * lowestBuy.price
            remainingSellQty -= lowestBuy.quantity
            buyQueue.shift()
          } else {
            // Partially consume this buy lot
            lowestBuy.quantity -= remainingSellQty
            totalBought -= remainingSellQty
            totalBuyCost -= remainingSellQty * lowestBuy.price
            remainingSellQty = 0
          }
        } else {
          // When selling at or above average, remove proportionally from all lots (use FIFO for simplicity)
          const oldestBuy = buyQueue[0]

          if (oldestBuy.quantity <= remainingSellQty) {
            // Fully consume this buy lot
            totalBought -= oldestBuy.quantity
            totalBuyCost -= oldestBuy.quantity * oldestBuy.price
            remainingSellQty -= oldestBuy.quantity
            buyQueue.shift()
          } else {
            // Partially consume this buy lot
            oldestBuy.quantity -= remainingSellQty
            totalBought -= remainingSellQty
            totalBuyCost -= remainingSellQty * oldestBuy.price
            remainingSellQty = 0
          }
        }
      }
    }
  })

  // Unrealized P&L: current value vs cost basis of remaining position
  let unrealizedPnL = 0
  let avgCostBasis = 0

  if (position > 0 && totalBought > 0) {
    avgCostBasis = totalBuyCost / totalBought
    unrealizedPnL = (currentPrice - avgCostBasis) * position
  }

  // Calculate percentage return: Total P&L / cost basis
  const costBasis = totalBought > 0 ? totalBuyCost : 0
  const percentageReturn = costBasis > 0 ? ((realizedPnL + unrealizedPnL) / costBasis) * 100 : 0

  // Find lowest buy price among remaining open lots
  let lowestOpenBuyPrice = 0
  if (buyQueue.length > 0) {
    lowestOpenBuyPrice = Math.min(...buyQueue.map(buy => buy.price))
  }

  return {
    realizedPnL: roundToTwo(realizedPnL),
    unrealizedPnL: roundToTwo(unrealizedPnL),
    totalPnL: roundToTwo(realizedPnL + unrealizedPnL),
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
