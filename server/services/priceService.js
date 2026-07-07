import axios from 'axios'

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

const PRICE_CACHE_TTL_MS = 4 * 60 * 1000 // 4 minutes

// Cached Polygon grouped daily bars (one fetch covers all stocks)
let polygonGroupedCache = null       // Map: ticker → close price
let polygonGroupedCacheDate = null   // date string the cache was loaded for
let polygonGroupedCacheTime = 0      // epoch ms when loaded

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchPolygonGrouped(apiKey) {
  const now = Date.now()
  // Reuse cache if loaded in the last 30 minutes
  if (polygonGroupedCache && (now - polygonGroupedCacheTime) < 30 * 60 * 1000) {
    return polygonGroupedCache
  }
  // Build candidate dates: today back up to 7 days, skipping weekends (no data on Sat/Sun).
  // This plan returns the most recent COMPLETED trading day — today is often 403 (not entitled
  // to the current day) and holidays return 0 results, so we walk back to the latest real close.
  const tryDates = []
  for (let d = 0; d <= 7 && tryDates.length < 5; d++) {
    const dt = new Date(now - d * 86400000)
    const dow = dt.getUTCDay()
    if (dow === 0 || dow === 6) continue // skip Sun/Sat
    tryDates.push(dt.toISOString().slice(0, 10))
  }
  for (let i = 0; i < tryDates.length; i++) {
    const date = tryDates[i]
    try {
      const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${apiKey}`
      const resp = await axios.get(url, { timeout: 15000 })
      if ((resp.data?.resultsCount || 0) > 0) {
        const map = new Map()
        ;(resp.data.results || []).forEach(r => { if (r.T && r.c > 0) map.set(r.T, r.c) })
        polygonGroupedCache = map
        polygonGroupedCacheDate = date
        polygonGroupedCacheTime = now
        console.log(`Polygon grouped prices loaded: ${map.size} symbols for ${date}`)
        return map
      }
      // resultsCount 0 = market holiday; fall through to the previous day
    } catch (e) {
      const status = e.response?.status
      if (status === 429) {
        // Rate limited — wait and retry the same date (don't skip a valid trading day)
        console.warn(`Polygon grouped ${date}: rate limited (429), waiting 13s to retry`)
        await sleep(13000)
        i--
        continue
      }
      // 403 = not entitled to that day (expected for the current trading day); just try the prior day
      if (status !== 403) console.warn(`Polygon grouped fetch for ${date} failed:`, status, e.message)
    }
    // Space out calls to avoid tripping Polygon's burst rate limit
    await sleep(1200)
  }
  return polygonGroupedCache || new Map()
}

export class PriceService {
  constructor(databaseService = null) {
    this.priceCache = new Map()   // symbol → price
    this.priceCacheTime = new Map() // symbol → timestamp
    this.preMarketCache = new Map() // symbol → { price, changePercent }
    this.marketStateCache = new Map() // symbol → marketState
    this.prevCloseCache = new Map() // symbol → previousClose
    this.regularMarketPriceCache = new Map() // symbol → regularMarketPrice (actual close, not pre/post adjusted)
    this.trackedSymbols = new Set()
    this.lastUpdate = null
    this.databaseService = databaseService
  }

  // Get pre-market prices for given symbols (from cache populated by fetchPrices)
  getPreMarketPrices(symbols) {
    const result = {}
    symbols.forEach(sym => {
      const pre = this.preMarketCache.get(sym)
      const state = this.marketStateCache.get(sym)
      if (pre) result[sym] = { ...pre, marketState: state }
    })
    return result
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

  // Get regular market prices (actual close, not pre/post adjusted) for given symbols
  getRegularMarketPrices(symbols) {
    const result = {}
    symbols.forEach(sym => {
      const p = this.regularMarketPriceCache.get(sym)
      if (p != null) result[sym] = p
    })
    return result
  }

  // Get previous close prices for given symbols (from cache)
  getPreviousClose(symbols) {
    const result = {}
    symbols.forEach(sym => {
      const pc = this.prevCloseCache.get(sym)
      if (pc != null) result[sym] = pc
    })
    return result
  }

  // Check if a cached price is still fresh
  _isFresh(symbol) {
    const t = this.priceCacheTime.get(symbol)
    return t && (Date.now() - t) < PRICE_CACHE_TTL_MS
  }

  // Store a price in cache with timestamp
  _cachePrice(symbol, price) {
    this.priceCache.set(symbol, price)
    this.priceCacheTime.set(symbol, Date.now())
  }

  // Get price for a single symbol (fetch if not cached or stale)
  async getPrice(symbol) {
    if (this._isFresh(symbol)) {
      return this.priceCache.get(symbol)
    }

    const prices = await this.fetchPrices([symbol])
    return prices[symbol] || 0
  }

  // Get prices for multiple symbols (uses cache if fresh)
  async getPrices(symbols) {
    const prices = {}
    const symbolsToFetch = []

    // Check cache first
    symbols.forEach(symbol => {
      if (this._isFresh(symbol)) {
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

  // Fetch CURRENT prices — Yahoo "spark" bulk endpoint first (intraday, works from datacenter
  // IPs without a crumb), then Polygon grouped daily bars as an end-of-day fallback.
  // NOTE: Yahoo's v7/finance/quote endpoint now returns 401 (requires crumb/cookie auth), which
  // is why prices stopped updating; the spark + v8 chart endpoints still work.
  async fetchPrices(symbols) {
    const prices = {}
    if (symbols.length === 0) return prices

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }

    const batchSize = 50
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize)
      try {
        const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.join(',')}&range=1d&interval=5m`
        const response = await axios.get(url, { timeout: 12000, headers })
        const results = response.data?.spark?.result || []
        results.forEach(item => {
          const sym = item.symbol
          const resp0 = item.response?.[0]
          const meta = resp0?.meta || {}
          // meta.regularMarketPrice is the live/intraday price; fall back to last non-null close
          let price = meta.regularMarketPrice
          if (!(price > 0)) {
            const closes = resp0?.indicators?.quote?.[0]?.close || []
            for (let k = closes.length - 1; k >= 0; k--) { if (closes[k] != null) { price = closes[k]; break } }
          }
          if (meta.chartPreviousClose) this.prevCloseCache.set(sym, meta.chartPreviousClose)
          if (meta.regularMarketPrice) this.regularMarketPriceCache.set(sym, meta.regularMarketPrice)
          if (price > 0) { prices[sym] = price; this._cachePrice(sym, price) }
        })
      } catch (err) {
        console.warn(`Yahoo spark batch ${i / batchSize + 1} failed:`, err.response?.status || err.message)
      }
      if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 400))
    }

    const gotYahoo = symbols.filter(s => prices[s] > 0).length
    console.log(`fetchPrices (Yahoo spark): ${gotYahoo}/${symbols.length} intraday`)

    // Fill any gaps (Yahoo missed/blocked) with Polygon end-of-day closes
    const missing = symbols.filter(s => !(prices[s] > 0))
    if (missing.length > 0 && process.env.POLYGON_API_KEY) {
      try {
        const grouped = await fetchPolygonGrouped(process.env.POLYGON_API_KEY)
        missing.forEach(sym => {
          const price = grouped.get(sym) || 0
          if (price > 0) { prices[sym] = price; this._cachePrice(sym, price) }
        })
        const filled = missing.filter(s => prices[s] > 0).length
        console.log(`fetchPrices (Polygon grouped/${polygonGroupedCacheDate} fallback): filled ${filled}/${missing.length}`)
      } catch (e) {
        console.warn('Polygon grouped fallback failed:', e.message)
      }
    }

    // Ensure every requested symbol has an entry (0 = unknown)
    symbols.forEach(sym => { if (prices[sym] === undefined) { prices[sym] = 0; this._cachePrice(sym, 0) } })
    return prices
  }

  // Weekly change per symbol — uses Yahoo "spark" 5-day daily series (one bulk call per batch).
  // Returns { SYMBOL: { current, weekAgo, change, pct } } where pct is % change over ~1 week.
  async fetchWeeklyChange(symbols) {
    const result = {}
    if (!symbols || symbols.length === 0) return result
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }
    const batchSize = 50
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize)
      try {
        const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.join(',')}&range=5d&interval=1d`
        const response = await axios.get(url, { timeout: 12000, headers })
        const results = response.data?.spark?.result || []
        results.forEach(item => {
          const resp0 = item.response?.[0]
          const meta = resp0?.meta || {}
          const closes = (resp0?.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0)
          if (closes.length < 2) return
          const weekAgo = closes[0]
          const current = meta.regularMarketPrice > 0 ? meta.regularMarketPrice : closes[closes.length - 1]
          if (weekAgo > 0 && current > 0) {
            result[item.symbol] = {
              current,
              weekAgo,
              change: Math.round((current - weekAgo) * 100) / 100,
              pct: Math.round(((current - weekAgo) / weekAgo) * 10000) / 100,
            }
          }
        })
      } catch (err) {
        console.warn(`Weekly change batch ${i / batchSize + 1} failed:`, err.response?.status || err.message)
      }
      if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 400))
    }
    return result
  }

  // Per-ticker 1-day change: prior trading-day close → current price. Used for the
  // "Day P&L" column (mark-to-market move since yesterday's EOD close).
  async fetchDailyChange(symbols) {
    const result = {}
    if (!symbols || symbols.length === 0) return result
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }
    const batchSize = 50
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize)
      try {
        const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.join(',')}&range=5d&interval=1d`
        const response = await axios.get(url, { timeout: 12000, headers })
        const results = response.data?.spark?.result || []
        results.forEach(item => {
          const resp0 = item.response?.[0]
          const meta = resp0?.meta || {}
          const closes = (resp0?.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0)
          const current = meta.regularMarketPrice > 0 ? meta.regularMarketPrice : (closes.length ? closes[closes.length - 1] : 0)
          // Prior trading-day close: prefer the meta previous-close; fall back to the
          // second-to-last daily close so we still get a value pre-market.
          let prevClose = meta.previousClose > 0 ? meta.previousClose : (meta.chartPreviousClose > 0 ? meta.chartPreviousClose : 0)
          if (!(prevClose > 0) && closes.length >= 2) prevClose = closes[closes.length - 2]
          if (current > 0 && prevClose > 0) {
            result[item.symbol] = {
              current,
              prevClose,
              change: Math.round((current - prevClose) * 100) / 100,
              pct: Math.round(((current - prevClose) / prevClose) * 10000) / 100,
            }
          }
        })
      } catch (err) {
        console.warn(`Daily change batch ${i / batchSize + 1} failed:`, err.response?.status || err.message)
      }
      if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 400))
    }
    return result
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
      const isToday = dateString === new Date().toISOString().slice(0, 10)
      // Only use DB cache for dates older than 14 days — recent closes can change
      // (intraday caching, API fallbacks) and must always be re-fetched fresh.
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const isRecent = dateString >= twoWeeksAgo
      if (this.databaseService && !isToday && !isRecent) {
        const cachedPrice = this.databaseService.getHistoricalPrice(symbol, dateString)
        if (cachedPrice !== null) {
          console.log(`✓ ${symbol} price for ${dateString} from cache: $${cachedPrice}`)
          return cachedPrice
        }
      }

      // Use UTC-based date arithmetic throughout to avoid local-timezone off-by-one.
      // new Date("YYYY-MM-DD") parses as UTC midnight; mixing with setHours() (local)
      // shifts the target by the UTC offset and matches the wrong trading day.
      const [ty, tm, td] = dateString.split('-').map(Number)
      const targetMs = Date.UTC(ty, tm - 1, td)

      // Fetch 1 week of data around the target date to handle weekends/holidays
      const period1 = Math.floor((targetMs - 3 * 86400000) / 1000)
      const period2 = Math.floor((targetMs + 4 * 86400000) / 1000)

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

      // Find closest trading day using UTC date strings to avoid timezone drift
      let closestIndex = 0
      let closestDiff = Infinity

      timestamps.forEach((ts, i) => {
        const dataDateStr = new Date(ts * 1000).toISOString().slice(0, 10)
        const [dy, dm, dd] = dataDateStr.split('-').map(Number)
        const diff = Math.abs(Date.UTC(dy, dm - 1, dd) - targetMs)
        if (diff < closestDiff && quotes.close[i] !== null) {
          closestDiff = diff
          closestIndex = i
        }
      })

      // During market hours today's close bar is null — use regularMarketPrice from meta instead
      const closingPrice = (isToday && quotes.close[closestIndex] == null && result.meta?.regularMarketPrice)
        ? result.meta.regularMarketPrice
        : quotes.close[closestIndex]
      const actualDate = new Date(timestamps[closestIndex] * 1000).toISOString().slice(0, 10)

      // Save to DB cache for historical dates only — never cache today's price
      if (this.databaseService && closingPrice && !isToday) {
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
      return 0
    }
  }

  // Fetch intraday 5-minute bars for today with running VWAP
  async fetchIntradayData(symbol) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=5m`
      const response = await axios.get(url, { timeout: 10000, headers: YF_HEADERS })

      const result = response.data?.chart?.result?.[0]
      if (!result) throw new Error('No intraday data')

      const timestamps = result.timestamp || []
      const quotes = result.indicators?.quote?.[0]
      if (!quotes || timestamps.length === 0) throw new Error('No intraday quotes')

      let cumPV = 0, cumVol = 0
      const bars = []

      timestamps.forEach((ts, i) => {
        const open = quotes.open[i]
        const high = quotes.high[i]
        const low = quotes.low[i]
        const close = quotes.close[i]
        const volume = quotes.volume[i]
        if (close == null || volume == null) return

        const typical = ((high ?? close) + (low ?? close) + close) / 3
        cumPV += typical * volume
        cumVol += volume
        const vwap = cumVol > 0 ? Math.round((cumPV / cumVol) * 100) / 100 : null

        bars.push({
          time: ts * 1000,
          label: new Date(ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }),
          open: open ? Math.round(open * 100) / 100 : null,
          high: high ? Math.round(high * 100) / 100 : null,
          low: low ? Math.round(low * 100) / 100 : null,
          close: Math.round(close * 100) / 100,
          volume,
          vwap
        })
      })

      console.log(`✓ Fetched ${bars.length} intraday bars for ${symbol}`)
      return bars
    } catch (error) {
      console.error(`✗ Failed to fetch intraday data for ${symbol}:`, error.message)
      return []
    }
  }

  // Get closing prices for multiple symbols on a specific date
  async getPricesForDate(symbols, dateString) {
    const prices = {}
    const symbolsToFetch = []
    const isToday = dateString === new Date().toISOString().slice(0, 10)

    // Skip DB cache for today or recent dates (last 14 days) — always fetch fresh
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const isRecent = dateString >= twoWeeksAgo
    if (this.databaseService && !isToday && !isRecent) {
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
