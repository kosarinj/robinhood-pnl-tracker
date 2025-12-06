import axios from 'axios'

/**
 * Service for fetching market index data (S&P 500, NASDAQ, etc.)
 * Uses Yahoo Finance API with localStorage caching
 */

const CACHE_PREFIX = 'market_data_'
const CACHE_DURATION = 24 * 60 * 60 * 1000 // 24 hours

export class MarketDataService {
  constructor() {
    this.defaultIndex = '^GSPC' // S&P 500
  }

  /**
   * Fetch historical market data for a given index
   * @param {string} symbol - Index symbol (^GSPC, ^IXIC, etc.)
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Array>} Array of {date, open, high, low, close, volume}
   */
  async fetchHistoricalData(symbol = this.defaultIndex, startDate, endDate) {
    // Check cache first
    const cacheKey = `${CACHE_PREFIX}${symbol}_${startDate.getTime()}_${endDate.getTime()}`
    const cached = this.getFromCache(cacheKey)

    if (cached) {
      console.log(`📦 Using cached market data for ${symbol}`)
      return cached
    }

    try {
      console.log(`📡 Fetching market data for ${symbol} from ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`)

      const period1 = Math.floor(startDate.getTime() / 1000)
      const period2 = Math.floor(endDate.getTime() / 1000)

      // Use CORS proxy to avoid browser CORS restrictions
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`
      const url = `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`

      const response = await axios.get(url, {
        timeout: 30000, // Increased timeout for proxy
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      })

      if (!response.data?.chart?.result?.[0]) {
        throw new Error('Invalid response from Yahoo Finance')
      }

      const result = response.data.chart.result[0]
      const timestamps = result.timestamp
      const quotes = result.indicators.quote[0]

      if (!timestamps || !quotes) {
        throw new Error('No data available for this period')
      }

      // Transform to array of daily data
      const marketData = timestamps.map((timestamp, index) => ({
        date: new Date(timestamp * 1000),
        open: quotes.open[index],
        high: quotes.high[index],
        low: quotes.low[index],
        close: quotes.close[index],
        volume: quotes.volume[index]
      })).filter(day => day.close !== null) // Remove null values

      // Cache the result
      this.saveToCache(cacheKey, marketData)

      console.log(`✅ Fetched ${marketData.length} days of market data`)
      return marketData

    } catch (error) {
      console.error('❌ Error fetching market data:', error.message)
      throw new Error(`Failed to fetch market data: ${error.message}`)
    }
  }

  /**
   * Get cached data from localStorage
   */
  getFromCache(key) {
    try {
      const cached = localStorage.getItem(key)
      if (!cached) return null

      const { data, timestamp } = JSON.parse(cached)
      const age = Date.now() - timestamp

      if (age > CACHE_DURATION) {
        localStorage.removeItem(key)
        return null
      }

      return data
    } catch (error) {
      console.error('Cache read error:', error)
      return null
    }
  }

  /**
   * Save data to localStorage cache
   */
  saveToCache(key, data) {
    try {
      const cacheObject = {
        data,
        timestamp: Date.now()
      }
      localStorage.setItem(key, JSON.stringify(cacheObject))
    } catch (error) {
      console.error('Cache write error:', error)
      // Continue even if caching fails
    }
  }

  /**
   * Clear all market data cache
   */
  clearCache() {
    try {
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith(CACHE_PREFIX)) {
          localStorage.removeItem(key)
        }
      })
      console.log('🗑️ Market data cache cleared')
    } catch (error) {
      console.error('Cache clear error:', error)
    }
  }
}

// Export singleton instance
export const marketDataService = new MarketDataService()
