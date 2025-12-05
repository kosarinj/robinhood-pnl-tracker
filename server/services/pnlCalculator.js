// Calculate P&L using Average Cost, FIFO, and LIFO methods
export const calculatePnL = (trades, currentPrices) => {
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
      lifo
    })
  })

  return results
}

// Real P&L calculation - simple buy/sell matching
const calculateReal = (trades, currentPrice) => {
  const buyQueue = []
  let totalBought = 0
  let totalBuyCost = 0
  let totalSold = 0
  let totalSellRevenue = 0
  let position = 0

  trades.forEach((trade) => {
    if (trade.isBuy) {
      totalBought += trade.quantity
      totalBuyCost += trade.quantity * trade.price
      position += trade.quantity
      // Track individual buy lots for lowest price calculation
      buyQueue.push({
        quantity: trade.quantity,
        price: trade.price
      })
    } else {
      totalSold += trade.quantity
      totalSellRevenue += trade.quantity * trade.price
      position -= trade.quantity

      // Match sells against buys (FIFO) to track remaining lots
      let remainingSellQty = trade.quantity
      while (remainingSellQty > 0 && buyQueue.length > 0) {
        const oldestBuy = buyQueue[0]

        if (oldestBuy.quantity <= remainingSellQty) {
          // Fully consume this buy lot
          remainingSellQty -= oldestBuy.quantity
          buyQueue.shift()
        } else {
          // Partially consume this buy lot
          oldestBuy.quantity -= remainingSellQty
          remainingSellQty = 0
        }
      }
    }
  })

  // Realized P&L: actual profit/loss from completed sells
  const realizedPnL = totalSellRevenue - (totalSold * (totalBuyCost / totalBought))

  // Unrealized P&L: current value vs cost basis of remaining position
  let unrealizedPnL = 0
  let avgCostBasis = 0

  if (position > 0 && totalBought > 0) {
    avgCostBasis = totalBuyCost / totalBought
    unrealizedPnL = (currentPrice - avgCostBasis) * position
  }

  // Calculate percentage return: Total P&L / (shares × avg cost basis)
  const costBasis = position > 0 ? position * avgCostBasis : totalBuyCost
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

  if (buyQueue.length > 0) {
    const totalCost = buyQueue.reduce((sum, buy) => sum + (buy.price * buy.quantity), 0)
    const totalQty = buyQueue.reduce((sum, buy) => sum + buy.quantity, 0)
    avgCostBasis = totalCost / totalQty
    unrealizedPnL = (currentPrice - avgCostBasis) * totalQty
  }

  return {
    realizedPnL: roundToTwo(realizedPnL),
    unrealizedPnL: roundToTwo(unrealizedPnL),
    totalPnL: roundToTwo(realizedPnL + unrealizedPnL),
    position: roundToTwo(buyQueue.reduce((sum, buy) => sum + buy.quantity, 0)),
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

  if (buyStack.length > 0) {
    const totalCost = buyStack.reduce((sum, buy) => sum + (buy.price * buy.quantity), 0)
    const totalQty = buyStack.reduce((sum, buy) => sum + buy.quantity, 0)
    avgCostBasis = totalCost / totalQty
    unrealizedPnL = (currentPrice - avgCostBasis) * totalQty
  }

  return {
    realizedPnL: roundToTwo(realizedPnL),
    unrealizedPnL: roundToTwo(unrealizedPnL),
    totalPnL: roundToTwo(realizedPnL + unrealizedPnL),
    position: roundToTwo(buyStack.reduce((sum, buy) => sum + buy.quantity, 0)),
    avgCostBasis: roundToTwo(avgCostBasis)
  }
}

// Helper function to round to 2 decimal places
const roundToTwo = (num) => {
  return Math.round((num + Number.EPSILON) * 100) / 100
}
