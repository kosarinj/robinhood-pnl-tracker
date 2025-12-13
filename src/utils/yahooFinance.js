import axios from 'axios'

// Use CORS proxy to avoid CORS issues in browser
// Try multiple proxies for reliability
const CORS_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',
  'https://cors-anywhere.herokuapp.com/'
]
const YAHOO_FINANCE_API = 'https://query1.finance.yahoo.com/v8/finance/chart'

// Helper to add delay between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Try multiple CORS proxies
const fetchWithProxy = async (yahooUrl, timeout = 10000) => {
  let lastError = null

  for (const proxy of CORS_PROXIES) {
    try {
      const url = `${proxy}${encodeURIComponent(yahooUrl)}`
      console.log(`Trying proxy: ${proxy}`)
      const response = await axios.get(url, { timeout })

      // For allorigins, the response might be wrapped
      const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      return data
    } catch (error) {
      console.warn(`Proxy ${proxy} failed:`, error.message)
      lastError = error
      continue
    }
  }

  throw lastError || new Error('All CORS proxies failed')
}

const fetchPriceForSymbol = async (symbol, retryCount = 0) => {
  try {
    // Add cache-busting timestamp to force fresh data
    const timestamp = Date.now()
    const yahooUrl = `${YAHOO_FINANCE_API}/${symbol}?timestamp=${timestamp}`
    const data = await fetchWithProxy(yahooUrl)

    if (data?.chart?.result?.[0]?.meta) {
      const meta = data.chart.result[0].meta
      // Try to get the most recent price - prefer regularMarketPrice, fallback to previousClose
      const quote = meta.regularMarketPrice || meta.previousClose || 0
      const prevClose = meta.previousClose || 0

      // Log the timestamp to see how fresh the data is
      const marketTime = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toLocaleTimeString() : 'unknown'
      console.log(`✓ Fetched price for ${symbol}: $${quote} (prev close: $${prevClose}, market time: ${marketTime})`)
      return { current: quote, previousClose: prevClose }
    } else {
      console.warn(`⚠ No price data in response for ${symbol}`)
      return { current: 0, previousClose: 0 }
    }
  } catch (error) {
    if (retryCount < 1) {
      console.log(`⟳ Retrying ${symbol} (attempt ${retryCount + 1})...`)
      await delay(500)
      return fetchPriceForSymbol(symbol, retryCount + 1)
    }
    console.error(`✗ Failed to fetch price for ${symbol}:`, error.response?.status, error.message)
    return { current: 0, previousClose: 0 }
  }
}

export const fetchCurrentPrices = async (symbols) => {
  const prices = {}
  const previousClosePrices = {}

  console.log(`Fetching prices for ${symbols.length} symbols...`)

  // Fetch all prices in parallel for speed
  const promises = symbols.map(async (symbol) => {
    const priceData = await fetchPriceForSymbol(symbol)
    prices[symbol] = priceData.current
    previousClosePrices[symbol] = priceData.previousClose
  })

  await Promise.all(promises)

  const successCount = Object.values(prices).filter(p => p > 0).length
  console.log(`Successfully fetched ${successCount}/${symbols.length} prices`)

  return { currentPrices: prices, previousClosePrices }
}

export const fetchQuote = async (symbol) => {
  try {
    // Add cache-busting timestamp to force fresh data
    const timestamp = Date.now()
    const yahooUrl = `${YAHOO_FINANCE_API}/${symbol}?timestamp=${timestamp}`
    const data = await fetchWithProxy(yahooUrl)

    const result = data.chart.result[0]
    return {
      symbol,
      price: result.meta.regularMarketPrice,
      previousClose: result.meta.previousClose,
      change: result.meta.regularMarketPrice - result.meta.previousClose,
      changePercent: ((result.meta.regularMarketPrice - result.meta.previousClose) / result.meta.previousClose) * 100
    }
  } catch (error) {
    console.error(`Error fetching quote for ${symbol}:`, error)
    return {
      symbol,
      price: 0,
      previousClose: 0,
      change: 0,
      changePercent: 0
    }
  }
}

// Fetch historical price data for charting
export const fetchHistoricalPrices = async (symbol, range = '6mo', interval = '1d') => {
  try {
    console.log(`Fetching historical data for ${symbol} (${range}, ${interval})`)
    const timestamp = Date.now()
    const yahooUrl = `${YAHOO_FINANCE_API}/${symbol}?range=${range}&interval=${interval}&timestamp=${timestamp}`
    const data = await fetchWithProxy(yahooUrl, 15000)

    const result = data.chart.result[0]
    const timestamps = result.timestamp || []
    const quotes = result.indicators.quote[0]

    const historicalData = timestamps.map((ts, i) => ({
      timestamp: ts * 1000, // Convert to milliseconds
      date: new Date(ts * 1000),
      open: quotes.open[i],
      high: quotes.high[i],
      low: quotes.low[i],
      close: quotes.close[i],
      volume: quotes.volume[i]
    })).filter(item => item.close !== null) // Filter out null values

    console.log(`✓ Fetched ${historicalData.length} historical data points for ${symbol}`)
    return historicalData
  } catch (error) {
    console.error(`✗ Failed to fetch historical data for ${symbol}:`, error.message)
    return []
  }
}
