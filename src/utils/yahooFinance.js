import axios from 'axios'

// Use CORS proxy to avoid CORS issues in browser
const CORS_PROXY = 'https://corsproxy.io/?'
const YAHOO_FINANCE_API = 'https://query1.finance.yahoo.com/v8/finance/chart'

// Helper to add delay between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const fetchPriceForSymbol = async (symbol, retryCount = 0) => {
  try {
    const url = `${CORS_PROXY}${encodeURIComponent(YAHOO_FINANCE_API + '/' + symbol)}`
    const response = await axios.get(url, { timeout: 10000 })

    if (response.data?.chart?.result?.[0]?.meta?.regularMarketPrice) {
      const quote = response.data.chart.result[0].meta.regularMarketPrice
      console.log(`✓ Fetched price for ${symbol}: $${quote}`)
      return quote
    } else {
      console.warn(`⚠ No price data in response for ${symbol}`)
      return 0
    }
  } catch (error) {
    if (retryCount < 1) {
      console.log(`⟳ Retrying ${symbol} (attempt ${retryCount + 1})...`)
      await delay(500)
      return fetchPriceForSymbol(symbol, retryCount + 1)
    }
    console.error(`✗ Failed to fetch price for ${symbol}:`, error.response?.status, error.message)
    return 0
  }
}

export const fetchCurrentPrices = async (symbols) => {
  const prices = {}

  console.log(`Fetching prices for ${symbols.length} symbols...`)

  // Fetch all prices in parallel for speed
  const promises = symbols.map(async (symbol) => {
    const price = await fetchPriceForSymbol(symbol)
    prices[symbol] = price
  })

  await Promise.all(promises)

  const successCount = Object.values(prices).filter(p => p > 0).length
  console.log(`Successfully fetched ${successCount}/${symbols.length} prices`)

  return prices
}

export const fetchQuote = async (symbol) => {
  try {
    const url = `${CORS_PROXY}${encodeURIComponent(YAHOO_FINANCE_API + '/' + symbol)}`
    const response = await axios.get(url)

    const result = response.data.chart.result[0]
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
