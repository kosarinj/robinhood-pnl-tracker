// Technical Analysis Utilities

// Calculate EMA (Exponential Moving Average)
export const calculateEMA = (prices, period) => {
  if (prices.length < period) return null

  const multiplier = 2 / (period + 1)
  let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period

  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema
  }

  return ema
}

// Calculate RSI (Relative Strength Index)
export const calculateRSI = (prices, period = 14) => {
  if (prices.length < period + 1) return null

  let gains = 0
  let losses = 0

  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1]
    if (change > 0) gains += change
    else losses -= change
  }

  let avgGain = gains / period
  let avgLoss = losses / period

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1]
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period
      avgLoss = (avgLoss * (period - 1)) / period
    } else {
      avgGain = (avgGain * (period - 1)) / period
      avgLoss = (avgLoss * (period - 1) - change) / period
    }
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

// Calculate MACD (Moving Average Convergence Divergence)
export const calculateMACD = (prices) => {
  const ema12 = calculateEMA(prices, 12)
  const ema26 = calculateEMA(prices, 26)

  if (!ema12 || !ema26) return null

  const macdLine = ema12 - ema26

  // For signal line, we'd need to calculate EMA of MACD values
  // Simplified version here
  return {
    macd: macdLine,
    signal: macdLine * 0.9, // Simplified
    histogram: macdLine * 0.1
  }
}

// Generate trading signal based on multiple indicators
export const generateSignal = (symbol, currentPrice, historicalPrices) => {
  if (!historicalPrices || historicalPrices.length < 30) {
    return {
      symbol,
      signal: 'HOLD',
      strength: 0,
      reasons: ['Insufficient data for analysis'],
      indicators: {}
    }
  }

  const prices = historicalPrices.map(p => p.close)

  // Calculate indicators
  const ema9 = calculateEMA(prices, 9)
  const ema21 = calculateEMA(prices, 21)
  const rsi = calculateRSI(prices, 14)
  const macd = calculateMACD(prices)

  // Previous values for crossover detection
  const prevPrices = prices.slice(0, -1)
  const prevEma9 = calculateEMA(prevPrices, 9)
  const prevEma21 = calculateEMA(prevPrices, 21)

  const indicators = {
    ema9: ema9?.toFixed(2),
    ema21: ema21?.toFixed(2),
    rsi: rsi?.toFixed(2),
    macd: macd?.macd.toFixed(2)
  }

  // Signal generation logic
  let signal = 'HOLD'
  let strength = 0
  const reasons = []

  // EMA Crossover
  if (ema9 && ema21 && prevEma9 && prevEma21) {
    if (prevEma9 <= prevEma21 && ema9 > ema21) {
      reasons.push('🔵 EMA 9 crossed above EMA 21 (Bullish)')
      strength += 3
      signal = 'BUY'
    } else if (prevEma9 >= prevEma21 && ema9 < ema21) {
      reasons.push('🔴 EMA 9 crossed below EMA 21 (Bearish)')
      strength -= 3
      signal = 'SELL'
    } else if (ema9 > ema21) {
      reasons.push('EMA 9 above EMA 21 (Bullish trend)')
      strength += 1
    } else {
      reasons.push('EMA 9 below EMA 21 (Bearish trend)')
      strength -= 1
    }
  }

  // RSI Analysis
  if (rsi) {
    if (rsi < 30) {
      reasons.push(`RSI ${rsi.toFixed(0)} - Oversold (Buy opportunity)`)
      strength += 2
      if (signal !== 'SELL') signal = 'BUY'
    } else if (rsi > 70) {
      reasons.push(`RSI ${rsi.toFixed(0)} - Overbought (Sell opportunity)`)
      strength -= 2
      if (signal !== 'BUY') signal = 'SELL'
    } else if (rsi >= 50 && rsi <= 70) {
      reasons.push(`RSI ${rsi.toFixed(0)} - Bullish momentum`)
      strength += 1
    } else if (rsi < 50 && rsi >= 30) {
      reasons.push(`RSI ${rsi.toFixed(0)} - Bearish momentum`)
      strength -= 1
    }
  }

  // MACD Analysis
  if (macd) {
    if (macd.histogram > 0) {
      reasons.push('MACD Histogram positive (Bullish)')
      strength += 1
    } else {
      reasons.push('MACD Histogram negative (Bearish)')
      strength -= 1
    }
  }

  // Price vs EMAs
  if (ema21 && currentPrice > ema21) {
    reasons.push('Price above EMA 21 (Support)')
    strength += 1
  } else if (ema21 && currentPrice < ema21) {
    reasons.push('Price below EMA 21 (Resistance)')
    strength -= 1
  }

  // Determine final signal based on strength
  if (strength >= 3) {
    signal = 'BUY'
  } else if (strength <= -3) {
    signal = 'SELL'
  } else {
    signal = 'HOLD'
  }

  // Determine strength label
  let strengthLabel = 'Neutral'
  const absStrength = Math.abs(strength)
  if (absStrength >= 5) strengthLabel = 'Very Strong'
  else if (absStrength >= 3) strengthLabel = 'Strong'
  else if (absStrength >= 1) strengthLabel = 'Weak'

  return {
    symbol,
    signal,
    strength: absStrength,
    strengthLabel,
    reasons,
    indicators,
    timestamp: new Date()
  }
}
