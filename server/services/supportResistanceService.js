import axios from 'axios'

/**
 * Support/Resistance Service - Detects levels using historical price/volume data
 * Uses multiple algorithms: volume nodes, swing pivots, round numbers, consolidation zones
 */
export class SupportResistanceService {
  constructor() {
    this.apiKey = process.env.POLYGON_API_KEY
    this.baseUrl = 'https://api.polygon.io'

    // Log API key status at startup
    if (this.apiKey) {
      console.log('✅ Polygon API key configured for support/resistance service')
    } else {
      console.warn('⚠️  Polygon API key NOT found - support/resistance feature will not work')
      console.warn('    Set POLYGON_API_KEY environment variable to enable this feature')
    }

    // Configuration for detection algorithms
    this.config = {
      // Lookback period for analysis (days)
      lookbackDays: 60,

      // Timeframe: 'daily', '1hour', '15min', '5min'
      timeframe: 'daily',

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
      const timeframe = this.config.timeframe

      // Map timeframe to Polygon API parameters
      let multiplier, timespan
      let isIntraday = false

      switch (timeframe) {
        case '5min':
          multiplier = 5
          timespan = 'minute'
          isIntraday = true
          break
        case '15min':
          multiplier = 15
          timespan = 'minute'
          isIntraday = true
          break
        case '1hour':
          multiplier = 1
          timespan = 'hour'
          isIntraday = true
          break
        case 'daily':
        default:
          multiplier = 1
          timespan = 'day'
          isIntraday = false
      }

      const toDate = new Date()
      const fromDate = new Date()

      if (isIntraday) {
        if (lookbackDays === 1) {
          // For 1 period intraday: Get only TODAY's session (from market open to now)
          // Set to today at 9:30 AM ET (market open) or earlier
          fromDate.setHours(0, 0, 0, 0) // Start of today
          console.log(`  Using TODAY ONLY for intraday analysis`)
        } else {
          // For multiple periods: fetch last N days of intraday data
          const intradayLookback = Math.min(lookbackDays, 5) // Limit intraday to max 5 days
          fromDate.setDate(fromDate.getDate() - intradayLookback)
          console.log(`  Using last ${intradayLookback} days for intraday analysis`)
        }
      } else {
        fromDate.setDate(fromDate.getDate() - lookbackDays)
      }

      const fromStr = fromDate.toISOString().split('T')[0]
      const toStr = toDate.toISOString().split('T')[0]

      const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${fromStr}/${toStr}`

      console.log(`📊 Fetching ${isIntraday ? 'intraday' : 'daily'} data for ${symbol} (${timeframe})...`)

      const response = await axios.get(url, {
        params: {
          apiKey: this.apiKey,
          adjusted: true,
          sort: 'asc'
        },
        timeout: 10000
      })

      if (!response.data || !response.data.results || response.data.results.length === 0) {
        if (isIntraday) {
          console.warn(`⚠️  No intraday data for ${symbol} - Polygon free tier only supports daily data`)
          console.warn(`   To use intraday timeframes (5min, 15min, 1hour), upgrade to Polygon Starter plan ($99/mo)`)
        } else {
          console.warn(`No historical data available for ${symbol}`)
        }
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

      console.log(`✓ Retrieved ${candles.length} ${timeframe} candles for ${symbol}`)
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

      console.log(`💲 Fetching current price for ${symbol}...`)

      // Try method 1: Previous close from aggregates (most reliable for free tier)
      try {
        const yesterday = new Date()
        yesterday.setDate(yesterday.getDate() - 1)
        const dateStr = yesterday.toISOString().split('T')[0]

        const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/prev`
        console.log(`  Trying: ${url}`)

        const response = await axios.get(url, {
          params: { apiKey: this.apiKey, adjusted: true },
          timeout: 5000
        })

        if (response.data && response.data.results && response.data.results.length > 0) {
          const price = response.data.results[0].c
          console.log(`  ✓ Got price from previous close: $${price}`)
          return price
        }
      } catch (err) {
        console.log(`  ✗ Previous close failed: ${err.message}`)
      }

      // Try method 2: Snapshot (free tier)
      try {
        const snapshotUrl = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`
        console.log(`  Trying: ${snapshotUrl}`)

        const snapshotResponse = await axios.get(snapshotUrl, {
          params: { apiKey: this.apiKey },
          timeout: 5000
        })

        if (snapshotResponse.data && snapshotResponse.data.ticker) {
          const price = snapshotResponse.data.ticker.day?.c || snapshotResponse.data.ticker.prevDay?.c
          if (price) {
            console.log(`  ✓ Got price from snapshot: $${price}`)
            return price
          }
        }
      } catch (err) {
        console.log(`  ✗ Snapshot failed: ${err.response?.status} - ${err.message}`)
      }

      // Try method 3: Last trade (may require paid plan)
      try {
        const url = `${this.baseUrl}/v2/last/trade/${symbol}`
        console.log(`  Trying: ${url}`)

        const response = await axios.get(url, {
          params: { apiKey: this.apiKey },
          timeout: 5000
        })

        if (response.data && response.data.results) {
          const price = response.data.results.p
          console.log(`  ✓ Got price from last trade: $${price}`)
          return price
        }
      } catch (err) {
        console.log(`  ✗ Last trade failed: ${err.response?.status} - ${err.message}`)
      }

      console.log(`  ❌ All methods failed for ${symbol}`)
      return null
    } catch (error) {
      console.error(`❌ Error fetching current price for ${symbol}:`, error.message)
      return null
    }
  }

  /**
   * Fetch recent large trades for a symbol
   */
  async getLargeTrades(symbol, lookbackMinutes = 60) {
    try {
      if (!this.apiKey) {
        return []
      }

      const now = Date.now()
      const fromTimestamp = now - (lookbackMinutes * 60 * 1000)

      const url = `${this.baseUrl}/v3/trades/${symbol}`

      console.log(`📊 Fetching recent large trades for ${symbol}...`)

      const response = await axios.get(url, {
        params: {
          apiKey: this.apiKey,
          timestamp: fromTimestamp,
          limit: 50000, // Max allowed
          sort: 'timestamp'
        },
        timeout: 10000
      })

      if (!response.data || !response.data.results || response.data.results.length === 0) {
        console.log(`  No trade data available for ${symbol}`)
        return []
      }

      const trades = response.data.results
      console.log(`  Retrieved ${trades.length} trades for ${symbol}`)

      // Calculate size threshold (top 10% of trade sizes)
      const sizes = trades.map(t => t.size).sort((a, b) => b - a)
      const threshold = Math.max(10000, sizes[Math.floor(sizes.length * 0.1)]) // At least 10k shares

      const largeTrades = trades.filter(t => t.size >= threshold)

      console.log(`  Found ${largeTrades.length} large trades (>=${threshold.toLocaleString()} shares)`)

      return largeTrades.map(trade => ({
        price: trade.price,
        size: trade.size,
        timestamp: trade.participant_timestamp || trade.sip_timestamp,
        conditions: trade.conditions || []
      }))
    } catch (error) {
      console.error(`❌ Error fetching large trades for ${symbol}:`, error.message)
      return []
    }
  }

  /**
   * Detect support/resistance from large trade clusters
   */
  detectLargeTradeLevels(largeTrades, currentPrice) {
    const levels = []

    if (!largeTrades || largeTrades.length === 0) return levels

    // Group trades by price (within 0.5% tolerance)
    const priceGroups = new Map()

    largeTrades.forEach(trade => {
      let foundGroup = false

      for (const [groupPrice, trades] of priceGroups.entries()) {
        const priceDiff = Math.abs(trade.price - groupPrice) / groupPrice
        if (priceDiff <= 0.005) { // 0.5% tolerance
          trades.push(trade)
          foundGroup = true
          break
        }
      }

      if (!foundGroup) {
        priceGroups.set(trade.price, [trade])
      }
    })

    // Create levels from significant trade clusters
    for (const [price, trades] of priceGroups.entries()) {
      if (trades.length >= 2) { // At least 2 large trades at this level
        const totalVolume = trades.reduce((sum, t) => sum + t.size, 0)
        const mostRecentTimestamp = Math.max(...trades.map(t => t.timestamp))

        levels.push({
          type: price < currentPrice ? 'support' : 'resistance',
          price: price,
          timestamp: mostRecentTimestamp,
          volume: totalVolume,
          touches: trades.length,
          method: 'large_trade'
        })
      }
    }

    console.log(`  ✓ Found ${levels.length} levels from large trade clusters`)
    return levels
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
   * Only creates levels that were actually within the price range during the lookback period
   */
  detectRoundNumbers(candles, currentPrice) {
    const levels = []

    if (!candles || candles.length === 0 || !currentPrice) return levels

    // Find the actual price range from historical data
    const highs = candles.map(c => c.high)
    const lows = candles.map(c => c.low)
    const rangeHigh = Math.max(...highs)
    const rangeLow = Math.min(...lows)

    console.log(`  Round numbers: price range in lookback period: $${rangeLow.toFixed(2)} - $${rangeHigh.toFixed(2)}`)

    // Helper to find when price was last near a level
    const findLastTouch = (targetPrice, tolerance = 0.01) => {
      for (let i = candles.length - 1; i >= 0; i--) {
        const candle = candles[i]
        const priceDiff = Math.abs(candle.close - targetPrice) / targetPrice
        if (priceDiff <= tolerance || (candle.low <= targetPrice && candle.high >= targetPrice)) {
          return candle.timestamp
        }
      }
      return candles[candles.length - 1].timestamp // Use most recent if not found
    }

    // Find nearest round numbers (multiples of 5, 10, 25, 50, 100)
    const increments = [100, 50, 25, 10, 5, 1]

    for (const increment of increments) {
      const lower = Math.floor(currentPrice / increment) * increment
      const upper = Math.ceil(currentPrice / increment) * increment

      // Only add if within the ACTUAL price range from the lookback period
      if (lower >= rangeLow && lower <= rangeHigh) {
        levels.push({
          type: lower < currentPrice ? 'support' : 'resistance',
          price: lower,
          timestamp: findLastTouch(lower),
          volume: 0,
          method: 'round_number'
        })
      }

      if (upper >= rangeLow && upper <= rangeHigh && upper !== lower) {
        levels.push({
          type: upper < currentPrice ? 'support' : 'resistance',
          price: upper,
          timestamp: findLastTouch(upper),
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

    // Use the most recent timestamp from the cluster (when price last touched this level)
    const timestamps = cluster.map(l => l.timestamp).filter(t => t)
    const mostRecentTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : Date.now()

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
      timestamp: mostRecentTimestamp
    }
  }

  /**
   * Get support and resistance levels for a symbol
   */
  async getSupportResistanceLevels(symbol) {
    try {
      console.log(`\n🎯 getSupportResistanceLevels called for ${symbol}`)

      // Check if API key is configured
      if (!this.apiKey) {
        console.error(`❌ No API key found for ${symbol} request`)
        throw new Error('Polygon API key not configured. Please set POLYGON_API_KEY environment variable.')
      }
      console.log(`✓ API key present`)

      // Check cache (key includes timeframe to separate daily vs intraday data)
      const cacheKey = `${symbol}-${this.config.timeframe}`
      const cached = this.cache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < this.config.cacheDuration) {
        console.log(`📦 Using cached support/resistance for ${symbol} [${this.config.timeframe}] (${cached.levels.length} levels)`)
        return cached.levels
      }

      console.log(`🎯 Analyzing support/resistance levels for ${symbol} [${this.config.timeframe}]...`)

      // Fetch historical data
      const candles = await this.getHistoricalData(symbol)

      // Minimum candles needed varies by timeframe
      // Ideally need leftBars + 1 + rightBars (11) for swing pivot detection
      // But for newer stocks, we can work with less data
      const minCandles = this.config.timeframe === 'daily' ? 5 : 10

      if (!candles || candles.length < minCandles) {
        throw new Error(`Insufficient historical data for ${symbol}. Got ${candles?.length || 0} candles, need at least ${minCandles}. This stock may be newly listed or have very limited trading history. Try a stock with more history.`)
      }

      // Warn if data is limited
      if (candles.length < 11) {
        console.warn(`⚠️  Limited data for ${symbol} (${candles.length} candles). Results may be less reliable.`)
      }

      console.log(`  ✓ Have ${candles.length} candles for analysis`)

      // Get current price
      const currentPrice = await this.getCurrentPrice(symbol)
      if (!currentPrice) {
        throw new Error(`Could not get current price for ${symbol}. Check if symbol is valid.`)
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

      // 4. Large trades (only for intraday timeframes)
      if (this.config.timeframe !== 'daily') {
        const largeTrades = await this.getLargeTrades(symbol, 240) // Last 4 hours
        const largeTradeLevels = this.detectLargeTradeLevels(largeTrades, currentPrice)
        allLevels.push(...largeTradeLevels)
        console.log(`  ✓ Found ${largeTradeLevels.length} large trade levels`)
      }

      // Cluster nearby levels
      const clustered = this.clusterLevels(allLevels, currentPrice)

      // Add symbol to each level
      clustered.forEach(level => {
        level.symbol = symbol
      })

      // Sort by timestamp (most recent first) and limit
      const sorted = clustered
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, this.config.maxLevels)

      console.log(`🎯 Found ${sorted.length} significant levels for ${symbol} [${this.config.timeframe}]:`)
      sorted.slice(0, 5).forEach(level => {
        console.log(`   ${level.type.toUpperCase()}: $${level.price} (${level.touches} touches, strength: ${level.strength}/100)`)
      })

      // Cache the result (using timeframe-specific key)
      this.cache.set(cacheKey, {
        levels: sorted,
        timestamp: Date.now()
      })

      return sorted
    } catch (error) {
      console.error(`❌ Error analyzing support/resistance for ${symbol}:`, error.message)
      console.error(`   Full error:`, error)
      throw error // Re-throw so caller can handle it
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

        // Delay to respect free tier rate limits (5 calls/min)
        // Each symbol uses 2 calls, so wait 30 seconds between symbols to stay well under limit
        if (symbols.indexOf(symbol) < symbols.length - 1) {
          console.log(`⏳ Waiting 30s before next symbol (free tier rate limit)...`)
          await new Promise(resolve => setTimeout(resolve, 30000))
        }
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
    const oldConfig = { ...this.config }
    this.config = { ...this.config, ...newConfig }

    // Clear cache if timeframe or lookback changed (different data sets)
    if (oldConfig.timeframe !== this.config.timeframe || oldConfig.lookbackDays !== this.config.lookbackDays) {
      console.log(`📐 Config changed (timeframe: ${oldConfig.timeframe}->${this.config.timeframe}, lookback: ${oldConfig.lookbackDays}->${this.config.lookbackDays}) - clearing cache`)
      this.clearCache()
    }

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

  /**
   * Check if symbols are near or above resistance levels
   * Returns alerts for stocks approaching/breaking resistance
   */
  async checkResistanceAlerts(symbols, currentPrices = {}) {
    const alerts = []

    for (const symbol of symbols) {
      try {
        // Use provided current price if available, otherwise fetch from API
        let currentPrice = currentPrices[symbol]
        if (!currentPrice) {
          currentPrice = await this.getCurrentPrice(symbol)
        }
        if (!currentPrice) continue

        // Get support/resistance levels for this symbol
        const levels = await this.getSupportResistanceLevels(symbol)

        // Find highest resistance level
        const resistanceLevels = levels.filter(l => l.type === 'resistance')
        if (resistanceLevels.length === 0) continue

        // Sort by price to get highest resistance
        const highestResistance = resistanceLevels.sort((a, b) => b.price - a.price)[0]

        // Calculate distance from highest resistance
        const percentFromResistance = ((currentPrice - highestResistance.price) / highestResistance.price) * 100

        // Alert if within 2% below resistance or above it
        if (percentFromResistance >= -2) {
          let status = 'approaching'
          if (percentFromResistance >= 0) {
            status = 'broken'
          } else if (percentFromResistance >= -0.5) {
            status = 'testing'
          }

          alerts.push({
            symbol,
            currentPrice,
            resistancePrice: highestResistance.price,
            resistanceStrength: highestResistance.strength,
            percentFromResistance: parseFloat(percentFromResistance.toFixed(2)),
            status,
            touches: highestResistance.touches,
            timestamp: Date.now()
          })
        }
      } catch (error) {
        console.error(`Error checking resistance alert for ${symbol}:`, error.message)
      }
    }

    return alerts.sort((a, b) => b.percentFromResistance - a.percentFromResistance)
  }
}

export const supportResistanceService = new SupportResistanceService()
