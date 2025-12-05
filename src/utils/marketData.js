import axios from 'axios'

// Using Alpha Vantage Premium API
const ALPHA_VANTAGE_KEY = 'AP5SJ1ZWGMM96NVB'

// Cache to avoid repeated API calls
const dataCache = {}
const CACHE_DURATION = 60000 // 1 minute

export const getIntradayData = async (symbol) => {
  // Check cache first
  const now = Date.now()
  if (dataCache[symbol] && (now - dataCache[symbol].timestamp) < CACHE_DURATION) {
    return dataCache[symbol].data
  }

  try {
    // Get intraday data (5min intervals for better granularity)
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${symbol}&interval=5min&apikey=${ALPHA_VANTAGE_KEY}`

    const response = await axios.get(url, { timeout: 10000 })

    // Log full response for debugging
    console.log(`Response for ${symbol}:`, JSON.stringify(response.data).substring(0, 200))

    if (response.data['Error Message']) {
      console.error(`Alpha Vantage error for ${symbol}:`, response.data['Error Message'])
      return null
    }

    if (response.data['Note']) {
      // API limit reached
      console.warn('Alpha Vantage API limit reached:', response.data['Note'])
      return null
    }

    if (response.data['Information']) {
      console.warn('Alpha Vantage message:', response.data['Information'])
      return null
    }

    const timeSeries = response.data['Time Series (5min)']
    if (!timeSeries) {
      console.warn(`No time series data for ${symbol}. Full response keys:`, Object.keys(response.data))
      return null
    }

    // Convert to array format
    const data = Object.entries(timeSeries)
      .map(([timestamp, values]) => ({
        timestamp: new Date(timestamp),
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseInt(values['5. volume'])
      }))
      .sort((a, b) => a.timestamp - b.timestamp)

    // Cache the result
    dataCache[symbol] = {
      data,
      timestamp: now
    }

    return data
  } catch (error) {
    console.error(`Error fetching intraday data for ${symbol}:`, error.message)
    return null
  }
}

// Batch fetch with rate limiting
export const batchGetIntradayData = async (symbols) => {
  const results = {}
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  for (const symbol of symbols) {
    results[symbol] = await getIntradayData(symbol)
    // Rate limit: wait 12 seconds between calls (5 calls/min = 1 call/12sec)
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await delay(12000)
    }
  }

  return results
}
