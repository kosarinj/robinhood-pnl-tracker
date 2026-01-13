import axios from 'axios'

/**
 * Level 2 Service - Fetches and analyzes order book data
 * Detects large orders that could indicate support/resistance levels
 */
export class Level2Service {
  constructor() {
    this.apiKey = process.env.POLYGON_API_KEY
    this.baseUrl = 'https://api.polygon.io'

    // Thresholds for detecting "large" orders (configurable)
    this.config = {
      // Minimum order size to be considered "large" (shares)
      minLargeOrderSize: 10000,

      // Minimum order value to be considered "large" ($)
      minLargeOrderValue: 100000,

      // Number of price levels to analyze on each side
      depthLevels: 10,

      // Minimum percentage of total volume to flag as significant
      minVolumePercentage: 5,

      // Cache duration (ms) - don't re-fetch same symbol too quickly
      cacheDuration: 30000 // 30 seconds
    }

    this.cache = new Map()
  }

  /**
   * Get Level 2 order book data for a symbol
   * Returns bids and asks with price levels and sizes
   */
  async getOrderBook(symbol) {
    try {
      if (!this.apiKey) {
        console.warn('⚠️  Polygon API key not configured for Level 2 data')
        return null
      }

      // Check cache first
      const cached = this.cache.get(symbol)
      if (cached && Date.now() - cached.timestamp < this.config.cacheDuration) {
        console.log(`📦 Using cached order book for ${symbol}`)
        return cached.data
      }

      console.log(`📊 Fetching Level 2 data for ${symbol}...`)

      // Polygon Level 2 endpoint (requires Starter plan or higher)
      const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`
      const response = await axios.get(url, {
        params: { apiKey: this.apiKey },
        timeout: 10000
      })

      if (!response.data || !response.data.ticker) {
        console.warn(`No order book data available for ${symbol}`)
        return null
      }

      const ticker = response.data.ticker

      // Extract order book data
      const orderBook = {
        symbol,
        timestamp: Date.now(),
        lastPrice: ticker.lastTrade?.p || ticker.day?.c,
        bids: ticker.bids || [],
        asks: ticker.asks || [],
        totalBidVolume: 0,
        totalAskVolume: 0
      }

      // Calculate total volumes
      orderBook.totalBidVolume = orderBook.bids.reduce((sum, bid) => sum + (bid.s || 0), 0)
      orderBook.totalAskVolume = orderBook.asks.reduce((sum, ask) => sum + (ask.s || 0), 0)

      // Cache the result
      this.cache.set(symbol, {
        data: orderBook,
        timestamp: Date.now()
      })

      console.log(`✓ Order book for ${symbol}: ${orderBook.bids.length} bids, ${orderBook.asks.length} asks`)

      return orderBook
    } catch (error) {
      console.error(`Error fetching order book for ${symbol}:`, error.message)
      return null
    }
  }

  /**
   * Analyze order book to detect large orders that could be support/resistance
   * Returns array of significant price levels with metadata
   */
  analyzeLargeOrders(orderBook) {
    if (!orderBook || (!orderBook.bids.length && !orderBook.asks.length)) {
      return []
    }

    const levels = []
    const currentPrice = orderBook.lastPrice

    // Analyze bids (potential support levels)
    orderBook.bids.forEach((bid, index) => {
      if (index >= this.config.depthLevels) return

      const price = bid.p
      const size = bid.s
      const value = price * size
      const volumePercentage = (size / orderBook.totalBidVolume) * 100

      // Check if this is a "large" order
      if (
        size >= this.config.minLargeOrderSize ||
        value >= this.config.minLargeOrderValue ||
        volumePercentage >= this.config.minVolumePercentage
      ) {
        levels.push({
          symbol: orderBook.symbol,
          type: 'support',
          price: price,
          size: size,
          value: value,
          volumePercentage: volumePercentage.toFixed(2),
          distanceFromPrice: ((currentPrice - price) / currentPrice * 100).toFixed(2),
          strength: this.calculateStrength(size, value, volumePercentage),
          timestamp: orderBook.timestamp
        })
      }
    })

    // Analyze asks (potential resistance levels)
    orderBook.asks.forEach((ask, index) => {
      if (index >= this.config.depthLevels) return

      const price = ask.p
      const size = ask.s
      const value = price * size
      const volumePercentage = (size / orderBook.totalAskVolume) * 100

      // Check if this is a "large" order
      if (
        size >= this.config.minLargeOrderSize ||
        value >= this.config.minLargeOrderValue ||
        volumePercentage >= this.config.minVolumePercentage
      ) {
        levels.push({
          symbol: orderBook.symbol,
          type: 'resistance',
          price: price,
          size: size,
          value: value,
          volumePercentage: volumePercentage.toFixed(2),
          distanceFromPrice: ((price - currentPrice) / currentPrice * 100).toFixed(2),
          strength: this.calculateStrength(size, value, volumePercentage),
          timestamp: orderBook.timestamp
        })
      }
    })

    // Sort by strength (strongest first)
    levels.sort((a, b) => b.strength - a.strength)

    return levels
  }

  /**
   * Calculate strength score for a level (0-100)
   * Based on size, value, and volume percentage
   */
  calculateStrength(size, value, volumePercentage) {
    let strength = 0

    // Size component (0-40 points)
    const sizeScore = Math.min((size / this.config.minLargeOrderSize) * 20, 40)
    strength += sizeScore

    // Value component (0-40 points)
    const valueScore = Math.min((value / this.config.minLargeOrderValue) * 20, 40)
    strength += valueScore

    // Volume percentage component (0-20 points)
    const volumeScore = Math.min(volumePercentage * 2, 20)
    strength += volumeScore

    return Math.min(Math.round(strength), 100)
  }

  /**
   * Get support and resistance levels for a symbol
   * Convenience method that fetches order book and analyzes it
   */
  async getSupportResistanceLevels(symbol) {
    const orderBook = await this.getOrderBook(symbol)
    if (!orderBook) {
      return []
    }

    const levels = this.analyzeLargeOrders(orderBook)

    if (levels.length > 0) {
      console.log(`🎯 Found ${levels.length} significant levels for ${symbol}:`)
      levels.slice(0, 3).forEach(level => {
        console.log(`   ${level.type.toUpperCase()}: $${level.price} (${level.size.toLocaleString()} shares, strength: ${level.strength}/100)`)
      })
    }

    return levels
  }

  /**
   * Get support and resistance for multiple symbols
   */
  async getSupportResistanceForSymbols(symbols) {
    const results = {}

    for (const symbol of symbols) {
      try {
        const levels = await this.getSupportResistanceLevels(symbol)
        if (levels.length > 0) {
          results[symbol] = levels
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100))
      } catch (error) {
        console.error(`Error getting levels for ${symbol}:`, error.message)
      }
    }

    return results
  }

  /**
   * Update configuration thresholds
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig }
    console.log('📐 Level 2 config updated:', this.config)
  }

  /**
   * Clear cache for a symbol or all symbols
   */
  clearCache(symbol = null) {
    if (symbol) {
      this.cache.delete(symbol)
    } else {
      this.cache.clear()
    }
  }
}

export const level2Service = new Level2Service()
