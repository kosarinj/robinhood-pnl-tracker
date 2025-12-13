// Calculate Exponential Moving Average (EMA)
export const calculateEMA = (data, period) => {
  const k = 2 / (period + 1)
  const emaData = []

  // Start with SMA for the first value
  let ema = data.slice(0, period).reduce((sum, val) => sum + val.close, 0) / period
  emaData.push({ ...data[period - 1], ema })

  // Calculate EMA for remaining values
  for (let i = period; i < data.length; i++) {
    ema = (data[i].close * k) + (ema * (1 - k))
    emaData.push({ ...data[i], ema })
  }

  return emaData
}

// Calculate Relative Strength Index (RSI)
export const calculateRSI = (data, period = 14) => {
  const rsiData = []

  for (let i = period; i < data.length; i++) {
    let gains = 0
    let losses = 0

    // Calculate average gains and losses over the period
    for (let j = i - period; j < i; j++) {
      const change = data[j + 1].close - data[j].close
      if (change > 0) {
        gains += change
      } else {
        losses += Math.abs(change)
      }
    }

    const avgGain = gains / period
    const avgLoss = losses / period

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    const rsi = 100 - (100 / (1 + rs))

    rsiData.push({ ...data[i], rsi })
  }

  return rsiData
}

// Calculate Moving Average Convergence Divergence (MACD)
export const calculateMACD = (data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
  // Calculate fast and slow EMAs
  const fastEMA = []
  const slowEMA = []

  // Fast EMA
  let fastK = 2 / (fastPeriod + 1)
  let fastEma = data.slice(0, fastPeriod).reduce((sum, val) => sum + val.close, 0) / fastPeriod
  fastEMA.push(fastEma)

  for (let i = fastPeriod; i < data.length; i++) {
    fastEma = (data[i].close * fastK) + (fastEma * (1 - fastK))
    fastEMA.push(fastEma)
  }

  // Slow EMA
  let slowK = 2 / (slowPeriod + 1)
  let slowEma = data.slice(0, slowPeriod).reduce((sum, val) => sum + val.close, 0) / slowPeriod
  slowEMA.push(slowEma)

  for (let i = slowPeriod; i < data.length; i++) {
    slowEma = (data[i].close * slowK) + (slowEma * (1 - slowK))
    slowEMA.push(slowEma)
  }

  // Calculate MACD line (fast EMA - slow EMA)
  const macdLine = []
  for (let i = slowPeriod - 1; i < data.length; i++) {
    const macd = fastEMA[i - (slowPeriod - fastPeriod)] - slowEMA[i - (slowPeriod - 1)]
    macdLine.push(macd)
  }

  // Calculate Signal line (EMA of MACD)
  let signalK = 2 / (signalPeriod + 1)
  let signal = macdLine.slice(0, signalPeriod).reduce((sum, val) => sum + val, 0) / signalPeriod
  const signalLine = [signal]

  for (let i = signalPeriod; i < macdLine.length; i++) {
    signal = (macdLine[i] * signalK) + (signal * (1 - signalK))
    signalLine.push(signal)
  }

  // Calculate histogram (MACD - Signal)
  const macdData = []
  for (let i = signalPeriod - 1; i < macdLine.length; i++) {
    const histogram = macdLine[i] - signalLine[i - (signalPeriod - 1)]
    macdData.push({
      ...data[i + slowPeriod - 1],
      macd: macdLine[i],
      signal: signalLine[i - (signalPeriod - 1)],
      histogram
    })
  }

  return macdData
}

// Merge all indicators into the price data
export const addIndicators = (priceData, options = {}) => {
  const {
    showEMA9 = false,
    showEMA21 = false,
    showRSI = false,
    showMACD = false
  } = options

  let result = [...priceData]

  if (showEMA9) {
    const ema9 = calculateEMA(priceData, 9)
    result = result.map((item, i) => ({
      ...item,
      ema9: ema9[i - (priceData.length - ema9.length)]?.ema
    }))
  }

  if (showEMA21) {
    const ema21 = calculateEMA(priceData, 21)
    result = result.map((item, i) => ({
      ...item,
      ema21: ema21[i - (priceData.length - ema21.length)]?.ema
    }))
  }

  if (showRSI) {
    const rsi = calculateRSI(priceData, 14)
    result = result.map((item, i) => ({
      ...item,
      rsi: rsi[i - (priceData.length - rsi.length)]?.rsi
    }))
  }

  if (showMACD) {
    const macd = calculateMACD(priceData)
    result = result.map((item, i) => ({
      ...item,
      macd: macd[i - (priceData.length - macd.length)]?.macd,
      macdSignal: macd[i - (priceData.length - macd.length)]?.signal,
      macdHistogram: macd[i - (priceData.length - macd.length)]?.histogram
    }))
  }

  return result
}
