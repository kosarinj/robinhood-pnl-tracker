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

/**
 * Which US market session we're in, from the clock alone.
 *
 * Deliberately avoids a network call: this is used to decide *whether* to make
 * the extended-hours requests at all, so deriving it from a request would defeat
 * the purpose. Holidays aren't accounted for — on one, this reports 'pre' or
 * 'regular' and the extended-hours fetch simply finds no new bars and falls back.
 */
export function currentUsSession(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()
  if (day === 0 || day === 6) return 'closed'
  const mins = et.getHours() * 60 + et.getMinutes()
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'pre'
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'regular'
  if (mins >= 16 * 60 && mins < 20 * 60) return 'post'
  return 'closed'
}

/**
 * Pull the current extended-hours price out of a Yahoo v8 chart result.
 *
 * Pure so the session logic is testable at any hour. `nowSec` is unix seconds.
 * Returns { price, session, regularClose, prevClose, asOf, stale } or null.
 *
 * session is 'pre' | 'post' | 'regular' | 'closed', taken from Yahoo's own
 * currentTradingPeriod windows so holidays and half-days come along for free.
 *
 * The bar is filtered to the *current* session's window. A 1d chart still
 * carries the prior session's bars, so without that filter a 4:05am request
 * would happily return yesterday's 7:59pm print as if it were this morning's.
 */
export function parseExtendedHoursChart(result, nowSec) {
  if (!result) return null
  const meta = result.meta || {}
  const ts = result.timestamp || []
  const closes = result.indicators?.quote?.[0]?.close || []
  const period = meta.currentTradingPeriod || {}

  const inWindow = w => w && nowSec >= w.start && nowSec < w.end
  let session = 'closed'
  if (inWindow(period.regular)) session = 'regular'
  else if (inWindow(period.pre)) session = 'pre'
  else if (inWindow(period.post)) session = 'post'

  const windowStart = session === 'pre' ? period.pre?.start
                    : session === 'post' ? period.post?.start
                    : session === 'regular' ? period.regular?.start
                    : null

  let price = 0, asOf = null
  for (let i = closes.length - 1; i >= 0; i--) {
    if (ts[i] > nowSec) continue                       // ignore bars ahead of "now"
    if (windowStart != null && ts[i] < windowStart) break   // fell out of this session
    if (closes[i] == null) continue
    price = closes[i]; asOf = ts[i]
    break
  }

  const regularClose = meta.regularMarketPrice || 0
  // No trade in this session yet (common right at 4:05am) — fall back to the
  // regular close and flag it, so callers can say "no extended-hours trade".
  const stale = !(price > 0)
  if (stale) price = regularClose
  if (!(price > 0)) return null

  return {
    price,
    session,
    regularClose,
    prevClose: meta.chartPreviousClose || meta.previousClose || 0,
    asOf: asOf ? asOf * 1000 : null,
    stale,
  }
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

    // Outside regular hours the spark endpoint is stale — its meta.regularMarketPrice
    // holds the last regular-session price and its bars stop at 4pm, and it ignores
    // includePrePost. So pre/post market, overlay the real extended-hours price from
    // the v8 chart endpoint (one request per symbol, hence only when it matters).
    const session = currentUsSession()
    if (session === 'pre' || session === 'post') {
      try {
        const ext = await this.fetchExtendedHoursCached(symbols)
        let moved = 0
        for (const sym of symbols) {
          const e = ext[sym]
          // `stale` means no extended-hours trade has printed yet — keep the close.
          if (e && e.price > 0 && !e.stale) {
            prices[sym] = e.price
            this._cachePrice(sym, e.price)
            moved++
          }
        }
        console.log(`fetchPrices (${session}-market overlay): ${moved}/${symbols.length} updated`)
      } catch (e) {
        console.warn('Extended-hours overlay failed, keeping regular-session prices:', e.message)
      }
    }

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

  /**
   * fetchExtendedHours with a short TTL.
   *
   * The chart endpoint costs one request per symbol and the price loop runs
   * often; Yahoo returns 429 if you lean on it. Extended-hours prints are
   * sparse anyway, so a short cache loses nothing real.
   */
  async fetchExtendedHoursCached(symbols, ttlMs = 60000) {
    const now = Date.now()
    if (!this._extCache) this._extCache = new Map()

    const fresh = {}
    const stale = []
    for (const s of symbols) {
      const hit = this._extCache.get(s)
      if (hit && now - hit.at < ttlMs) fresh[s] = hit.value
      else stale.push(s)
    }
    if (stale.length) {
      const fetched = await this.fetchExtendedHours(stale)
      for (const s of stale) {
        if (fetched[s]) {
          this._extCache.set(s, { at: now, value: fetched[s] })
          fresh[s] = fetched[s]
        }
      }
    }
    return fresh
  }

  // See parseExtendedHoursChart (module scope) — kept separate so the session
  // logic can be tested without waiting for 4am.
  //
  // Extended-hours (pre/post market) prices. The v7/finance/quote endpoint that
  // carries preMarketPrice now 401s, so this uses the v8 chart endpoint with
  // includePrePost=true and reads the last bar outside the regular session.
  // One request per symbol — only call it for tickers with open option positions.
  //
  // Returns { SYMBOL: { price, session, regularClose, prevClose, asOf, stale } }
  // where session is 'pre' | 'post' | 'regular' | 'closed'. `price` is the best
  // current underlying for that session; during 'regular' it's just the live price.
  async fetchExtendedHours(symbols) {
    const out = {}
    if (!symbols || symbols.length === 0) return out
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }
    for (const symbol of symbols) {
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                    `?range=1d&interval=5m&includePrePost=true`
        const resp = await axios.get(url, { timeout: 12000, headers })
        const result = resp.data?.chart?.result?.[0]
        if (!result) continue
        const parsed = parseExtendedHoursChart(result, Math.floor(Date.now() / 1000))
        if (parsed) out[symbol] = parsed
      } catch (err) {
        console.warn(`Extended-hours fetch failed for ${symbol}:`, err.response?.status || err.message)
      }
      await new Promise(r => setTimeout(r, 120))   // gentle on Yahoo
    }
    return out
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
        const today = new Date().toISOString().slice(0, 10)
        results.forEach(item => {
          const resp0 = item.response?.[0]
          const meta = resp0?.meta || {}
          const ts = resp0?.timestamp || []
          const closesAll = resp0?.indicators?.quote?.[0]?.close || []
          // Pair each daily close with its bar timestamp so we can pick YESTERDAY's close,
          // not some earlier day. (Do NOT use meta.chartPreviousClose — that's the close
          // just before the whole range window, i.e. ~5 days ago, which badly overstates
          // the daily move.)
          const bars = ts.map((t, i) => ({ t, c: closesAll[i] })).filter(b => b.c != null && b.c > 0)
          if (bars.length < 2) return
          const current = meta.regularMarketPrice > 0 ? meta.regularMarketPrice : bars[bars.length - 1].c
          const lastDate = new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10)
          // If the last bar is today's (forming) session, yesterday's close is the bar before it.
          // If today's bar isn't there yet (pre-market), the last bar IS the prior close.
          const prevClose = lastDate === today ? bars[bars.length - 2].c : bars[bars.length - 1].c
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

    // Fall back to the v8 chart endpoint for anything spark didn't answer for.
    //
    // spark is on the v7 family, which Yahoo has been progressively closing —
    // v7/finance/quote already 401s, which is what broke Current Stock in the
    // short-call tracker. When this returns nothing the caller has no daily
    // price, and Day P&L was then published from the option side alone, which
    // inverts the sign on a down day. v8/chart is what the rest of the app
    // relies on; it answers per symbol, so it costs a call each but only for
    // the ones actually missing.
    const missing = symbols.filter(s => !result[s])
    for (const symbol of missing) {
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`
        const resp = await axios.get(url, { timeout: 12000, headers })
        const r0 = resp.data?.chart?.result?.[0]
        const meta = r0?.meta || {}
        const ts = r0?.timestamp || []
        const closes = r0?.indicators?.quote?.[0]?.close || []
        const bars = ts.map((t, i) => ({ t, c: closes[i] })).filter(b => b.c > 0)
        if (bars.length < 2) continue
        const today = new Date().toISOString().slice(0, 10)
        const current = meta.regularMarketPrice > 0 ? meta.regularMarketPrice : bars[bars.length - 1].c
        const lastDate = new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10)
        // Same rule as above: if today's forming bar is present, yesterday's
        // close is the one before it.
        const prevClose = lastDate === today ? bars[bars.length - 2].c : bars[bars.length - 1].c
        if (current > 0 && prevClose > 0) {
          result[symbol] = {
            current,
            prevClose,
            change: Math.round((current - prevClose) * 100) / 100,
            pct: Math.round(((current - prevClose) / prevClose) * 10000) / 100,
          }
        }
      } catch (err) {
        console.warn(`Daily change fallback failed for ${symbol}:`, err.response?.status || err.message)
      }
    }
    if (missing.length) {
      const stillMissing = symbols.filter(s => !result[s])
      console.log(`Daily change: spark missed ${missing.length}, chart recovered ${missing.length - stillMissing.length}` +
        (stillMissing.length ? `, still missing ${stillMissing.join(',')}` : ''))
    }
    // Same overlay fetchPrices does. The spark meta holds the last REGULAR
    // session price, so pre-market `current` comes back equal to prevClose and
    // the day move computes to zero — Day Stock shows nothing while Day Options,
    // priced from Polygon quotes, moves. Two sources for one row is exactly the
    // split that made a partial day publishable before.
    const session = currentUsSession()
    if (session === 'pre' || session === 'post') {
      try {
        const ext = await this.fetchExtendedHoursCached(symbols)
        for (const sym of Object.keys(result)) {
          const e = ext[sym]
          // `stale` means nothing has printed outside the session yet.
          if (e && e.price > 0 && !e.stale) {
            const prevClose = result[sym].prevClose
            result[sym] = {
              current: e.price,
              prevClose,
              change: Math.round((e.price - prevClose) * 100) / 100,
              pct: Math.round(((e.price - prevClose) / prevClose) * 10000) / 100,
            }
          }
        }
      } catch (err) {
        console.warn('fetchDailyChange extended-hours overlay failed:', err.message)
      }
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
