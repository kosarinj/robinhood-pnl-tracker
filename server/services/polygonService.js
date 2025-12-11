import axios from 'axios'
import { generateSignal } from './technicalAnalysis.js'

// Get your free API key from https://polygon.io/
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'YOUR_API_KEY_HERE'

export class PolygonService {
  constructor() {
    this.signalCache = new Map()
    this.dataCache = new Map()
    this.CACHE_DURATION = 300000 // 5 minutes
  }

  // Get trading signal for a single symbol
  async getSignal(symbol, currentPrice) {
    try {
      const historicalData = await this.getIntradayData(symbol)

      if (!historicalData || historicalData.length === 0) {
        throw new Error('No historical data available')
      }

      const signal = generateSignal(symbol, currentPrice, historicalData)

      // Cache the signal
      this.signalCache.set(symbol, {
        signal,
        timestamp: Date.now()
      })

      return { ...signal, currentPrice }
    } catch (error) {
      console.error(`Error generating signal for ${symbol}:`, error)
      throw error
    }
  }

  // Get trading signals for multiple symbols
  async getSignals(symbols, prices) {
    const signals = []

    for (const symbol of symbols) {
      try {
        const currentPrice = prices[symbol] || 0
        if (currentPrice === 0) continue

        const signal = await this.getSignal(symbol, currentPrice)
        signals.push(signal)

        // Small delay to avoid rate limits (Polygon free tier: 5 requests/min)
        await new Promise(resolve => setTimeout(resolve, 12000)) // 12 seconds between requests
      } catch (error) {
        console.error(`Error fetching signal for ${symbol}:`, error)
      }
    }

    return signals
  }

  // Fetch intraday data from Polygon.io
  async getIntradayData(symbol) {
    // Check cache first
    const now = Date.now()
    const cached = this.dataCache.get(symbol)
    if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {
      return cached.data
    }

    try {
      // Get the last 2 trading days of 5-minute aggregates
      const to = new Date()
      const from = new Date(to)
      from.setDate(from.getDate() - 2)

      const fromStr = from.toISOString().split('T')[0]
      const toStr = to.toISOString().split('T')[0]

      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/5/minute/${fromStr}/${toStr}`

      const response = await axios.get(url, {
        params: {
          apiKey: POLYGON_API_KEY,
          adjusted: true,
          sort: 'asc',
          limit: 50000
        },
        timeout: 10000
      })

      if (response.data.status === 'ERROR') {
        console.error(`Polygon API error for ${symbol}:`, response.data.error)
        return null
      }

      if (!response.data.results || response.data.results.length === 0) {
        console.warn(`No intraday data for ${symbol}`)
        return null
      }

      // Convert Polygon format to our format
      const data = response.data.results.map(bar => ({
        timestamp: new Date(bar.t),
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v
      }))

      // Cache the result
      this.dataCache.set(symbol, {
        data,
        timestamp: now
      })

      console.log(`✅ Polygon: Fetched ${data.length} bars for ${symbol}`)
      return data
    } catch (error) {
      if (error.response?.status === 429) {
        console.error(`Polygon API rate limit exceeded for ${symbol}`)
      } else if (error.response?.status === 403) {
        console.error(`Polygon API key invalid or unauthorized for ${symbol}`)
      } else {
        console.error(`Error fetching Polygon data for ${symbol}:`, error.message)
      }
      return null
    }
  }

  // Get current quote (alternative to Yahoo Finance)
  async getCurrentQuote(symbol) {
    try {
      const url = `https://api.polygon.io/v2/last/trade/${symbol}`

      const response = await axios.get(url, {
        params: { apiKey: POLYGON_API_KEY },
        timeout: 5000
      })

      if (response.data.status === 'OK' && response.data.results) {
        const result = response.data.results
        return {
          symbol,
          price: result.p,
          size: result.s,
          timestamp: new Date(result.t)
        }
      }

      return null
    } catch (error) {
      console.error(`Error fetching current quote for ${symbol}:`, error.message)
      return null
    }
  }

  // Get market status
  async getMarketStatus() {
    try {
      const url = 'https://api.polygon.io/v1/marketstatus/now'

      const response = await axios.get(url, {
        params: { apiKey: POLYGON_API_KEY },
        timeout: 5000
      })

      return response.data
    } catch (error) {
      console.error('Error fetching market status:', error.message)
      return null
    }
  }
}
