import { format, isWithinInterval, differenceInDays } from 'date-fns'

/**
 * Identify market downturns from historical data
 * @param {Array} marketData - Array of {date, close} objects
 * @param {number} thresholdMild - Mild downturn threshold (default -3%)
 * @param {number} thresholdModerate - Moderate downturn threshold (default -5%)
 * @param {number} thresholdSevere - Severe downturn threshold (default -10%)
 * @returns {Array} Array of downturn periods
 */
export function identifyDownturns(marketData, thresholdMild = -3, thresholdModerate = -5, thresholdSevere = -10) {
  if (!marketData || marketData.length < 2) {
    return []
  }

  const downturns = []
  let previousHigh = marketData[0].close
  let highDate = marketData[0].date
  let inDownturn = false
  let downturnStart = null
  let downturnLow = null
  let downturnLowDate = null

  for (let i = 1; i < marketData.length; i++) {
    const current = marketData[i]

    // Track new highs
    if (current.close > previousHigh) {
      previousHigh = current.close
      highDate = current.date

      // If we were in a downturn and recovered, end it
      if (inDownturn) {
        const change = ((downturnLow - previousHigh) / previousHigh) * 100
        const severity = categorizeSeverity(change, thresholdMild, thresholdModerate, thresholdSevere)

        downturns.push({
          startDate: downturnStart,
          endDate: current.date,
          lowDate: downturnLowDate,
          peakValue: previousHigh,
          lowValue: downturnLow,
          recoveryValue: current.close,
          change: change,
          severity: severity,
          duration: differenceInDays(current.date, downturnStart)
        })

        inDownturn = false
        downturnStart = null
        downturnLow = null
        downturnLowDate = null
      }
    }

    // Check for downturn
    const change = ((current.close - previousHigh) / previousHigh) * 100

    if (change <= thresholdMild && !inDownturn) {
      // Start tracking a new downturn
      inDownturn = true
      downturnStart = highDate
      downturnLow = current.close
      downturnLowDate = current.date
    } else if (inDownturn && current.close < downturnLow) {
      // Update the low point of the downturn
      downturnLow = current.close
      downturnLowDate = current.date
    }
  }

  // Handle case where we end in a downturn
  if (inDownturn && downturnLow) {
    const change = ((downturnLow - previousHigh) / previousHigh) * 100
    const severity = categorizeSeverity(change, thresholdMild, thresholdModerate, thresholdSevere)

    downturns.push({
      startDate: downturnStart,
      endDate: marketData[marketData.length - 1].date,
      lowDate: downturnLowDate,
      peakValue: previousHigh,
      lowValue: downturnLow,
      recoveryValue: null, // Still in downturn
      change: change,
      severity: severity,
      duration: differenceInDays(marketData[marketData.length - 1].date, downturnStart),
      ongoing: true
    })
  }

  return downturns
}

/**
 * Categorize downturn severity
 */
function categorizeSeverity(change, mild, moderate, severe) {
  if (change <= severe) return 'severe'
  if (change <= moderate) return 'moderate'
  if (change <= mild) return 'mild'
  return 'none'
}

/**
 * Correlate user trades with market downturns
 * @param {Array} trades - User's trades
 * @param {Array} downturns - Identified downturns
 * @returns {Array} Downturns with trade analysis
 */
export function analyzeTradeOpportunities(trades, downturns) {
  return downturns.map(downturn => {
    // Find trades during this downturn period
    const tradesInPeriod = trades.filter(trade => {
      const tradeDate = new Date(trade.date)
      return isWithinInterval(tradeDate, {
        start: downturn.startDate,
        end: downturn.endDate
      })
    })

    const buyTrades = tradesInPeriod.filter(t => t.isBuy || t.type === 'BUY')
    const sellTrades = tradesInPeriod.filter(t => !t.isBuy || t.type === 'SELL')

    // Calculate total shares bought
    const totalSharesBought = buyTrades.reduce((sum, t) => sum + (t.quantity || 0), 0)
    const avgSharesBought = buyTrades.length > 0 ? totalSharesBought / buyTrades.length : 0

    // Suggest more aggressive buying during downturns
    const multiplier = getSuggestedMultiplier(downturn.severity)
    const suggestedShares = Math.round(avgSharesBought * multiplier)
    const additionalShares = Math.max(0, suggestedShares - avgSharesBought)

    // Calculate missed opportunity (rough estimate)
    const avgPrice = buyTrades.reduce((sum, t) => sum + (t.price || 0), 0) / (buyTrades.length || 1)
    const potentialGain = downturn.recoveryValue
      ? (downturn.recoveryValue - avgPrice) * additionalShares
      : 0

    // Determine if user timed it well
    const timing = evaluateTiming(buyTrades, sellTrades, downturn)

    // Break down by symbol
    const symbolBreakdown = analyzeBySymbol(tradesInPeriod, downturn)

    return {
      ...downturn,
      userTrades: tradesInPeriod,
      buyTrades,
      sellTrades,
      analysis: {
        totalTrades: tradesInPeriod.length,
        buyCount: buyTrades.length,
        sellCount: sellTrades.length,
        totalSharesBought,
        avgSharesBought,
        suggestedShares,
        additionalShares,
        missedOpportunity: potentialGain,
        timing,
        avgPurchasePrice: avgPrice,
        symbolBreakdown
      }
    }
  })
}

/**
 * Analyze trades by symbol during a downturn
 */
function analyzeBySymbol(trades, downturn) {
  const symbolMap = {}

  trades.forEach(trade => {
    if (!symbolMap[trade.symbol]) {
      symbolMap[trade.symbol] = {
        symbol: trade.symbol,
        buyTrades: [],
        sellTrades: [],
        totalBought: 0,
        totalSold: 0,
        sharesBought: 0,
        sharesSold: 0
      }
    }

    const isBuy = trade.isBuy || trade.type === 'BUY'
    if (isBuy) {
      symbolMap[trade.symbol].buyTrades.push(trade)
      symbolMap[trade.symbol].totalBought += trade.quantity * trade.price
      symbolMap[trade.symbol].sharesBought += trade.quantity
    } else {
      symbolMap[trade.symbol].sellTrades.push(trade)
      symbolMap[trade.symbol].totalSold += trade.quantity * trade.price
      symbolMap[trade.symbol].sharesSold += trade.quantity
    }
  })

  // Convert to array and add metrics
  return Object.values(symbolMap).map(symbolData => {
    const buyCount = symbolData.buyTrades.length
    const sellCount = symbolData.sellTrades.length
    const avgBuyPrice = buyCount > 0 ? symbolData.totalBought / symbolData.sharesBought : 0
    const timing = evaluateTiming(symbolData.buyTrades, symbolData.sellTrades, downturn)

    return {
      ...symbolData,
      buyCount,
      sellCount,
      avgBuyPrice,
      netShares: symbolData.sharesBought - symbolData.sharesSold,
      timing
    }
  }).sort((a, b) => b.sharesBought - a.sharesBought) // Sort by most shares bought
}

/**
 * Get suggested position size multiplier based on downturn severity
 */
function getSuggestedMultiplier(severity) {
  switch (severity) {
    case 'severe':
      return 2.0 // Double position size
    case 'moderate':
      return 1.5 // 50% more
    case 'mild':
      return 1.25 // 25% more
    default:
      return 1.0
  }
}

/**
 * Evaluate how well the user timed their trades
 */
function evaluateTiming(buyTrades, sellTrades, downturn) {
  if (buyTrades.length === 0 && sellTrades.length === 0) {
    return {
      score: 0,
      label: 'No Activity',
      description: 'No trades during this downturn period',
      color: '#6c757d'
    }
  }

  // Good timing: buying during downturn, not selling
  if (buyTrades.length > 0 && sellTrades.length === 0) {
    return {
      score: 8,
      label: 'Excellent',
      description: 'Bought during the dip without selling - great timing!',
      color: '#28a745'
    }
  }

  // Okay timing: mixed activity
  if (buyTrades.length > sellTrades.length) {
    return {
      score: 6,
      label: 'Good',
      description: 'More buying than selling during the downturn',
      color: '#17a2b8'
    }
  }

  // Poor timing: more selling than buying
  if (sellTrades.length > buyTrades.length) {
    return {
      score: 3,
      label: 'Poor',
      description: 'Sold more than bought during the downturn',
      color: '#dc3545'
    }
  }

  // Equal buy/sell
  return {
    score: 5,
    label: 'Neutral',
    description: 'Equal buying and selling activity',
    color: '#ffc107'
  }
}

/**
 * Calculate overall market timing score
 * @param {Array} analyzedDownturns - Downturns with analysis
 * @returns {Object} Overall score and breakdown
 */
export function calculateOverallScore(analyzedDownturns) {
  if (analyzedDownturns.length === 0) {
    return {
      score: 0,
      label: 'Insufficient Data',
      totalOpportunities: 0,
      capitalizedOpportunities: 0
    }
  }

  const scores = analyzedDownturns.map(d => d.analysis.timing.score)
  const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length

  const capitalizedOpportunities = analyzedDownturns.filter(
    d => d.analysis.buyCount > 0
  ).length

  let label
  if (avgScore >= 7) label = 'Excellent'
  else if (avgScore >= 5) label = 'Good'
  else if (avgScore >= 3) label = 'Fair'
  else label = 'Needs Improvement'

  return {
    score: avgScore.toFixed(1),
    label,
    totalOpportunities: analyzedDownturns.length,
    capitalizedOpportunities,
    missedOpportunities: analyzedDownturns.length - capitalizedOpportunities
  }
}

/**
 * Format currency for display
 */
export function formatCurrency(value) {
  if (value === null || value === undefined) return '$0.00'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

/**
 * Format percentage for display
 */
export function formatPercentage(value) {
  if (value === null || value === undefined) return '0.0%'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}
