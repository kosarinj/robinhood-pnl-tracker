import axios from 'axios'
import { calculateEMA } from './technicalAnalysis.js'

/**
 * EMA Alert Service - Detects EMA 9/21 crossovers
 * Alerts when EMA 9 crosses above (Golden Cross) or below (Death Cross) EMA 21
 */
export class EMAAlertService {
  constructor() {
    this.apiKey = process.env.POLYGON_API_KEY
    this.baseUrl = 'https://api.polygon.io'
    this.cache = new Map()
    this.cacheDuration = 5 * 60 * 1000 // 5 minutes

    // Log API key status
    if (this.apiKey) {
      console.log('✅ Polygon API key configured for EMA alert service')
    } else {
      console.warn('⚠️  Polygon API key NOT found - EMA alerts will not work')
    }
  }

  /**
   * Fetch daily historical price data for EMA calculation
   */
  async getHistoricalData(symbol, days = 60) {
    try {
      if (!this.apiKey) {
        console.warn('⚠️  Polygon API key not configured')
        return null
      }

      const toDate = new Date()
      const fromDate = new Date()
      fromDate.setDate(fromDate.getDate() - days)

      const fromStr = fromDate.toISOString().split('T')[0]
      const toStr = toDate.toISOString().split('T')[0]

      const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/1/day/${fromStr}/${toStr}`

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
        volume: bar.v
      }))

      return candles
    } catch (error) {
      console.error(`❌ Error fetching historical data for ${symbol}:`, error.message)
      return null
    }
  }

  /**
   * Detect EMA crossovers for a symbol
   * Returns null if no crossover, or an object with crossover details
   */
  detectEMACrossover(symbol, candles) {
    if (!candles || candles.length < 22) {
      return null
    }

    // Get closing prices
    const prices = candles.map(c => c.close)

    // Calculate current EMAs
    const ema9 = calculateEMA(prices, 9)
    const ema21 = calculateEMA(prices, 21)

    if (!ema9 || !ema21) {
      return null
    }

    // Calculate previous day's EMAs
    const prevPrices = prices.slice(0, -1)
    const prevEma9 = calculateEMA(prevPrices, 9)
    const prevEma21 = calculateEMA(prevPrices, 21)

    if (!prevEma9 || !prevEma21) {
      return null
    }

    // Detect crossover
    let crossoverType = null
    let signal = null

    // Golden Cross: EMA 9 crosses ABOVE EMA 21 (Bullish)
    if (prevEma9 <= prevEma21 && ema9 > ema21) {
      crossoverType = 'golden_cross'
      signal = 'BUY'
    }
    // Death Cross: EMA 9 crosses BELOW EMA 21 (Bearish)
    else if (prevEma9 >= prevEma21 && ema9 < ema21) {
      crossoverType = 'death_cross'
      signal = 'SELL'
    }

    if (!crossoverType) {
      return null
    }

    const currentPrice = candles[candles.length - 1].close
    const percentDiff = ((ema9 - ema21) / ema21) * 100

    return {
      symbol,
      type: crossoverType,
      signal,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      ema9: parseFloat(ema9.toFixed(2)),
      ema21: parseFloat(ema21.toFixed(2)),
      percentDiff: parseFloat(percentDiff.toFixed(2)),
      timestamp: Date.now(),
      message: crossoverType === 'golden_cross'
        ? `🟢 ${symbol}: EMA 9 crossed above EMA 21 (Bullish signal)`
        : `🔴 ${symbol}: EMA 9 crossed below EMA 21 (Bearish signal)`
    }
  }

  /**
   * Check for EMA crossovers across multiple symbols
   * Returns array of alerts for symbols with recent crossovers
   */
  async checkEMACrossovers(symbols) {
    const alerts = []

    console.log(`🔍 Checking EMA crossovers for ${symbols.length} symbols...`)

    for (const symbol of symbols) {
      try {
        // Check cache first
        const cacheKey = `ema-${symbol}`
        const cached = this.cache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
          if (cached.alert) {
            alerts.push(cached.alert)
          }
          continue
        }

        // Fetch historical data
        const candles = await this.getHistoricalData(symbol, 60)

        if (!candles) {
          continue
        }

        // Detect crossover
        const crossover = this.detectEMACrossover(symbol, candles)

        // Cache the result
        this.cache.set(cacheKey, {
          alert: crossover,
          timestamp: Date.now()
        })

        if (crossover) {
          alerts.push(crossover)
          console.log(`  ✓ ${crossover.message}`)
        }

        // Delay to respect API rate limits
        await new Promise(resolve => setTimeout(resolve, 1000))

      } catch (error) {
        console.error(`Error checking EMA crossover for ${symbol}:`, error.message)
      }
    }

    console.log(`📊 Found ${alerts.length} EMA crossover alerts`)
    return alerts
  }

  /**
   * Clear cache for a symbol or all symbols
   */
  clearCache(symbol = null) {
    if (symbol) {
      this.cache.delete(`ema-${symbol}`)
    } else {
      this.cache.clear()
    }
  }
}

export const emaAlertService = new EMAAlertService()
