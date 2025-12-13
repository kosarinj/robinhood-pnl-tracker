import axios from 'axios'

export class PriceService {
  constructor() {
    this.priceCache = new Map()
    this.trackedSymbols = new Set()
    this.lastUpdate = null
  }

  // Add symbols to track
  addSymbols(symbols) {
    symbols.forEach(symbol => this.trackedSymbols.add(symbol))
    console.log(`Now tracking ${this.trackedSymbols.size} symbols`)
  }

  // Get tracked symbols
  getTrackedSymbols() {
    return Array.from(this.trackedSymbols)
  }

  // Get current cached prices
  getCurrentPrices() {
    const prices = {}
    this.priceCache.forEach((price, symbol) => {
      prices[symbol] = price
    })
    return prices
  }

  // Get price for a single symbol (fetch if not cached)
  async getPrice(symbol) {
    if (this.priceCache.has(symbol)) {
      return this.priceCache.get(symbol)
    }

    const prices = await this.fetchPrices([symbol])
    return prices[symbol] || 0
  }

  // Get prices for multiple symbols (uses cache if available)
  async getPrices(symbols) {
    const prices = {}
    const symbolsToFetch = []

    // Check cache first
    symbols.forEach(symbol => {
      if (this.priceCache.has(symbol)) {
        prices[symbol] = this.priceCache.get(symbol)
      } else {
        symbolsToFetch.push(symbol)
      }
    })

    // Fetch missing prices
    if (symbolsToFetch.length > 0) {
      const fetchedPrices = await this.fetchPrices(symbolsToFetch)
      Object.assign(prices, fetchedPrices)
    }

    return prices
  }

  // Refresh all tracked symbols
  async refreshPrices() {
    const symbols = Array.from(this.trackedSymbols)
    if (symbols.length === 0) {
      return {}
    }

    console.log(`Refreshing prices for ${symbols.length} symbols...`)
    const prices = await this.fetchPrices(symbols)
    this.lastUpdate = new Date()
    console.log(`Prices updated at ${this.lastUpdate.toLocaleTimeString()}`)

    return prices
  }

  // Fetch prices from Yahoo Finance
  async fetchPrices(symbols) {
    const prices = {}

    try {
      // Use the same CORS proxy as the client
      const corsProxy = 'https://corsproxy.io/?'

      // Process symbols in batches to avoid overwhelming the API
      const batchSize = 10
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize)

        await Promise.all(
          batch.map(async (symbol) => {
            try {
              const url = `${corsProxy}https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1m`
              const response = await axios.get(url, { timeout: 10000 })

              const result = response.data?.chart?.result?.[0]
              if (result && result.meta && result.meta.regularMarketPrice) {
                const price = result.meta.regularMarketPrice
                prices[symbol] = price
                this.priceCache.set(symbol, price)
              } else {
                console.warn(`No price data for ${symbol}`)
                prices[symbol] = 0
                this.priceCache.set(symbol, 0)
              }
            } catch (error) {
              console.error(`Error fetching price for ${symbol}:`, error.message)
              prices[symbol] = 0
              this.priceCache.set(symbol, 0)
            }
          })
        )

        // Small delay between batches
        if (i + batchSize < symbols.length) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
    } catch (error) {
      console.error('Error in fetchPrices:', error)
    }

    return prices
  }

  // Fetch historical price data for charting
  async fetchHistoricalPrices(symbol, range = '6mo', interval = '1d') {
    try {
      console.log(`Fetching historical data for ${symbol} (${range}, ${interval})`)

      // Yahoo Finance API URL - no CORS issues on server
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`
      const response = await axios.get(url, { timeout: 15000 })

      const result = response.data?.chart?.result?.[0]
      if (!result) {
        throw new Error('No data returned from Yahoo Finance')
      }

      const timestamps = result.timestamp || []
      const quotes = result.indicators?.quote?.[0]

      if (!quotes) {
        throw new Error('No quote data in response')
      }

      const historicalData = timestamps.map((ts, i) => ({
        timestamp: ts * 1000, // Convert to milliseconds
        date: new Date(ts * 1000).toISOString(),
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
      throw error
    }
  }
}
