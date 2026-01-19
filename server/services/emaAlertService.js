import axios from 'axios'
import { calculateEMA, calculateRSI } from './technicalAnalysis.js'

/**
 * Technical Alert Service - Detects EMA 9/21 crossovers and RSI overbought/oversold
 * Alerts when EMA 9 crosses above (Golden Cross) or below (Death Cross) EMA 21
 * Also alerts when RSI enters overbought (>70) or oversold (<30) territory
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
   * Detect RSI overbought/oversold conditions for a symbol
   * Returns null if RSI is neutral (30-70), or an object with RSI alert details
   */
  detectRSIAlert(symbol, candles) {
    if (!candles || candles.length < 15) {
      return null
    }

    // Get closing prices
    const prices = candles.map(c => c.close)

    // Calculate current RSI
    const rsi = calculateRSI(prices, 14)

    if (rsi === null) {
      return null
    }

    // Only alert for overbought (>70) or oversold (<30)
    let alertType = null
    let signal = null
    let message = null

    if (rsi >= 70) {
      alertType = 'overbought'
      signal = 'SELL'
      if (rsi >= 80) {
        message = `🔴 ${symbol}: RSI ${rsi.toFixed(0)} - Extremely Overbought (Strong sell signal)`
      } else {
        message = `🟠 ${symbol}: RSI ${rsi.toFixed(0)} - Overbought (Consider selling)`
      }
    } else if (rsi <= 30) {
      alertType = 'oversold'
      signal = 'BUY'
      if (rsi <= 20) {
        message = `🟢 ${symbol}: RSI ${rsi.toFixed(0)} - Extremely Oversold (Strong buy signal)`
      } else {
        message = `🟡 ${symbol}: RSI ${rsi.toFixed(0)} - Oversold (Consider buying)`
      }
    }

    if (!alertType) {
      return null
    }

    const currentPrice = candles[candles.length - 1].close

    return {
      symbol,
      type: `rsi_${alertType}`,
      signal,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      rsi: parseFloat(rsi.toFixed(2)),
      timestamp: Date.now(),
      message
    }
  }

  /**
   * Check for EMA crossovers and RSI alerts across multiple symbols
   * Returns array of alerts for symbols with recent crossovers or RSI extremes
   */
  async checkEMACrossovers(symbols) {
    const alerts = []

    console.log(`🔍 Checking EMA crossovers and RSI alerts for ${symbols.length} symbols...`)

    for (const symbol of symbols) {
      try {
        // Check cache first
        const emaCacheKey = `ema-${symbol}`
        const rsiCacheKey = `rsi-${symbol}`
        const emaCached = this.cache.get(emaCacheKey)
        const rsiCached = this.cache.get(rsiCacheKey)

        const now = Date.now()
        const emaValid = emaCached && now - emaCached.timestamp < this.cacheDuration
        const rsiValid = rsiCached && now - rsiCached.timestamp < this.cacheDuration

        if (emaValid && rsiValid) {
          if (emaCached.alert) alerts.push(emaCached.alert)
          if (rsiCached.alert) alerts.push(rsiCached.alert)
          continue
        }

        // Fetch historical data
        const candles = await this.getHistoricalData(symbol, 60)

        if (!candles) {
          continue
        }

        // Detect EMA crossover
        const crossover = this.detectEMACrossover(symbol, candles)
        this.cache.set(emaCacheKey, {
          alert: crossover,
          timestamp: Date.now()
        })
        if (crossover) {
          alerts.push(crossover)
          console.log(`  ✓ ${crossover.message}`)
        }

        // Detect RSI alert
        const rsiAlert = this.detectRSIAlert(symbol, candles)
        this.cache.set(rsiCacheKey, {
          alert: rsiAlert,
          timestamp: Date.now()
        })
        if (rsiAlert) {
          alerts.push(rsiAlert)
          console.log(`  ✓ ${rsiAlert.message}`)
        }

        // Delay to respect API rate limits
        await new Promise(resolve => setTimeout(resolve, 1000))

      } catch (error) {
        console.error(`Error checking alerts for ${symbol}:`, error.message)
      }
    }

    const emaAlerts = alerts.filter(a => a.type.includes('cross'))
    const rsiAlerts = alerts.filter(a => a.type.includes('rsi'))
    console.log(`📊 Found ${emaAlerts.length} EMA crossover alerts and ${rsiAlerts.length} RSI alerts`)
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
