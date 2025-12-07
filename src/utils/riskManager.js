// Risk Management Utility
// Manages position risk allocation and provides recommendations

/**
 * Calculate current risk exposure for a position
 * Risk = position size * (entry price - stop loss price)
 * For simplicity, we'll use unrealized P&L as a proxy for risk exposure
 */
export const calculateRiskExposure = (position) => {
  const {
    currentPrice,
    real: { position: shares, avgCostBasis, unrealizedPnL }
  } = position

  // Current market value of position
  const marketValue = currentPrice * shares

  // Risk is the potential downside from current position
  // We'll use unrealized P&L magnitude + position value as risk metric
  const downside = avgCostBasis * shares // Total invested
  const currentExposure = Math.abs(downside)

  return {
    marketValue,
    costBasis: downside,
    currentExposure,
    unrealizedPnL
  }
}

/**
 * Calculate portfolio-wide risk metrics
 */
export const calculatePortfolioRisk = (positions, riskAllocations, totalRiskBudget) => {
  let totalRiskAllocated = 0
  let totalRiskUsed = 0
  let totalMarketValue = 0

  positions.forEach(position => {
    const allocation = riskAllocations[position.symbol] || 0
    const exposure = calculateRiskExposure(position)

    totalRiskAllocated += allocation
    totalRiskUsed += exposure.currentExposure
    totalMarketValue += exposure.marketValue
  })

  const availableRisk = totalRiskBudget - totalRiskAllocated
  const riskUtilization = totalRiskBudget > 0 ? (totalRiskUsed / totalRiskBudget) * 100 : 0

  return {
    totalRiskBudget,
    totalRiskAllocated,
    totalRiskUsed,
    availableRisk,
    riskUtilization,
    totalMarketValue
  }
}

/**
 * Generate risk recommendations based on position performance and signals
 */
export const generateRiskRecommendations = (position, allocation, signal, trades) => {
  const recommendations = []
  const { symbol, real, currentPrice } = position
  const { realizedPnL, unrealizedPnL, totalPnL, percentageReturn, position: shares } = real

  // Get trade history for this symbol
  const symbolTrades = trades.filter(t => t.symbol === symbol)
  const buyTrades = symbolTrades.filter(t => t.isBuy)
  const sellTrades = symbolTrades.filter(t => !t.isBuy)

  // Calculate win rate
  let wins = 0
  let losses = 0
  sellTrades.forEach(sell => {
    // Simple heuristic: if we sold at higher than average buy price, it's a win
    const avgBuyPrice = buyTrades.reduce((sum, b) => sum + b.price, 0) / (buyTrades.length || 1)
    if (sell.price > avgBuyPrice) wins++
    else losses++
  })
  const winRate = sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0

  // Risk level assessment
  let riskLevel = 'MODERATE'
  let riskScore = 0

  // 1. Signal-based recommendation
  if (signal) {
    if (signal.signal === 'BUY' && signal.strength >= 5) {
      recommendations.push({
        type: 'INCREASE',
        reason: `Strong BUY signal (${signal.strength}/7) detected`,
        suggestedChange: allocation * 0.2, // Suggest 20% increase
        priority: 'HIGH'
      })
      riskScore += 2
    } else if (signal.signal === 'SELL' && signal.strength >= 5) {
      recommendations.push({
        type: 'DECREASE',
        reason: `Strong SELL signal (${signal.strength}/7) detected`,
        suggestedChange: -allocation * 0.3, // Suggest 30% decrease
        priority: 'HIGH'
      })
      riskScore -= 3
    }
  }

  // 2. Performance-based recommendation
  if (percentageReturn > 20) {
    recommendations.push({
      type: 'INCREASE',
      reason: `Strong performance (+${percentageReturn.toFixed(1)}%)`,
      suggestedChange: allocation * 0.15,
      priority: 'MEDIUM'
    })
    riskScore += 1
  } else if (percentageReturn < -15) {
    recommendations.push({
      type: 'DECREASE',
      reason: `Poor performance (${percentageReturn.toFixed(1)}%)`,
      suggestedChange: -allocation * 0.25,
      priority: 'HIGH'
    })
    riskScore -= 2
  }

  // 3. Win rate recommendation
  if (sellTrades.length >= 3) {
    if (winRate >= 70) {
      recommendations.push({
        type: 'INCREASE',
        reason: `High win rate (${winRate.toFixed(0)}% over ${sellTrades.length} trades)`,
        suggestedChange: allocation * 0.1,
        priority: 'MEDIUM'
      })
      riskScore += 1
    } else if (winRate <= 40) {
      recommendations.push({
        type: 'DECREASE',
        reason: `Low win rate (${winRate.toFixed(0)}% over ${sellTrades.length} trades)`,
        suggestedChange: -allocation * 0.2,
        priority: 'MEDIUM'
      })
      riskScore -= 1
    }
  }

  // 4. Unrealized loss recommendation
  if (unrealizedPnL < 0 && Math.abs(unrealizedPnL) > allocation * 0.5) {
    recommendations.push({
      type: 'DECREASE',
      reason: `Unrealized loss exceeds 50% of risk allocation`,
      suggestedChange: -allocation * 0.3,
      priority: 'HIGH'
    })
    riskScore -= 2
  }

  // 5. Position concentration
  const exposure = calculateRiskExposure(position)
  if (exposure.marketValue > allocation * 3) {
    recommendations.push({
      type: 'REBALANCE',
      reason: `Position size (${formatCurrency(exposure.marketValue)}) significantly exceeds risk allocation (${formatCurrency(allocation)})`,
      suggestedChange: 0,
      priority: 'MEDIUM'
    })
  }

  // Determine overall risk level
  if (riskScore >= 3) riskLevel = 'AGGRESSIVE'
  else if (riskScore <= -2) riskLevel = 'CONSERVATIVE'

  return {
    recommendations,
    riskLevel,
    riskScore,
    metrics: {
      winRate: winRate.toFixed(1),
      totalTrades: sellTrades.length,
      wins,
      losses,
      percentageReturn: percentageReturn.toFixed(2)
    }
  }
}

/**
 * Format currency for display
 */
const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(value)
}

/**
 * Calculate suggested risk allocation for a new position
 * Based on Kelly Criterion simplified formula
 */
export const suggestRiskAllocation = (totalBudget, winRate, avgWin, avgLoss) => {
  // Kelly % = (Win Rate * Avg Win - (1 - Win Rate) * Avg Loss) / Avg Win
  // Simplified for conservative allocation
  const kellyPercent = ((winRate / 100) - ((1 - winRate / 100) * (avgLoss / avgWin))) * 100

  // Use half-Kelly for conservative approach
  const suggestedPercent = Math.max(1, Math.min(kellyPercent / 2, 10)) // Cap at 10% of budget

  return (totalBudget * suggestedPercent) / 100
}
