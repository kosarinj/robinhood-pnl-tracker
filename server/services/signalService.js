import axios from 'axios'
import { generateSignal } from './technicalAnalysis.js'

const ALPHA_VANTAGE_KEY = 'AP5SJ1ZWGMM96NVB'

export class SignalService {
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

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000))
      } catch (error) {
        console.error(`Error fetching signal for ${symbol}:`, error)
      }
    }

    return signals
  }

  // Fetch intraday data from Alpha Vantage
  async getIntradayData(symbol) {
    // Check cache first
    const now = Date.now()
    const cached = this.dataCache.get(symbol)
    if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {
      return cached.data
    }

    try {
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${symbol}&interval=5min&apikey=${ALPHA_VANTAGE_KEY}`
      const response = await axios.get(url, { timeout: 10000 })

      if (response.data['Error Message']) {
        console.error(`Alpha Vantage error for ${symbol}:`, response.data['Error Message'])
        return null
      }

      if (response.data['Note']) {
        console.warn('Alpha Vantage API limit reached:', response.data['Note'])
        return null
      }

      const timeSeries = response.data['Time Series (5min)']
      if (!timeSeries) {
        console.warn(`No time series data for ${symbol}`)
        return null
      }

      // Convert to array format
      const data = Object.entries(timeSeries)
        .map(([timestamp, values]) => ({
          timestamp: new Date(timestamp),
          open: parseFloat(values['1. open']),
          high: parseFloat(values['2. high']),
          low: parseFloat(values['3. low']),
          close: parseFloat(values['4. close']),
          volume: parseInt(values['5. volume'])
        }))
        .sort((a, b) => a.timestamp - b.timestamp)

      // Cache the result
      this.dataCache.set(symbol, {
        data,
        timestamp: now
      })

      return data
    } catch (error) {
      console.error(`Error fetching intraday data for ${symbol}:`, error.message)
      return null
    }
  }
}
