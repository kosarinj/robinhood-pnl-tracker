import axios from 'axios'

/**
 * Support/Resistance Service - Detects levels using historical price/volume data
 * Uses multiple algorithms: volume nodes, swing pivots, round numbers, consolidation zones
 */
export class SupportResistanceService {
  constructor() {
    this.apiKey = process.env.POLYGON_API_KEY
    this.baseUrl = 'https://api.polygon.io'

    // Configuration for detection algorithms
    this.config = {
      // Lookback period for analysis (days)
      lookbackDays: 60,

      // Minimum number of touches to confirm a level
      minTouches: 2,

      // Price tolerance for clustering nearby levels (%)
      priceTolerance: 0.5,

      // Minimum volume percentile to be considered "high volume" (0-100)
      minVolumePercentile: 75,

      // Swing pivot parameters
      leftBars: 5,  // Bars to the left of pivot
      rightBars: 5, // Bars to the right of pivot

      // Maximum number of levels to return per symbol
      maxLevels: 10,

      // Cache duration (ms)
      cacheDuration: 5 * 60 * 1000 // 5 minutes
    }

    this.cache = new Map()
  }

  /**
   * Fetch historical price/volume data from Polygon
   */
  async getHistoricalData(symbol, days = null) {
    try {
      if (!this.apiKey) {
        console.warn('⚠️  Polygon API key not configured')
        return null
      }

      const lookbackDays = days || this.config.lookbackDays
      const fromDate = new Date()
      fromDate.setDate(fromDate.getDate() - lookbackDays)

      const toDate = new Date()

      const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/1/day/${fromDate.toISOString().split('T')[0]}/${toDate.toISOString().split('T')[0]}`

      console.log(`📊 Fetching ${lookbackDays} days of historical data for ${symbol}...`)

      const response = await axios.get(url, {
        params: {
          apiKey: this.apiKey,
          adjusted: true,
          sort: 'asc'
        },
        timeout: 10000
      })

      if (!response.data || !response.data.results || response.data.results.length === 0) {
        console.warn(`No historical data available for ${symbol}`)
        return null
      }

      const candles = response.data.results.map(bar => ({
        timestamp: bar.t,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
        vwap: bar.vw
      }))

      console.log(`✓ Retrieved ${candles.length} candles for ${symbol}`)
      return candles
    } catch (error) {
      if (error.response) {
        console.error(`❌ Polygon API error for ${symbol}: ${error.response.status} - ${error.response.data?.error || error.message}`)
      } else if (error.code === 'ECONNABORTED') {
        console.error(`❌ Request timeout for ${symbol}`)
      } else {
        console.error(`❌ Error fetching historical data for ${symbol}:`, error.message)
      }
      return null
    }
  }

  /**
   * Get current price for a symbol
   */
  async getCurrentPrice(symbol) {
    try {
      if (!this.apiKey) {
        return null
      }

      const url = `${this.baseUrl}/v2/last/trade/${symbol}`
      const response = await axios.get(url, {
        params: { apiKey: this.apiKey },
        timeout: 5000
      })

      if (response.data && response.data.results) {
        return response.data.results.p
      }

      // Fallback: use latest snapshot
      const snapshotUrl = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`
      const snapshotResponse = await axios.get(snapshotUrl, {
        params: { apiKey: this.apiKey },
        timeout: 5000
      })

      if (snapshotResponse.data && snapshotResponse.data.ticker) {
        return snapshotResponse.data.ticker.day?.c || snapshotResponse.data.ticker.lastTrade?.p
      }

      return null
    } catch (error) {
      console.error(`❌ Error fetching current price for ${symbol}:`, error.message)
      return null
    }
  }

  /**
   * Detect swing pivot points (highs and lows)
   */
  detectSwingPivots(candles) {
    const pivots = []
    const { leftBars, rightBars } = this.config

    for (let i = leftBars; i < candles.length - rightBars; i++) {
      const current = candles[i]

      // Check for swing high (resistance)
      let isSwingHigh = true
      for (let j = i - leftBars; j < i; j++) {
        if (candles[j].high >= current.high) {
          isSwingHigh = false
          break
        }
      }
      if (isSwingHigh) {
        for (let j = i + 1; j <= i + rightBars; j++) {
          if (candles[j].high >= current.high) {
            isSwingHigh = false
            break
          }
        }
      }

      if (isSwingHigh) {
        pivots.push({
          type: 'resistance',
          price: current.high,
          timestamp: current.timestamp,
          volume: current.volume,
          method: 'swing_pivot'
        })
      }

      // Check for swing low (support)
      let isSwingLow = true
      for (let j = i - leftBars; j < i; j++) {
        if (candles[j].low <= current.low) {
          isSwingLow = false
          break
        }
      }
      if (isSwingLow) {
        for (let j = i + 1; j <= i + rightBars; j++) {
          if (candles[j].low <= current.low) {
            isSwingLow = false
            break
          }
        }
      }

      if (isSwingLow) {
        pivots.push({
          type: 'support',
          price: current.low,
          timestamp: current.timestamp,
          volume: current.volume,
          method: 'swing_pivot'
        })
      }
    }

    return pivots
  }

  /**
   * Detect high volume nodes (price levels with abnormally high volume)
   */
  detectVolumeNodes(candles) {
    const nodes = []

    // Calculate volume percentiles
    const volumes = candles.map(c => c.volume).sort((a, b) => a - b)
    const percentileIndex = Math.floor(volumes.length * (this.config.minVolumePercentile / 100))
    const volumeThreshold = volumes[percentileIndex]

    candles.forEach(candle => {
      if (candle.volume >= volumeThreshold) {
        // High volume at the high = resistance
        nodes.push({
          type: 'resistance',
          price: candle.high,
          timestamp: candle.timestamp,
          volume: candle.volume,
          method: 'volume_node'
        })

        // High volume at the low = support
        nodes.push({
          type: 'support',
          price: candle.low,
          timestamp: candle.timestamp,
          volume: candle.volume,
          method: 'volume_node'
        })
      }
    })

    return nodes
  }

  /**
   * Detect round number levels (psychological levels)
   */
  detectRoundNumbers(candles, currentPrice) {
    const levels = []

    if (!currentPrice) return levels

    // Find nearest round numbers (multiples of 5, 10, 25, 50, 100)
    const increments = [100, 50, 25, 10, 5, 1]

    for (const increment of increments) {
      const lower = Math.floor(currentPrice / increment) * increment
      const upper = Math.ceil(currentPrice / increment) * increment

      // Only add if within reasonable range (±20% of current price)
      if (lower >= currentPrice * 0.8 && lower <= currentPrice * 1.2) {
        levels.push({
          type: lower < currentPrice ? 'support' : 'resistance',
          price: lower,
          timestamp: Date.now(),
          volume: 0,
          method: 'round_number'
        })
      }

      if (upper >= currentPrice * 0.8 && upper <= currentPrice * 1.2 && upper !== lower) {
        levels.push({
          type: upper < currentPrice ? 'support' : 'resistance',
          price: upper,
          timestamp: Date.now(),
          volume: 0,
          method: 'round_number'
        })
      }
    }

    return levels
  }

  /**
   * Cluster nearby price levels together
   */
  clusterLevels(levels, currentPrice) {
    if (levels.length === 0) return []

    const tolerance = this.config.priceTolerance / 100
    const clusters = []

    // Group levels by type (support/resistance)
    const supportLevels = levels.filter(l => l.type === 'support').sort((a, b) => a.price - b.price)
    const resistanceLevels = levels.filter(l => l.type === 'resistance').sort((a, b) => a.price - b.price)

    const clusterGroup = (levelList, type) => {
      const grouped = []
      let currentCluster = []

      levelList.forEach(level => {
        if (currentCluster.length === 0) {
          currentCluster.push(level)
        } else {
          const clusterAvg = currentCluster.reduce((sum, l) => sum + l.price, 0) / currentCluster.length
          const priceDiff = Math.abs(level.price - clusterAvg) / clusterAvg

          if (priceDiff <= tolerance) {
            currentCluster.push(level)
          } else {
            grouped.push(this.consolidateCluster(currentCluster, type, currentPrice))
            currentCluster = [level]
          }
        }
      })

      if (currentCluster.length > 0) {
        grouped.push(this.consolidateCluster(currentCluster, type, currentPrice))
      }

      return grouped
    }

    clusters.push(...clusterGroup(supportLevels, 'support'))
    clusters.push(...clusterGroup(resistanceLevels, 'resistance'))

    return clusters
  }

  /**
   * Consolidate a cluster of levels into a single level
   */
  consolidateCluster(cluster, type, currentPrice) {
    const avgPrice = cluster.reduce((sum, l) => sum + l.price, 0) / cluster.length
    const totalVolume = cluster.reduce((sum, l) => sum + (l.volume || 0), 0)
    const touches = cluster.length
    const methods = [...new Set(cluster.map(l => l.method))]

    // Calculate strength based on:
    // - Number of touches (0-40 points)
    // - Volume (0-30 points)
    // - Multiple detection methods (0-30 points)
    let strength = 0

    // Touches component
    strength += Math.min(touches * 10, 40)

    // Volume component (normalized)
    const avgVolume = totalVolume / touches
    strength += Math.min((avgVolume / 1000000) * 5, 30) // Rough normalization

    // Methods component
    strength += methods.length * 10

    strength = Math.min(Math.round(strength), 100)

    return {
      symbol: null, // Will be set later
      type,
      price: parseFloat(avgPrice.toFixed(2)),
      touches,
      methods: methods.join(', '),
      distanceFromPrice: currentPrice ? parseFloat((((avgPrice - currentPrice) / currentPrice) * 100).toFixed(2)) : 0,
      strength,
      timestamp: Date.now()
    }
  }

  /**
   * Get support and resistance levels for a symbol
   */
  async getSupportResistanceLevels(symbol) {
    try {
      // Check cache
      const cached = this.cache.get(symbol)
      if (cached && Date.now() - cached.timestamp < this.config.cacheDuration) {
        console.log(`📦 Using cached support/resistance for ${symbol}`)
        return cached.levels
      }

      console.log(`🎯 Analyzing support/resistance levels for ${symbol}...`)

      // Fetch historical data
      const candles = await this.getHistoricalData(symbol)
      if (!candles || candles.length < 20) {
        console.log(`⚠️  Insufficient data for ${symbol}`)
        return []
      }

      // Get current price
      const currentPrice = await this.getCurrentPrice(symbol)
      if (!currentPrice) {
        console.log(`⚠️  Could not get current price for ${symbol}`)
        return []
      }

      // Run all detection algorithms
      const allLevels = []

      // 1. Swing pivots
      const pivots = this.detectSwingPivots(candles)
      allLevels.push(...pivots)
      console.log(`  ✓ Found ${pivots.length} swing pivots`)

      // 2. Volume nodes
      const volumeNodes = this.detectVolumeNodes(candles)
      allLevels.push(...volumeNodes)
      console.log(`  ✓ Found ${volumeNodes.length} volume nodes`)

      // 3. Round numbers
      const roundNumbers = this.detectRoundNumbers(candles, currentPrice)
      allLevels.push(...roundNumbers)
      console.log(`  ✓ Found ${roundNumbers.length} round number levels`)

      // Cluster nearby levels
      const clustered = this.clusterLevels(allLevels, currentPrice)

      // Add symbol to each level
      clustered.forEach(level => {
        level.symbol = symbol
      })

      // Sort by strength and limit
      const sorted = clustered
        .sort((a, b) => b.strength - a.strength)
        .slice(0, this.config.maxLevels)

      console.log(`🎯 Found ${sorted.length} significant levels for ${symbol}:`)
      sorted.slice(0, 5).forEach(level => {
        console.log(`   ${level.type.toUpperCase()}: $${level.price} (${level.touches} touches, strength: ${level.strength}/100)`)
      })

      // Cache the result
      this.cache.set(symbol, {
        levels: sorted,
        timestamp: Date.now()
      })

      return sorted
    } catch (error) {
      console.error(`Error analyzing support/resistance for ${symbol}:`, error.message)
      return []
    }
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
        await new Promise(resolve => setTimeout(resolve, 200))
      } catch (error) {
        console.error(`Error getting levels for ${symbol}:`, error.message)
      }
    }

    return results
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig }
    console.log('📐 Support/Resistance config updated:', this.config)
  }

  /**
   * Clear cache
   */
  clearCache(symbol = null) {
    if (symbol) {
      this.cache.delete(symbol)
    } else {
      this.cache.clear()
    }
  }
}

export const supportResistanceService = new SupportResistanceService()
