import axios from 'axios'

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

export class PriceService {
  constructor(databaseService = null) {
    this.priceCache = new Map()
    this.trackedSymbols = new Set()
    this.lastUpdate = null
    this.databaseService = databaseService
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

  // Fetch prices from Yahoo Finance using bulk quote endpoint (fewer requests = less rate limiting)
  async fetchPrices(symbols) {
    const prices = {}
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    }

    try {
      // Use bulk quote endpoint — fetch up to 50 symbols per request instead of 1 per request
      const batchSize = 50
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize)
        const symbolList = batch.join(',')

        try {
          const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbolList}&fields=regularMarketPrice`
          const response = await axios.get(url, { timeout: 10000, headers })

          const quotes = response.data?.quoteResponse?.result || []
          quotes.forEach(q => {
            if (q.regularMarketPrice) {
              prices[q.symbol] = q.regularMarketPrice
              this.priceCache.set(q.symbol, q.regularMarketPrice)
            }
          })

          // Mark any symbols that didn't come back as 0
          batch.forEach(symbol => {
            if (prices[symbol] === undefined) {
              console.warn(`No price data for ${symbol}`)
              prices[symbol] = 0
              this.priceCache.set(symbol, 0)
            }
          })
        } catch (error) {
          console.error(`Error fetching bulk prices (batch ${i / batchSize + 1}):`, error.message)
          batch.forEach(symbol => {
            prices[symbol] = 0
            this.priceCache.set(symbol, 0)
          })
        }

        if (i + batchSize < symbols.length) {
          await new Promise(resolve => setTimeout(resolve, 1000))
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
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`
      const response = await axios.get(url, { timeout: 15000, headers: YF_HEADERS })

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

  // Get closing price for a specific date
  async getPriceForDate(symbol, dateString) {
    try {
      // Check database cache first
      if (this.databaseService) {
        const cachedPrice = this.databaseService.getHistoricalPrice(symbol, dateString)
        if (cachedPrice !== null) {
          console.log(`✓ ${symbol} price for ${dateString} from cache: $${cachedPrice}`)
          return cachedPrice
        }
      }

      const targetDate = new Date(dateString)
      targetDate.setHours(0, 0, 0, 0)

      // Fetch 1 week of data around the target date to handle weekends/holidays
      const endDate = new Date(targetDate)
      endDate.setDate(endDate.getDate() + 3)
      const startDate = new Date(targetDate)
      startDate.setDate(startDate.getDate() - 3)

      const period1 = Math.floor(startDate.getTime() / 1000)
      const period2 = Math.floor(endDate.getTime() / 1000)

      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`
      const response = await axios.get(url, { timeout: 6000, headers: YF_HEADERS })

      const result = response.data?.chart?.result?.[0]
      if (!result) {
        console.warn(`No historical data for ${symbol} on ${dateString} — returning 0`)
        return 0
      }

      const timestamps = result.timestamp || []
      const quotes = result.indicators?.quote?.[0]

      if (!quotes || timestamps.length === 0) {
        console.warn(`No quotes for ${symbol} on ${dateString} — returning 0`)
        return 0
      }

      // Find the closest date to our target
      let closestIndex = 0
      let closestDiff = Infinity

      timestamps.forEach((ts, i) => {
        const dataDate = new Date(ts * 1000)
        dataDate.setHours(0, 0, 0, 0)
        const diff = Math.abs(dataDate - targetDate)
        if (diff < closestDiff && quotes.close[i] !== null) {
          closestDiff = diff
          closestIndex = i
        }
      })

      const closingPrice = quotes.close[closestIndex]
      const actualDate = new Date(timestamps[closestIndex] * 1000).toISOString().split('T')[0]

      // Save to cache if databaseService is available
      if (this.databaseService && closingPrice) {
        this.databaseService.saveHistoricalPrice(
          symbol,
          actualDate,
          quotes.open[closestIndex],
          quotes.high[closestIndex],
          quotes.low[closestIndex],
          closingPrice,
          quotes.volume[closestIndex]
        )
      }

      console.log(`✓ ${symbol} closing price on ${actualDate} (target: ${dateString}): $${closingPrice}`)
      return closingPrice || 0
    } catch (error) {
      console.error(`✗ Failed to fetch historical price for ${symbol} on ${dateString}:`, error.message)
      // Fallback to current price if historical fetch fails
      return await this.getPrice(symbol)
    }
  }

  // Get closing prices for multiple symbols on a specific date
  async getPricesForDate(symbols, dateString) {
    const prices = {}
    const symbolsToFetch = []

    // Check cache for all symbols first
    if (this.databaseService) {
      const cachedPrices = this.databaseService.getHistoricalPricesForDate(symbols, dateString)
      Object.assign(prices, cachedPrices)

      // Determine which symbols still need to be fetched
      symbols.forEach(symbol => {
        if (prices[symbol] === undefined) {
          symbolsToFetch.push(symbol)
        }
      })

      console.log(`✓ Found ${Object.keys(cachedPrices).length}/${symbols.length} prices in cache for ${dateString}`)
    } else {
      symbolsToFetch.push(...symbols)
    }

    // Fetch missing prices with a 25-second overall timeout
    // so a slow Yahoo Finance response never hangs the CSV upload
    if (symbolsToFetch.length > 0) {
      const fetchPromises = symbolsToFetch.map(async (symbol) => {
        prices[symbol] = await this.getPriceForDate(symbol, dateString)
      })
      const timeout = new Promise(resolve => setTimeout(() => {
        console.warn(`⏱ Price fetch timed out after 25s — proceeding with ${Object.keys(prices).length}/${symbols.length} prices`)
        resolve()
      }, 25000))
      await Promise.race([Promise.all(fetchPromises), timeout])
    }

    return prices
  }
}
