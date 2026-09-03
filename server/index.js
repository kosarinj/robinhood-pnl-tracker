import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import multer from 'multer'
import { parseTrades, parseDeposits } from './services/csvParser.js'
import { calculatePnL } from './services/pnlCalculator.js'
import { PriceService } from './services/priceService.js'
import { SignalService } from './services/signalService.js'
import { PolygonService } from './services/polygonService.js'
import { databaseService, dbPath, VOLUME_CANDIDATES } from './services/database.js'
import { authService } from './services/auth.js'
import { supportResistanceService } from './services/supportResistanceService.js'
import { emaAlertService } from './services/emaAlertService.js'
import cookieParser from 'cookie-parser'
import { SP500 } from './sp500.js'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import path from 'path'
import axios from 'axios'
import { parseOptionDescription, toPolygonTicker, calcPremiumLeft, toYahooOptionTicker } from './utils/optionUtils.js'
import { calculateRSI, calculateEMA, calculateStochastic } from './services/technicalAnalysis.js'
import { RISK_FREE_RATE, bsCall, impliedVol, impliedVolCall, repriceFromClose } from './utils/blackScholes.js'
import { parseWebullOrders } from './services/webullParser.js'
import { parseSchwabTransactions } from './services/schwabParser.js'

// Brokers whose exports we can parse. Adding one means a parser + a tab.
const SUPPORTED_BROKERS = ['robinhood', 'webull', 'schwab']

// Best current per-share mark from a Polygon option snapshot.
// Priority: live quote midpoint → a trade that actually happened TODAY → the daily
// close (updates every session) → any last trade as a final resort. This stops
// illiquid LEAPs (no live quote, e.g. MRVL/CRWV) from freezing on a stale last_trade,
// while still preferring a fresh quote/trade when one exists. Returns 0 if unknown.
function optionMarkFromSnapshot(snap) {
  if (!snap) return 0
  const q = snap.last_quote || {}
  const qMid = q.midpoint || (q.bid && q.ask ? (q.bid + q.ask) / 2 : 0)
  if (qMid > 0) return qMid
  const ltPrice = snap.last_trade?.price || 0
  const rawTs = snap.last_trade?.sip_timestamp ?? snap.last_trade?.t ?? 0
  const ltMs = rawTs ? (rawTs > 1e15 ? rawTs / 1e6 : rawTs) : 0 // ns→ms when needed
  const ltDate = ltMs ? new Date(ltMs).toISOString().slice(0, 10) : ''
  const today = new Date().toISOString().slice(0, 10)
  if (ltPrice > 0 && ltDate === today) return ltPrice
  const dayClose = snap.day?.close || 0
  if (dayClose > 0) return dayClose
  return ltPrice
}

// A real live quote midpoint — the only truly "current" market signal. Returns 0
// when the data plan doesn't serve option quotes (common here). Callers then fall
// back to the Black–Scholes model mark so every contract is priced consistently,
// rather than mixing smooth model marks with jumpy single-trade prints.
/**
 * The most current MARKET price for a contract: a live quote midpoint, or
 * failing that a trade that printed TODAY.
 *
 * The today's-trade half was removed on 2026-07-01 (dfd58ae) so every contract
 * would price through one smooth model rather than mixing in "jumpy" single
 * prints. That was explicitly a bet that "a real quote still wins automatically
 * if the plan is upgraded" — and the plan answers /v3/quotes with 403 Not
 * Entitled, so the quote never arrives and this function could only ever return
 * 0. The model became the primary mark by accident rather than by choice.
 *
 * A print from today is real market data about this contract. A model is an
 * inference from the underlying. Preferring the inference to the observation,
 * because the observation is occasionally jumpy, is the wrong way round — and it
 * is what 66d2ddb found first, when a modelled MRVL LEAP read 74 against a live 86.
 *
 * A print from an EARLIER day is NOT covered here: that is a frozen number, and
 * staleOptionMark handles it below the model, which is right.
 */
function freshOptionMark(snap) {
  if (!snap) return 0
  const q = snap.last_quote || {}
  const qMid = q.midpoint || (q.bid && q.ask ? (q.bid + q.ask) / 2 : 0)
  if (qMid > 0) return qMid
  const lt = snap.last_trade || {}
  const price = lt.price || 0
  if (!(price > 0)) return 0
  // Polygon sends nanoseconds; older payloads used `t` in milliseconds.
  const rawTs = lt.sip_timestamp ?? lt.participant_timestamp ?? lt.t ?? 0
  if (!rawTs) return 0
  const ms = Number(rawTs) > 1e15 ? Number(rawTs) / 1e6 : Number(rawTs)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return new Date(ms).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
    ? price : 0
}
function staleOptionMark(snap) {
  if (!snap) return 0
  return (snap.day?.close || 0) || (snap.last_trade?.price || 0)
}

/**
 * Did this contract actually print TODAY?
 *
 * A close from today is a real market price and beats any model of it. A close
 * from three weeks ago is a frozen number that says nothing about now, and the
 * model — which at least tracks the underlying — is better. Both arrive in the
 * same `day.close` field, so without a timestamp they were treated alike and a
 * contract that had traded this morning still got modelled.
 *
 * Polygon timestamps are nanoseconds since epoch.
 */
/**
 * The date of the snapshot's daily bar, or null.
 *
 * A stale close is only interpretable if you know WHEN it was — the same $76.25
 * means different things four days and four months ago.
 */
function marketMarkDate(snap) {
  const ns = snap?.day?.last_updated || snap?.last_trade?.sip_timestamp
    || snap?.last_trade?.participant_timestamp || 0
  if (!ns) return null
  const ms = Number(ns) / 1e6
  if (!Number.isFinite(ms) || ms <= 0) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function marketMarkIsToday(snap) {
  if (!snap) return false
  const ns = snap.last_trade?.sip_timestamp || snap.last_trade?.participant_timestamp
    || snap.day?.last_updated || 0
  if (!ns) return false
  const ms = Number(ns) / 1e6
  if (!Number.isFinite(ms) || ms <= 0) return false
  const d = new Date(ms)
  return d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
}
// Real bid/ask midpoint from Polygon's dedicated quotes endpoint. On the Options
// Starter (delayed) plan the snapshot's last_quote is null, but /v3/quotes still
// serves the (15-min delayed) NBBO — this is the actual market mid. Returns 0 if
// unavailable (no quote, or key not entitled → caller falls back to the model).
/**
 * Allocate a symbol's netted open short position across its sale entries.
 *
 * short_call_entries is a log of SALES, not a position. Buy some back and the
 * entries still total what was sold, so sizing exposure from them overstates a
 * partly-closed position — HOOD showed 3 contracts against an actual 2 and its
 * Day P&L came out half again too large.
 *
 * Newest sale first, because a re-sold contract is the position held now; the
 * older entry it replaced is the one that was closed. A partly-covered entry
 * keeps the part still open rather than being dropped — half a position is
 * still a position.
 *
 * Returns { [entryId]: openContracts }. Entries past the allocation get 0.
 *
 * /api/short-calls worked this out first and the other two callers kept an
 * older rescale that only fired for single-entry symbols and only corrected
 * undercounts. This is that logic, shared, so the tracker and the P&L figures
 * can't drift apart again.
 */
function allocateOpenShortContracts(entries, openShortSymbols, netShortBySymbol) {
  const openContractsByEntry = {}
  const bySymbol = {}
  entries.forEach(e => {
    if (!openShortSymbols.has(e.symbol)) return
    ;(bySymbol[e.symbol] = bySymbol[e.symbol] || []).push(e)
  })
  Object.entries(bySymbol).forEach(([sym, list]) => {
    let remaining = netShortBySymbol[sym] || 0
    list
      .slice()
      .sort((a, b) => String(b.sale_date || '').localeCompare(String(a.sale_date || '')) || (b.id - a.id))
      .forEach(e => {
        const want = Math.abs(e.contracts || 1)
        const take = Math.max(0, Math.min(want, remaining))
        openContractsByEntry[e.id] = take
        remaining -= take
      })
  })
  return openContractsByEntry
}

async function fetchOptionQuoteMid(polygonTicker, polygonKey) {
  const q = await fetchOptionQuote(polygonTicker, polygonKey)
  return q.mid
}

/**
 * Both sides of the quote, not just the middle.
 *
 * The mid is the convention for valuing a position, but it isn't a price anyone
 * will trade at: closing a SHORT means paying the ask, closing a LONG means
 * taking the bid. On a wide spread those differ from the mid by real money, so
 * the exit column needs the sides kept rather than averaged away.
 */
/**
 * Why quote fetching is failing, if it is.
 *
 * This used to swallow every error into { mid: 0 }, which is indistinguishable
 * from a contract that simply has no quote. So when option quotes stopped coming
 * back entirely, nothing said so — every mark quietly fell through to the model
 * or to two daily prints, which is the exact condition that has produced wrong
 * day figures here before. A silent dependency failure is worse than a loud one.
 */
const optionQuoteHealth = {
  attempts: 0, withQuote: 0, empty: 0, errors: 0,
  lastStatus: null, lastError: null, lastErrorAt: null, lastOkAt: null,
}

async function fetchOptionQuote(polygonTicker, polygonKey) {
  optionQuoteHealth.attempts++
  try {
    const url = `https://api.polygon.io/v3/quotes/${polygonTicker}`
    const resp = await axios.get(url, { params: { apiKey: polygonKey, limit: 1, order: 'desc', sort: 'timestamp' }, timeout: 6000 })
    const q = resp.data?.results?.[0]
    if (!q) {
      // A 200 with no results. On an unentitled key Polygon answers this way
      // rather than refusing, so it looks like an illiquid contract.
      optionQuoteHealth.empty++
      optionQuoteHealth.lastStatus = resp.data?.status || 'no results'
      return { mid: 0, bid: 0, ask: 0 }
    }
    const bid = q.bid_price || 0, ask = q.ask_price || 0
    const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask || 0)
    optionQuoteHealth.withQuote++
    optionQuoteHealth.lastOkAt = new Date().toISOString()
    return { mid, bid, ask }
  } catch (e) {
    optionQuoteHealth.errors++
    optionQuoteHealth.lastStatus = e.response?.status || null
    // NOT_AUTHORIZED here means the key has no options-quotes entitlement.
    optionQuoteHealth.lastError = e.response?.data?.message || e.response?.data?.error || e.message
    optionQuoteHealth.lastErrorAt = new Date().toISOString()
    return { mid: 0, bid: 0, ask: 0 }
  }
}

// ── Black–Scholes marking (math lives in utils/blackScholes.js) ──
const round2 = v => Math.round((Number(v) || 0) * 100) / 100
// Model mark for a short call: anchor the implied vol to what you sold it for
// (premium vs the underlying on the sale date), then reprice at the current
// underlying and remaining time. Moves with the stock + decays — an estimate,
// used only when there's no live quote. Returns 0 when inputs are missing.
// asOfDate (YYYY-MM-DD) prices the mark as of a past date instead of today —
// used by the "as of" point-in-time view. Defaults to today when omitted.
function modelOptionMark(entry, parsed, underlyingNow, asOfDate = null) {
  try {
    if (!parsed || !(underlyingNow > 0)) return 0
    const contracts = entry.contracts || 1
    const premiumPerShare = entry.premium / (contracts * 100)
    const Sat = Number(entry.underlying_close)
    const saleDate = entry.sale_date
    const K = parsed.strike
    if (!(premiumPerShare > 0) || !(Sat > 0) || !saleDate || !(K > 0)) return 0
    const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
    const r = 0.045
    const yrs = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / (365.25 * 24 * 3600 * 1000)
    const today = asOfDate || new Date().toISOString().slice(0, 10)
    const Tsale = yrs(String(saleDate).slice(0, 10), expiry)
    const Tnow = yrs(today, expiry)
    if (!(Tsale > 0) || !(Tnow > 0)) return 0
    const sig = impliedVolCall(premiumPerShare, Sat, K, Tsale, r)
    if (!(sig > 0)) return 0
    const mark = bsCall(underlyingNow, K, Tnow, r, sig)
    return mark > 0 ? mark : 0
  } catch { return 0 }
}

// ── Volatility scanner helpers ──
// Annualized historical (realized) volatility from the last `window` daily closes.
function annualizedHV(closes, window) {
  if (!Array.isArray(closes) || closes.length < window + 1) return null
  const rets = []
  for (let i = closes.length - window; i < closes.length; i++) {
    if (i > 0 && closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]))
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.round(Math.sqrt(variance) * Math.sqrt(252) * 1000) / 1000 // e.g. 0.652 = 65.2%
}
// IV of the near-the-money call ~21–60 DTE. Uses the REFERENCE endpoint to find a
// valid ATM contract (lightweight metadata, broadly entitled), then a single
// per-contract snapshot for IV — avoiding the heavier chain-snapshot endpoint that
// errors on the Options Starter plan. Prefers Polygon's implied_volatility; else
// inverts the mark via Black–Scholes.
async function fetchAtmCallIV(ticker, stock, polygonKey) {
  const out = { iv: 0, contract: null, dte: null, source: null }
  if (!(stock > 0)) return out
  const now = Date.now()
  // 1) Find a near-ATM call via the reference endpoint
  const refResp = await axios.get('https://api.polygon.io/v3/reference/options/contracts', {
    params: {
      apiKey: polygonKey,
      underlying_ticker: ticker,
      contract_type: 'call',
      'expiration_date.gte': new Date(now + 21 * 86400000).toISOString().slice(0, 10),
      'expiration_date.lte': new Date(now + 60 * 86400000).toISOString().slice(0, 10),
      'strike_price.gte': Math.round(stock * 0.9),
      'strike_price.lte': Math.round(stock * 1.1),
      limit: 250, sort: 'expiration_date', order: 'asc'
    },
    timeout: 10000
  })
  const contracts = refResp.data?.results || []
  if (!contracts.length) return out
  let best = null, bestKey = Infinity
  for (const c of contracts) {
    const strike = c.strike_price, exp = c.expiration_date
    if (!(strike > 0) || !exp) continue
    const dte = Math.round((new Date(exp).getTime() - now) / 86400000)
    const key = dte * 1000 + Math.abs(strike - stock) // nearer expiry, then ATM
    if (key < bestKey) { bestKey = key; best = c }
  }
  if (!best) return out
  out.contract = best.ticker
  out.dte = Math.round((new Date(best.expiration_date).getTime() - now) / 86400000)
  // 2) Per-contract snapshot for IV (this path works on the plan)
  try {
    const snapResp = await axios.get(`https://api.polygon.io/v3/snapshot/options/${ticker}/${best.ticker}`, { params: { apiKey: polygonKey }, timeout: 8000 })
    const snap = snapResp.data?.results
    if (snap) {
      if (snap.implied_volatility > 0) {
        out.iv = Math.round(snap.implied_volatility * 1000) / 1000
        out.source = 'polygon'
      } else {
        const q = snap.last_quote || {}
        const mark = q.midpoint || (q.bid && q.ask ? (q.bid + q.ask) / 2 : 0) || snap.day?.close || 0
        const T = (new Date(best.expiration_date).getTime() - now) / (365.25 * 86400000)
        if (mark > 0 && T > 0) {
          const sig = impliedVolCall(mark, stock, best.strike_price, T, 0.045)
          if (sig > 0) { out.iv = Math.round(sig * 1000) / 1000; out.source = 'computed' }
        }
      }
    }
  } catch { /* leave iv 0 */ }
  return out
}
// Scan one ticker: current stock, HV20/HV30 (realized), and ATM-call IV.
// Stock-data and option-data steps are isolated so one failing doesn't wipe the other.
async function scanTickerVol(ticker, polygonKey) {
  const row = { ticker }
  try {
    // Daily closes come from Yahoo (unlimited) rather than Polygon's stocks-aggregates
    // endpoint, which is rate-limited to ~5 req/min on the Options-Starter plan and 429s
    // the moment we scan more than a handful of names. Options IV below stays on Polygon.
    const hist = await priceService.fetchHistoricalPrices(ticker, '6mo', '1d')
    const closes = (hist || []).map(b => b.close).filter(c => c > 0)
    row.stock = closes.length ? Math.round(closes[closes.length - 1] * 100) / 100 : null
    row.hv20 = annualizedHV(closes, 20)
    row.hv30 = annualizedHV(closes, 30)
  } catch (e) {
    row.barsError = e.response?.status ? `HTTP ${e.response.status}` : (e.code || e.message)
  }
  try {
    if (row.stock > 0) {
      const iv = await fetchAtmCallIV(ticker, row.stock, polygonKey)
      row.iv = iv.iv || null
      row.ivDte = iv.dte
      row.ivSource = iv.source
    }
  } catch (e) {
    row.ivError = e.response?.status ? `HTTP ${e.response.status}` : (e.code || e.message)
  }
  return row
}
// IV Rank / Percentile of currentIV within a history of IV values.
function computeIVRank(history, currentIV) {
  const ivs = (history || []).map(h => h.iv).filter(v => v > 0)
  if (!(currentIV > 0) || ivs.length < 2) return { ivRank: null, ivPercentile: null, ivHistoryDays: ivs.length }
  const min = Math.min(...ivs), max = Math.max(...ivs)
  const ivRank = max > min ? Math.round(((currentIV - min) / (max - min)) * 1000) / 10 : null
  const below = ivs.filter(v => v < currentIV).length
  const ivPercentile = Math.round((below / ivs.length) * 1000) / 10
  return { ivRank, ivPercentile, ivHistoryDays: ivs.length }
}
// Background: record a daily IV/HV snapshot for the short-call tickers so IV Rank builds.
// Compute the derived vol fields (IV/HV ratio, signal, IV rank) for a scanned row.
function enrichVolRow(row) {
  const hv = row.hv30 ?? row.hv20
  if (row.iv > 0 && hv > 0) {
    row.ivHvRatio = Math.round((row.iv / hv) * 100) / 100
    row.ivHvSpread = Math.round((row.iv - hv) * 1000) / 10
    row.signal = row.ivHvRatio >= 1.3 ? 'rich' : row.ivHvRatio <= 0.9 ? 'cheap' : 'normal'
  }
  return row
}

// Background: scan the universe (your short-call tickers ∪ S&P/NASDAQ) and cache each
// row, so large-universe scans are served instantly. Also records daily IV for IV Rank.
let universeScanRunning = false
let universeScanProgress = { done: 0, total: 0, ok: 0, startedAt: 0 }
async function runUniverseVolScan() {
  if (universeScanRunning) return
  universeScanRunning = true
  try {
    const polygonKey = process.env.POLYGON_API_KEY || ''
    if (!polygonKey) return
    const shortTickers = [...new Set(databaseService.getShortCallEntries(1).map(e => (e.ticker || '').toUpperCase()).filter(Boolean))]
    const universe = [...new Set([...shortTickers, ...SP500])]
    const today = new Date().toISOString().slice(0, 10)
    const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)
    universeScanProgress = { done: 0, total: universe.length, ok: 0, startedAt: Date.now() }
    const CONC = 3
    for (let i = 0; i < universe.length; i += CONC) {
      await Promise.all(universe.slice(i, i + CONC).map(async ticker => {
        try {
          const row = enrichVolRow(await scanTickerVol(ticker, polygonKey))
          if (row.iv > 0) {
            databaseService.recordIV(ticker, today, row.iv, row.hv30, row.stock)
            Object.assign(row, computeIVRank(databaseService.getIVHistory(ticker, since), row.iv))
            databaseService.upsertVolScan(row)
            universeScanProgress.ok++
          }
        } catch (e) { /* skip this ticker */ }
        universeScanProgress.done++
      }))
      if (i + CONC < universe.length) await new Promise(r => setTimeout(r, 300)) // gentle on Yahoo
    }
    console.log(`📈 Universe vol scan: cached ${universeScanProgress.ok}/${universe.length} tickers`)
  } catch (e) {
    console.warn('Universe vol scan failed:', e.message)
  } finally {
    universeScanRunning = false
  }
}
setTimeout(runUniverseVolScan, 90 * 1000)
setInterval(runUniverseVolScan, 24 * 60 * 60 * 1000)

// Global error handlers to prevent server crashes
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error)
  console.error('Stack:', error.stack)
  console.error('Memory:', process.memoryUsage())
  console.error('Uptime:', process.uptime(), 'seconds')
  // Don't exit - keep server running
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Promise Rejection at:', promise)
  console.error('Reason:', reason)
  console.error('Memory:', process.memoryUsage())
  console.error('Uptime:', process.uptime(), 'seconds')
  // Don't exit - keep server running
})


// Conditionally import Puppeteer-based downloader (only available locally, not on Railway)
let downloadRobinhoodReport = null
try {
  const module = await import('./services/robinhoodDownloader.js')
  downloadRobinhoodReport = module.downloadRobinhoodReport
  console.log('✅ Robinhood downloader available (running locally)')
} catch (error) {
  console.log('ℹ️  Robinhood downloader not available (Puppeteer not installed)')
}

const app = express()
const httpServer = createServer(app)

// Configure CORS for both Express and Socket.IO
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*'],
  credentials: false,
  optionsSuccessStatus: 200
}

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
    allowedHeaders: ['*']
  },
  allowEIO3: true,
  maxHttpBufferSize: 10e6  // 10MB — default 1MB is too small for large CSVs
})

// Middleware - add CORS before other middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200)
  }
  next()
})

// Request logging middleware (helps debug Railway health checks)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString()
  console.log(`📥 ${timestamp} ${req.method} ${req.path}`)
  next()
})

app.use(cors(corsOptions))
app.use(express.json())
app.use(cookieParser())

// Serve static files from the React app (after building with vite build)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Set cache control headers to prevent stale content
app.use(express.static(path.join(__dirname, '../dist'), {
  setHeaders: (res, filePath) => {
    // Don't cache HTML files - always get fresh version
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    } else if (filePath.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
      // Cache static assets for 1 year (Vite adds content hashes to filenames)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
  }
}))

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() })

// Services
const priceService = new PriceService(databaseService)

// Signal service configuration - Use Polygon by default, fallback to Alpha Vantage
const USE_POLYGON = process.env.USE_POLYGON !== 'false' // Default to true
const signalService = USE_POLYGON ? new PolygonService() : new SignalService()
const dataSource = USE_POLYGON ? 'Polygon.io' : 'Alpha Vantage'

console.log(`📊 Signal Data Source: ${dataSource}`)
if (USE_POLYGON) {
  console.log('💡 Get your free Polygon API key at https://polygon.io/')
  console.log('   Set POLYGON_API_KEY in environment or .env file')
}

// Track all symbols for automatic recording
const trackedSymbols = new Set()

// Store client sessions (in-memory, stateless)
const clientSessions = new Map()

// Session cleanup - remove sessions older than 1 hour
const SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour
setInterval(() => {
  try {
    console.log('🧹 Session cleanup running...')
    const now = Date.now()
    let cleanedCount = 0
    for (const [sessionId, session] of clientSessions.entries()) {
      if (now - session.lastActivity > SESSION_TIMEOUT) {
        console.log(`  Cleaning up inactive session: ${sessionId}`)
        clientSessions.delete(sessionId)
        cleanedCount++
      }
    }
    console.log(`✅ Session cleanup complete: ${cleanedCount} sessions removed, ${clientSessions.size} remain`)
  } catch (error) {
    console.error('❌ Error in session cleanup:', error.message)
    console.error('Stack:', error.stack)
  }
}, 5 * 60 * 1000) // Check every 5 minutes

// Background job: Scan for support/resistance levels
// DISABLED: Causing server crashes - use manual refresh in UI instead
// Free tier: 5 API calls/min, 2 calls per symbol = 2 symbols per scan
// Scan every 15 minutes to stay well under rate limits
/*
setInterval(async () => {
  try {
    // Skip if no Polygon API key configured
    if (!process.env.POLYGON_API_KEY) {
      console.log('⏭️  Skipping support/resistance scan - POLYGON_API_KEY not configured')
      return
    }

    if (trackedSymbols.size === 0) {
      return
    }

    // Free tier rate limit: 5 calls/min, each symbol needs 2 calls (historical + current price)
    // Scan only 2 symbols at a time to stay under limit
    const symbols = Array.from(trackedSymbols).slice(0, 2)
    console.log(`🎯 Scanning ${symbols.length} symbols for support/resistance levels (Free tier mode)...`)

    const results = await supportResistanceService.getSupportResistanceForSymbols(symbols)

    const allLevels = Object.values(results).flat()
    if (allLevels.length > 0) {
      databaseService.saveSupportResistanceLevels(allLevels)
      console.log(`✅ Found and saved ${allLevels.length} support/resistance levels`)

      // Broadcast significant levels to connected clients
      const strongLevels = allLevels.filter(level => level.strength >= 70)
      if (strongLevels.length > 0) {
        io.emit('support-resistance-alert', {
          levels: strongLevels,
          timestamp: Date.now()
        })
        console.log(`📢 Broadcast ${strongLevels.length} strong support/resistance levels to clients`)
      }
    } else {
      console.log('ℹ️  No support/resistance levels detected in this scan')
    }

    // Clean up expired levels
    databaseService.cleanupExpiredLevels()
  } catch (error) {
    console.error('❌ Error in support/resistance scan:', error.message)
    // Don't let the error crash the process
  }
}, 15 * 60 * 1000) // Every 15 minutes (free tier friendly)
*/

console.log('ℹ️  Background support/resistance scan is DISABLED - use manual refresh in UI')

// Socket.IO authentication middleware — verify the session cookie from the
// handshake. CSV upload happens over the socket, so this is what tags each
// user's uploaded data. Unauthenticated connections are rejected.
io.use((socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers?.cookie || ''
    const match = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/)
    const token = match ? decodeURIComponent(match[1]) : null
    const user = authService.verifySession(token)
    if (!user) return next(new Error('Authentication required'))
    socket.data.user = user
    next()
  } catch (e) {
    next(new Error('Authentication required'))
  }
})

// Socket.IO connection handling
io.on('connection', (socket) => {
  const user = socket.data.user
  console.log(`Client connected: ${socket.id} (user: ${user.username}, id: ${user.userId})`)

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
    clientSessions.delete(socket.id)
  })

  // Handle CSV upload via socket
  socket.on('upload-csv', async (data) => {
    try {
      // broker defaults to robinhood so existing clients keep working unchanged
      const { csvContent, broker = 'robinhood' } = data
      if (!SUPPORTED_BROKERS.includes(broker)) {
        socket.emit('csv-processed', { success: false, error: `Unknown broker "${broker}"` })
        return
      }

      console.log(`Processing ${broker} CSV for client ${socket.id}`)

      // Parse trades, dividends/interest, and deposits
      let trades, dividendsAndInterest, deposits = [], totalPrincipal = 0
      let importWarnings = []
      // Share journals: moved, not traded. Parsed all along and then dropped,
      // which left per-broker P&L half-counted at both ends.
      let shareTransfers = []
      if (broker === 'webull') {
        // Webull's orders export carries no cash movements, so there are no
        // deposits or dividends to pull out of it.
        const parsed = parseWebullOrders(csvContent)
        trades = parsed.trades
        dividendsAndInterest = []
        importWarnings = parsed.warnings
        if (importWarnings.length) console.log(`Webull parser warnings: ${importWarnings.join(' | ')}`)
        if (!trades.length) {
          socket.emit('csv-processed', { success: false, error: 'No filled orders found in that Webull export. Check that the export includes filled orders.' })
          return
        }
      } else if (broker === 'schwab') {
        // Schwab's transactions export carries dividends, interest and cash
        // transfers alongside trades, so it feeds all three paths.
        const parsed = parseSchwabTransactions(csvContent)
        trades = parsed.trades
        dividendsAndInterest = parsed.dividendsAndInterest
        deposits = parsed.deposits
        totalPrincipal = parsed.totalPrincipal
        shareTransfers = parsed.transfers || []
        importWarnings = parsed.warnings
        if (importWarnings.length) console.log(`Schwab parser warnings: ${importWarnings.join(' | ')}`)
        if (!trades.length && !dividendsAndInterest.length) {
          socket.emit('csv-processed', { success: false, error: 'No transactions found in that Schwab export.' })
          return
        }
      } else {
        ;({ trades, dividendsAndInterest } = await parseTrades(csvContent))
        ;({ deposits, totalPrincipal } = await parseDeposits(csvContent))
      }
      trades.forEach(t => { t.broker = broker })
      shareTransfers.forEach(t => { t.broker = broker })

      // Get unique stock symbols
      const allSymbols = [...new Set(trades.map(t => t.symbol))]
      const stockSymbols = allSymbols.filter(s => {
        return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
      })

      // Store session data
      clientSessions.set(socket.id, {
        userId: user.userId,
        trades,
        deposits,
        totalPrincipal,
        dividendsAndInterest,
        stockSymbols,
        splitAdjustments: {},
        manualPrices: {},
        lastActivity: Date.now()
      })

      // Register symbols for price tracking
      priceService.addSymbols(stockSymbols)

      // Add symbols to tracked set for database recording
      stockSymbols.forEach(symbol => trackedSymbols.add(symbol))
      console.log(`Now tracking ${trackedSymbols.size} symbols for database recording`)

      // Find the latest trade date for asof_date
      const latestTradeDate = trades.reduce((latest, trade) => {
        const tradeDate = new Date(trade.date)
        return tradeDate > latest ? tradeDate : latest
      }, new Date(0))

      // Debug: Log the latest trade date details
      console.log('🔍 Latest trade date object:', latestTradeDate)
      console.log('🔍 Date components:', {
        year: latestTradeDate.getFullYear(),
        month: latestTradeDate.getMonth() + 1,
        day: latestTradeDate.getDate(),
        hours: latestTradeDate.getHours(),
        timezone: latestTradeDate.getTimezoneOffset()
      })

      // Format as YYYY-MM-DD without timezone conversion
      const year = latestTradeDate.getFullYear()
      const month = String(latestTradeDate.getMonth() + 1).padStart(2, '0')
      const day = String(latestTradeDate.getDate()).padStart(2, '0')
      const asofDate = `${year}-${month}-${day}`
      console.log('🔍 Final asofDate:', asofDate)

      // Save trades and deposits to database immediately (don't wait for prices)
      try {
        databaseService.saveTrades(trades, asofDate, deposits, totalPrincipal, user.userId, broker)
        // Dividends, interest, margin and fees. Parsed on every upload and then
        // discarded until now, which is why margin interest had nowhere to show.
        if (dividendsAndInterest?.length) {
          const n = databaseService.saveCashActivity(user.userId, dividendsAndInterest, broker)
          console.log(`💵 Saved ${n} new cash activity row(s) for ${broker}`)
        }
        if (shareTransfers.length) {
          const n = databaseService.saveShareTransfers(user.userId, shareTransfers)
          console.log(`↔ recorded ${n} share transfer(s) for ${broker}`)
        }
        console.log(`💾 Saved ${trades.length} trades and ${deposits.length} deposits to database for ${asofDate} (user: ${user.userId})`)
      } catch (error) {
        console.error('Error saving trades:', error)
      }

      // Populate short_call_entries for STO-call trades in background
      const stoCallTrades = trades.filter(t =>
        t.transCode?.toUpperCase() === 'STO' && t.isOption &&
        (t.symbol || t.description || '').toLowerCase().includes('call')
      )
      if (stoCallTrades.length > 0) {
        setImmediate(async () => {
          for (const trade of stoCallTrades) {
            const parsed = parseOptionDescription(trade.symbol || trade.description || '')
            if (!parsed) continue
            const saleDate = new Date(trade.date).toISOString().split('T')[0]
            const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
            let underlyingClose = null
            try { underlyingClose = await priceService.getPriceForDate(parsed.ticker, saleDate) } catch (e) { /* leave null */ }
            databaseService.upsertShortCallEntry(user.userId, {
              symbol: trade.symbol || trade.description,
              ticker: parsed.ticker,
              strike: parsed.strike,
              expiry,
              contracts: trade.contracts || trade.quantity || 1,
              premium: Math.abs(trade.price),
              saleDate,
              underlyingClose,
              broker: trade.broker || broker
            })
          }
          console.log(`📝 Populated ${stoCallTrades.length} short call entries`)
        })
      }

      // Use any cached prices we already have; emit csv-processed immediately
      const cachedPrices = priceService.getCurrentPrices()
      const initialPrices = {}
      stockSymbols.forEach(sym => { initialPrices[sym] = cachedPrices[sym] || 0 })

      const initialPnl = calculatePnL(trades, initialPrices, true, null, asofDate, [])

      // Add benchmarks and made-up-ground enrichment for initial emit
      let initialPnlWithBenchmarks = initialPnl.map(position => ({
        ...position,
        benchmarks: databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
      }))
      const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
      if (weekAgoSnapshot.length > 0) {
        initialPnlWithBenchmarks = enrichWithMadeUpGround(initialPnlWithBenchmarks, weekAgoSnapshot)
      }

      // Emit immediately so the UI unblocks
      socket.emit('csv-processed', {
        success: true,
        data: {
          trades,
          pnlData: initialPnlWithBenchmarks,
          totalPrincipal,
          deposits,
          dividendsAndInterest,
          currentPrices: initialPrices,
          asofDate,
          uploadDate: asofDate,
          madeUpGroundDate: weekAgoDate,
          // Parser notes worth showing — e.g. a share journal with no cost basis
          importWarnings,
          pricesLoading: stockSymbols.length > 0  // signal to UI that prices are still loading
        }
      })

      console.log(`CSV processed for client ${socket.id}: ${trades.length} trades, ${stockSymbols.length} symbols (prices loading in background)`)

      // Fetch historical prices in the background — won't block the upload
      if (stockSymbols.length > 0) {
        console.log(`📅 Fetching historical prices for ${asofDate} in background...`)
        priceService.getPricesForDate(stockSymbols, asofDate).then(historicalPrices => {
          console.log(`✓ Background: fetched historical prices for ${Object.keys(historicalPrices).length} symbols`)

          // Recalculate P&L with real historical prices
          const pnlData = calculatePnL(trades, historicalPrices, true, null, asofDate, [])

          // Save P&L snapshot to database
          try {
            databaseService.savePnLSnapshot(asofDate, pnlData, user.userId)
            console.log(`💾 Saved P&L snapshot for ${asofDate} (user: ${user.userId})`)
          } catch (err) {
            console.error('Error saving P&L snapshot:', err)
          }

          // Save price benchmarks
          try {
            const benchmarks = pnlData.map(position => ({
              symbol: position.symbol,
              price_level: position.currentPrice,
              total_pnl: position.real?.totalPnL || 0,
              position: position.avgCost?.position || 0,
              avg_cost: position.avgCost?.avgCostBasis || 0,
              realized_pnl: position.real?.realizedPnL || 0,
              unrealized_pnl: position.real?.unrealizedPnL || 0
            }))
            databaseService.savePriceBenchmarks(benchmarks, asofDate)
          } catch (err) {
            console.error('Error saving price benchmarks:', err)
          }

          // Enrich and emit prices-updated so the UI can refresh
          let pnlDataWithBenchmarks = pnlData.map(position => ({
            ...position,
            benchmarks: databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
          }))
          const { date: wkDate, data: wkSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
          if (wkSnapshot.length > 0) {
            pnlDataWithBenchmarks = enrichWithMadeUpGround(pnlDataWithBenchmarks, wkSnapshot)
          }

          if (socket.connected) {
            socket.emit('prices-updated', {
              pnlData: pnlDataWithBenchmarks,
              currentPrices: historicalPrices,
              asofDate,
              madeUpGroundDate: wkDate
            })
          }
        }).catch(err => {
          console.error('Background price fetch failed:', err)
        })
      }

    } catch (error) {
      console.error('Error processing CSV:', error)
      socket.emit('csv-processed', {
        success: false,
        error: error.message
      })
    }
  })

  // Handle manual price updates
  socket.on('update-manual-price', async ({ symbol, price }) => {
    const session = clientSessions.get(socket.id)
    if (!session) return

    session.manualPrices[symbol] = parseFloat(price)

    // Recalculate P&L with manual price
    const prices = { ...priceService.getCurrentPrices(), ...session.manualPrices }
    const adjustedTrades = applysplits(session.trades, session.splitAdjustments)
    let pnlData = calculatePnL(adjustedTrades, prices, true, null, null, session.dividendsAndInterest || [])

    // Enrich with Made Up Ground
    console.log('🔍 [SOCKET EVENT] Checking for Made Up Ground enrichment')
    console.log(`   PNL data: ${pnlData.length} positions`)
    const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
    console.log(`   Week ago: ${weekAgoSnapshot.length} records from ${weekAgoDate || 'null'}`)
    if (weekAgoSnapshot.length > 0) {
      pnlData = enrichWithMadeUpGround(pnlData, weekAgoSnapshot)
      const sample = pnlData[0]
      console.log(`   ✅ After enrichment - Sample: ${sample?.symbol} madeUpGround=${sample?.madeUpGround}, available=${sample?.madeUpGroundAvailable}`)
    } else {
      console.log(`   ⚠️ Skipping enrichment - no week-ago data`)
    }

    console.log(`   📤 Emitting pnl-update to client`)
    socket.emit('pnl-update', { pnlData, currentPrices: prices, madeUpGroundDate: weekAgoDate })
  })

  // Handle split adjustments
  socket.on('update-split', async ({ symbol, ratio }) => {
    const session = clientSessions.get(socket.id)
    if (!session) return

    session.splitAdjustments[symbol] = parseFloat(ratio)

    // Recalculate P&L with splits
    const prices = { ...priceService.getCurrentPrices(), ...session.manualPrices }
    const adjustedTrades = applysplits(session.trades, session.splitAdjustments)
    let pnlData = calculatePnL(adjustedTrades, prices, true, null, null, session.dividendsAndInterest || [])

    // Enrich with Made Up Ground
    console.log('🔍 [SOCKET EVENT] Checking for Made Up Ground enrichment')
    console.log(`   PNL data: ${pnlData.length} positions`)
    const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
    console.log(`   Week ago: ${weekAgoSnapshot.length} records from ${weekAgoDate || 'null'}`)
    if (weekAgoSnapshot.length > 0) {
      pnlData = enrichWithMadeUpGround(pnlData, weekAgoSnapshot)
      const sample = pnlData[0]
      console.log(`   ✅ After enrichment - Sample: ${sample?.symbol} madeUpGround=${sample?.madeUpGround}, available=${sample?.madeUpGroundAvailable}`)
    } else {
      console.log(`   ⚠️ Skipping enrichment - no week-ago data`)
    }

    console.log(`   📤 Emitting pnl-update to client`)
    socket.emit('pnl-update', { pnlData, currentPrices: prices, madeUpGroundDate: weekAgoDate })
  })

  // Request trading signals
  socket.on('request-signals', async ({ symbols }) => {
    console.log(`📊 Received request-signals for ${symbols.length} symbols:`, symbols.join(', '))
    try {
      const session = clientSessions.get(socket.id)
      if (!session) {
        console.log('⚠️ No session found for client')
        return
      }

      console.log(`Fetching signals for ${symbols.length} symbols...`)
      const prices = { ...priceService.getCurrentPrices(), ...session.manualPrices }
      const signals = await signalService.getSignals(symbols, prices)

      console.log(`✅ Generated ${signals.length} signals, broadcasting to client`)
      socket.emit('signals-update', { signals })
    } catch (error) {
      console.error('❌ Error fetching signals:', error)
      socket.emit('signals-error', { error: error.message })
    }
  })

  // Lookup single symbol signal
  socket.on('lookup-signal', async ({ symbol }) => {
    console.log(`🔍 Received lookup-signal request for: ${symbol}`)
    try {
      const price = await priceService.getPrice(symbol)
      console.log(`📈 Got price for ${symbol}: $${price}`)

      const signal = await signalService.getSignal(symbol, price)
      console.log(`✅ Generated signal for ${symbol}: ${signal.signal}`)

      socket.emit('lookup-signal-result', { signal })
    } catch (error) {
      console.error(`❌ Error looking up signal for ${symbol}:`, error)
      socket.emit('lookup-signal-error', { error: error.message })
    }
  })

  // Fetch historical price data for charts
  socket.on('fetch-historical-data', async ({ symbol, range, interval }) => {
    console.log(`📊 Received fetch-historical-data request for: ${symbol} (${range}, ${interval})`)
    try {
      const historicalData = await priceService.fetchHistoricalPrices(symbol, range, interval)
      console.log(`✅ Sending ${historicalData.length} data points for ${symbol}`)

      socket.emit('historical-data-result', { symbol, data: historicalData })
    } catch (error) {
      console.error(`❌ Error fetching historical data for ${symbol}:`, error)
      socket.emit('historical-data-error', { symbol, error: error.message })
    }
  })

  // Get available snapshot dates
  socket.on('get-snapshot-dates', async () => {
    console.log(`📅 Received get-snapshot-dates request (user: ${user.userId})`)
    try {
      const dates = databaseService.getSnapshotDates(user.userId)
      socket.emit('snapshot-dates-result', { dates })
    } catch (error) {
      console.error(`❌ Error getting snapshot dates:`, error)
      socket.emit('snapshot-dates-error', { error: error.message })
    }
  })

  // Load P&L snapshot for a specific date
  socket.on('load-pnl-snapshot', async ({ asofDate }) => {
    console.log(`📂 Received load-pnl-snapshot request for: ${asofDate} (user: ${user.userId})`)
    try {
      let snapshot = databaseService.getPnLSnapshot(asofDate, user.userId)

      // Add enrichment-compatible fields to snapshot data (keep all original fields)
      let snapshotWithRealField = snapshot.map(row => ({
        ...row,  // Keep all DB fields (position, avg_cost, current_price, etc.)
        currentPrice: row.current_price,  // Add alias for enrichment
        real: {
          realizedPnL: row.realized_pnl || 0,
          unrealizedPnL: row.unrealized_pnl || 0,
          totalPnL: row.total_pnl || 0
        }
      }))

      // Enrich with Made Up Ground - calculate from the asofDate being viewed
      console.log(`🔍 Enriching snapshot ${asofDate} with week-ago data`)

      // Calculate week ago date from the asofDate, not from most recent snapshot
      const [year, month, day] = asofDate.split('-').map(Number)
      const viewingDate = new Date(year, month - 1, day)
      viewingDate.setDate(viewingDate.getDate() - 7)
      const weekAgoYear = viewingDate.getFullYear()
      const weekAgoMonth = String(viewingDate.getMonth() + 1).padStart(2, '0')
      const weekAgoDay = String(viewingDate.getDate()).padStart(2, '0')
      const weekAgoDate = `${weekAgoYear}-${weekAgoMonth}-${weekAgoDay}`

      console.log(`   Calculated week ago: ${weekAgoDate}`)
      const weekAgoSnapshot = databaseService.getPnLSnapshot(weekAgoDate, user.userId)
      console.log(`   Week ago snapshot: ${weekAgoSnapshot.length} records`)

      if (weekAgoSnapshot.length > 0) {
        snapshotWithRealField = enrichWithMadeUpGround(snapshotWithRealField, weekAgoSnapshot)
      } else {
        console.log(`   ⚠️ No snapshot for ${weekAgoDate}`)
      }

      // Send enriched snapshot with all fields
      socket.emit('pnl-snapshot-loaded', { success: true, asofDate, data: snapshotWithRealField, madeUpGroundDate: weekAgoDate })
    } catch (error) {
      console.error(`❌ Error loading P&L snapshot:`, error)
      socket.emit('pnl-snapshot-loaded', { success: false, error: error.message })
    }
  })

  // Debug: Check pnl_snapshots table directly
  socket.on('debug-snapshots-raw', () => {
    console.log(`🔍 Received debug-snapshots-raw request`)
    try {
      const debugInfo = databaseService.getSnapshotsDebugInfo()
      console.log(`✅ Found ${debugInfo.totalCount} total snapshots, ${debugInfo.uniqueDates} unique dates`)
      socket.emit('debug-snapshots-result', debugInfo)
    } catch (error) {
      console.error(`❌ Error in debug-snapshots-raw:`, error)
      socket.emit('debug-snapshots-result', {
        success: false,
        error: error.message
      })
    }
  })

  // Get all trades across all upload dates — needed for FIFO matching in DailyRealizedPnLPanel
  socket.on('get-all-trades', () => {
    try {
      const allTrades = databaseService.getAllTradesForUser(user.userId)
      console.log(`📦 get-all-trades: ${allTrades.length} total trades for user ${user.userId}`)
      socket.emit('all-trades-result', { success: true, trades: allTrades })
    } catch (err) {
      console.error('get-all-trades error:', err)
      socket.emit('all-trades-result', { success: false, error: err.message })
    }
  })

  // S&P 500 volume screener — streams hits back in real time
  let screenerRunning = false
  socket.on('run-screener', async ({ lookBack = 10, volMultiple = 1.5, minCount = 6 } = {}) => {
    if (screenerRunning) return
    screenerRunning = true
    const tickers = SP500
    let processed = 0
    console.log(`🔍 Screener started: ${tickers.length} tickers, lookBack=${lookBack}, volX=${volMultiple}, minCount=${minCount}`)
    socket.emit('screener-progress', { processed: 0, total: tickers.length })

    const analyseTicker = async (sym) => {
      try {
        const bars = await priceService.fetchHistoricalPrices(sym, '1y', '1d')
        if (!bars || bars.length < 60) return null

        // Rolling avg volume (30 bars before the look-back window)
        const windowStart = bars.length - lookBack
        const avgVolBars = bars.slice(Math.max(0, windowStart - 30), windowStart)
        const avgVol = avgVolBars.length
          ? avgVolBars.reduce((s, b) => s + (b.volume || 0), 0) / avgVolBars.length
          : 1

        // Count large buy / sell candles in the look-back window
        const window = bars.slice(windowStart)
        let largeSellCount = 0, largeBuyCount = 0
        window.forEach(b => {
          const vm = avgVol > 0 ? (b.volume || 0) / avgVol : 1
          if (vm < volMultiple) return
          if (b.close < b.open) largeSellCount++
          else if (b.close > b.open) largeBuyCount++
        })

        // Trend at last bar
        const n = bars.length - 1
        const maVal = (period) => {
          if (n < period - 1) return null
          let s = 0; for (let k = n - period + 1; k <= n; k++) s += bars[k].close || 0
          return s / period
        }
        const ma50 = maVal(50)
        const ma200 = maVal(200)
        const ma50_10 = n >= 60 ? (() => {
          let s = 0; const p = n - 10; for (let k = p - 49; k <= p; k++) s += bars[k]?.close || 0; return s / 50
        })() : null
        const slope = ma50 && ma50_10 ? (ma50 - ma50_10) / ma50_10 * 100 : null
        const price = bars[n].close

        let trend = 'neutral'
        if (ma50) {
          const above50 = price > ma50
          const rising = slope !== null && slope > 0
          if (ma200) {
            if (above50 && ma50 > ma200 && rising)      trend = 'uptrend'
            else if (!above50 && ma50 < ma200 && !rising) trend = 'downtrend'
            else if (above50 && ma50 > ma200)            trend = 'up_mixed'
            else if (!above50 && ma50 < ma200)           trend = 'down_mixed'
          } else {
            if (above50 && rising)  trend = 'uptrend'
            else if (!above50 && !rising) trend = 'downtrend'
          }
        }

        // Signal logic
        // SELL: buyers exhausted in uptrend/neutral — price likely to pull back
        // BUY:  sellers exhausted in downtrend — price likely to bounce
        const isSell = (trend === 'uptrend' || trend === 'up_mixed' || trend === 'neutral') && largeBuyCount >= minCount
        const isBuy  = (trend === 'downtrend' || trend === 'down_mixed') && largeSellCount >= minCount

        if (!isBuy && !isSell) return null

        return {
          sym,
          signal: isBuy && isSell ? 'BOTH' : isBuy ? 'BUY' : 'SELL',
          trend,
          largeSellCount,
          largeBuyCount,
          price: parseFloat(price.toFixed(2)),
          ma50: ma50 ? parseFloat(ma50.toFixed(2)) : null,
          ma200: ma200 ? parseFloat(ma200.toFixed(2)) : null,
          slope: slope ? parseFloat(slope.toFixed(3)) : null,
        }
      } catch (_) {
        return null
      }
    }

    // Process in batches of 8 with a small delay between batches
    const BATCH = 8
    for (let i = 0; i < tickers.length && screenerRunning; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH)
      const results = await Promise.all(batch.map(analyseTicker))
      processed += batch.length
      results.forEach(r => { if (r) socket.emit('screener-hit', r) })
      socket.emit('screener-progress', { processed, total: tickers.length })
      if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 150))
    }

    socket.emit('screener-done', { total: tickers.length, processed })
    screenerRunning = false
    console.log(`✅ Screener complete: ${processed}/${tickers.length} tickers`)
  })

  socket.on('stop-screener', () => { screenerRunning = false })

  // Get latest saved trades
  socket.on('get-latest-trades', async () => {
    console.log(`📥 Received get-latest-trades request (user: ${user.userId})`)
    try {
      const { trades, uploadDate } = databaseService.getLatestTrades(user.userId)

      if (trades.length > 0) {
        console.log(`✓ Found ${trades.length} trades from ${uploadDate}`)

        // Get unique stock symbols
        const allSymbols = [...new Set(trades.map(t => t.symbol))]
        const stockSymbols = allSymbols.filter(s => {
          return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
        })

        // Fetch historical prices for the upload date
        console.log(`📅 Fetching historical prices for ${uploadDate}...`)
        const historicalPrices = await priceService.getPricesForDate(stockSymbols, uploadDate)
        console.log(`✓ Fetched historical prices for ${Object.keys(historicalPrices).length} symbols`)

        // Calculate P&L using historical prices
        const pnlData = calculatePnL(trades, historicalPrices, true, null, uploadDate, [])

        // Get price benchmarks for each position
        const pnlDataWithBenchmarks = pnlData.map(position => {
          const benchmarks = databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
          return {
            ...position,
            benchmarks
          }
        })

        // Enrich with Made Up Ground - calculate from the uploadDate being viewed
        console.log('🔍 [get-latest-trades] Checking for Made Up Ground enrichment')
        console.log(`   Viewing date: ${uploadDate}`)

        // Calculate week ago date from the uploadDate, not from most recent snapshot
        const [year, month, day] = uploadDate.split('-').map(Number)
        const viewingDate = new Date(year, month - 1, day)
        viewingDate.setDate(viewingDate.getDate() - 7)
        const weekAgoYear = viewingDate.getFullYear()
        const weekAgoMonth = String(viewingDate.getMonth() + 1).padStart(2, '0')
        const weekAgoDay = String(viewingDate.getDate()).padStart(2, '0')
        const weekAgoDate = `${weekAgoYear}-${weekAgoMonth}-${weekAgoDay}`

        console.log(`   Calculated week ago: ${weekAgoDate}`)
        const weekAgoSnapshot = databaseService.getPnLSnapshot(weekAgoDate, user.userId)
        console.log(`   Week ago snapshot: ${weekAgoSnapshot.length} records from ${weekAgoDate}`)

        let enrichedPnlData = pnlDataWithBenchmarks
        if (weekAgoSnapshot.length > 0) {
          enrichedPnlData = enrichWithMadeUpGround(pnlDataWithBenchmarks, weekAgoSnapshot)
          const sample = enrichedPnlData[0]
          console.log(`   ✅ After enrichment - Sample: ${sample?.symbol} madeUpGround=${sample?.madeUpGround}`)
        } else {
          console.log(`   ⚠️ Skipping enrichment - no snapshot for ${weekAgoDate}`)
        }

        const deposits = databaseService.getDeposits(uploadDate, user.userId)
        const totalPrincipal = databaseService.getTotalPrincipal(uploadDate, user.userId)

        socket.emit('latest-trades-result', {
          success: true,
          trades,
          uploadDate,
          deposits,
          totalPrincipal,
          currentPrices: historicalPrices,
          pnlData: enrichedPnlData,
          madeUpGroundDate: weekAgoDate
        })
      } else {
        console.log(`ℹ️  No saved trades found`)
        socket.emit('latest-trades-result', {
          success: true,
          trades: [],
          uploadDate: null,
          deposits: [],
          totalPrincipal: 0
        })
      }
    } catch (error) {
      console.error(`❌ Error getting latest trades:`, error)
      socket.emit('latest-trades-error', { error: error.message })
    }
  })

  // Get all upload dates
  socket.on('get-upload-dates', async () => {
    console.log(`📅 Received get-upload-dates request (user: ${user.userId})`)
    try {
      const dates = databaseService.getUploadDates(user.userId)
      socket.emit('upload-dates-result', { dates })
    } catch (error) {
      console.error(`❌ Error getting upload dates:`, error)
      socket.emit('upload-dates-error', { error: error.message })
    }
  })

  // Manually trigger signal performance analysis
  socket.on('analyze-signal-performance', async () => {
    console.log(`📊 Received analyze-signal-performance request`)
    try {
      const performance = databaseService.analyzeSignalPerformance()
      const accuracy = databaseService.getSignalAccuracy()

      socket.emit('signal-performance-result', {
        success: true,
        performance,
        accuracy,
        message: `Analyzed ${performance.length} signal data points`
      })

      console.log(`✅ Signal performance analysis complete: ${performance.length} data points`)
    } catch (error) {
      console.error(`❌ Error analyzing signal performance:`, error)
      socket.emit('signal-performance-error', { error: error.message })
    }
  })

  // Load trades for a specific date
  socket.on('load-trades', async ({ uploadDate }) => {
    console.log(`📂 Received load-trades request for: ${uploadDate} (user: ${user.userId})`)
    try {
      const trades = databaseService.getTrades(uploadDate, user.userId)

      // Get unique stock symbols
      const allSymbols = [...new Set(trades.map(t => t.symbol))]
      const stockSymbols = allSymbols.filter(s => {
        return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
      })

      // Fetch historical prices for the upload date
      console.log(`📅 Fetching historical prices for ${uploadDate}...`)
      const historicalPrices = await priceService.getPricesForDate(stockSymbols, uploadDate)
      console.log(`✓ Fetched historical prices for ${Object.keys(historicalPrices).length} symbols`)
      // Log sample prices for debugging
      const sampleSymbols = Object.keys(historicalPrices).slice(0, 3)
      sampleSymbols.forEach(sym => {
        console.log(`  ${sym}: $${historicalPrices[sym]}`)
      })

      // Calculate P&L using historical prices
      const pnlData = calculatePnL(trades, historicalPrices, true, null, uploadDate, [])

      // Get price benchmarks for each position
      const pnlDataWithBenchmarks = pnlData.map(position => {
        const benchmarks = databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)

        // Debug: Log if this position has options with expired ones
        if (position.options && position.options.length > 0) {
          const expiredOpts = position.options.filter(opt => opt.avgCost?.position === 0)
          if (expiredOpts.length > 0) {
            console.log(`📍 ${position.symbol} has ${expiredOpts.length} expired options (position=0):`)
            expiredOpts.forEach(opt => console.log(`   - ${opt.symbol}: position=${opt.avgCost?.position}`))
          }
        }

        return {
          ...position,
          benchmarks
        }
      })

      const deposits = databaseService.getDeposits(uploadDate, user.userId)
      const totalPrincipal = databaseService.getTotalPrincipal(uploadDate, user.userId)

      // Store session data so client receives auto-updates
      clientSessions.set(socket.id, {
        userId: user.userId,
        trades,
        deposits,
        totalPrincipal,
        dividendsAndInterest: [], // TODO: Load from database
        stockSymbols,
        splitAdjustments: {},
        manualPrices: {},
        lastActivity: Date.now()
      })
      console.log(`✅ Created session for ${socket.id.substring(0, 8)} with ${trades.length} trades`)

      console.log(`📤 Sending ${pnlDataWithBenchmarks.length} positions to client (load-trades)`)
      console.log(`   Positions: ${pnlDataWithBenchmarks.map(p => p.symbol).join(', ')}`)

      socket.emit('trades-loaded', {
        success: true,
        uploadDate,
        trades,
        deposits,
        totalPrincipal,
        currentPrices: historicalPrices,
        pnlData: pnlDataWithBenchmarks
      })
    } catch (error) {
      console.error(`❌ Error loading trades:`, error)
      socket.emit('trades-loaded', { success: false, error: error.message })
    }
  })

  // Clear all saved data for THIS user only
  socket.on('clear-database', () => {
    console.log(`🗑️  Received clear-database request (user: ${user.userId})`)
    try {
      databaseService.clearAllData(user.userId)
      socket.emit('database-cleared', { success: true })
    } catch (error) {
      console.error(`❌ Error clearing database:`, error)
      socket.emit('database-cleared', { success: false, error: error.message })
    }
  })

  // Delete snapshot for a specific date (manual admin function)
  socket.on('delete-snapshot', ({ date }) => {
    console.log(`🗑️ Received delete-snapshot request for ${date} (user: ${user.userId})`)
    try {
      const deletedCount = databaseService.deletePnLSnapshot(date, user.userId)
      console.log(`✅ Deleted ${deletedCount} snapshot records for ${date}`)
      socket.emit('snapshot-deleted', { success: true, date, deletedCount })
    } catch (error) {
      console.error(`❌ Error deleting snapshot:`, error)
      socket.emit('snapshot-deleted', { success: false, error: error.message })
    }
  })

  // Clear all P&L snapshots (admin function)
  socket.on('clear-all-snapshots', () => {
    console.log(`🗑️ Received clear-all-snapshots request (user: ${user.userId})`)
    try {
      const deletedCount = databaseService.clearAllSnapshots(user.userId)
      console.log(`✅ Cleared all snapshots (${deletedCount} records)`)
      socket.emit('snapshots-cleared', { success: true, deletedCount })
    } catch (error) {
      console.error(`❌ Error clearing snapshots:`, error)
      socket.emit('snapshots-cleared', { success: false, error: error.message })
    }
  })

  // Get daily P&L history for charting
  socket.on('get-daily-pnl', () => {
    console.log(`📊 Received get-daily-pnl request (user: ${user.userId})`)
    try {
      const dailyPnL = databaseService.getDailyPnLHistory(user.userId)
      console.log(`✅ Sending ${dailyPnL.length} days of P&L history`)

      // Debug: Show what dates we have snapshots for
      const dates = databaseService.getSnapshotDates(user.userId)
      console.log(`📅 Available snapshot dates: ${dates.join(', ')}`)

      socket.emit('daily-pnl-result', { success: true, data: dailyPnL })
    } catch (error) {
      console.error(`❌ Error getting daily P&L:`, error)
      socket.emit('daily-pnl-error', { error: error.message })
    }
  })

  // Get symbol-specific daily P&L with price
  socket.on('get-symbol-pnl', ({ symbol }) => {
    console.log(`📊 Received get-symbol-pnl request for ${symbol} (user: ${user.userId})`)
    try {
      const symbolPnL = databaseService.getSymbolDailyPnL(symbol, user.userId)
      console.log(`✅ Sending ${symbolPnL.length} days of P&L for ${symbol}`)
      socket.emit('symbol-pnl-result', { success: true, symbol, data: symbolPnL })
    } catch (error) {
      console.error(`❌ Error getting symbol P&L:`, error)
      socket.emit('symbol-pnl-error', { error: error.message })
    }
  })

  // Get list of symbols with snapshot data
  socket.on('get-symbols-list', () => {
    console.log(`📋 Received get-symbols-list request (user: ${user.userId})`)
    try {
      const symbols = databaseService.getSymbolsWithSnapshots(user.userId)
      console.log(`✅ Sending ${symbols.length} symbols`)
      socket.emit('symbols-list-result', { success: true, data: symbols })
    } catch (error) {
      console.error(`❌ Error getting symbols list:`, error)
      socket.emit('symbols-list-error', { error: error.message })
    }
  })

  // Backfill missing daily PNL snapshots from trade history
  socket.on('backfill-snapshots', async () => {
    console.log(`🔄 Received backfill-snapshots request (user: ${user.userId})`)
    try {
      const missingDates = databaseService.getMissingSnapshotDates(user.userId)

      if (missingDates.length === 0) {
        console.log('✅ No missing dates to backfill')
        socket.emit('backfill-complete', {
          success: true,
          message: 'No missing dates to backfill',
          backfilledCount: 0
        })
        return
      }

      console.log(`📅 Found ${missingDates.length} missing dates to backfill`)

      let backfilledCount = 0
      for (const targetDate of missingDates) {
        try {
          // Get all trades that were active on this date
          const allTrades = databaseService.getTradesActiveOnDate(targetDate, user.userId)

          if (allTrades.length === 0) {
            console.log(`⚠️  No trades found for ${targetDate}, skipping`)
            continue
          }

          // Get unique stock symbols (filter out options)
          const stockSymbols = [...new Set(
            allTrades
              .filter(t => !t.symbol.includes(' ') && !t.symbol.includes('Put') && !t.symbol.includes('Call'))
              .map(t => t.symbol)
          )]

          if (stockSymbols.length === 0) {
            console.log(`⚠️  No stock symbols for ${targetDate}, skipping`)
            continue
          }

          // Fetch historical prices for this date
          console.log(`📈 Fetching prices for ${stockSymbols.length} symbols on ${targetDate}...`)
          const historicalPrices = await priceService.getPricesForDate(stockSymbols, targetDate)

          // Get deposits for calculating total principal
          const deposits = databaseService.getDeposits(targetDate, user.userId) || []
          const totalPrincipal = deposits.reduce((sum, d) => sum + (d.amount || 0), 0)

          // Calculate P&L using historical prices
          const pnlData = calculatePnL(allTrades, historicalPrices, true, null, targetDate, [])

          // Save this backfilled snapshot
          databaseService.savePnLSnapshot(targetDate, pnlData, user.userId)

          backfilledCount++
          console.log(`✓ Backfilled snapshot for ${targetDate} (${backfilledCount}/${missingDates.length})`)

          // Emit progress update
          socket.emit('backfill-progress', {
            date: targetDate,
            current: backfilledCount,
            total: missingDates.length
          })

          // Small delay to avoid overwhelming the API
          await new Promise(resolve => setTimeout(resolve, 500))
        } catch (error) {
          console.error(`❌ Error backfilling ${targetDate}:`, error.message)
          // Continue with next date even if one fails
        }
      }

      console.log(`✅ Backfill complete: ${backfilledCount}/${missingDates.length} snapshots created`)
      socket.emit('backfill-complete', {
        success: true,
        message: `Successfully backfilled ${backfilledCount} snapshots`,
        backfilledCount,
        total: missingDates.length
      })
    } catch (error) {
      console.error(`❌ Error during backfill:`, error)
      socket.emit('backfill-complete', {
        success: false,
        error: error.message
      })
    }
  })

  // Get support/resistance levels for a symbol
  socket.on('get-support-resistance', async ({ symbol }) => {
    console.log(`🎯 Received request for support/resistance levels: ${symbol}`)
    try {
      const levels = await supportResistanceService.getSupportResistanceLevels(symbol)

      // Save to database
      if (levels.length > 0) {
        databaseService.saveSupportResistanceLevels(levels)
      }

      socket.emit('support-resistance-result', {
        success: true,
        symbol,
        levels,
        timestamp: Date.now()
      })
    } catch (error) {
      console.error(`❌ Error getting support/resistance for ${symbol}:`, error)
      socket.emit('support-resistance-result', {
        success: false,
        error: error.message
      })
    }
  })

  // Get support/resistance levels for multiple symbols
  socket.on('get-support-resistance-multi', async ({ symbols }) => {
    console.log(`🎯 Received request for support/resistance levels: ${symbols.join(', ')}`)
    try {
      const results = await supportResistanceService.getSupportResistanceForSymbols(symbols)

      // Save all levels to database
      const allLevels = Object.values(results).flat()
      if (allLevels.length > 0) {
        databaseService.saveSupportResistanceLevels(allLevels)
      }

      socket.emit('support-resistance-multi-result', {
        success: true,
        results,
        timestamp: Date.now()
      })
    } catch (error) {
      console.error(`❌ Error getting support/resistance:`, error)
      socket.emit('support-resistance-multi-result', {
        success: false,
        error: error.message
      })
    }
  })

  // Update support/resistance configuration
  socket.on('update-level2-config', ({ config }) => {
    console.log(`⚙️  Updating support/resistance configuration`)
    try {
      supportResistanceService.updateConfig(config)
      socket.emit('level2-config-updated', {
        success: true,
        config: supportResistanceService.config
      })
    } catch (error) {
      console.error(`❌ Error updating support/resistance config:`, error)
      socket.emit('level2-config-updated', {
        success: false,
        error: error.message
      })
    }
  })

  // Check resistance alerts for symbols
  socket.on('check-resistance-alerts', async ({ symbols, currentPrices }) => {
    console.log(`🚨 Checking resistance alerts for ${symbols.length} symbols`)
    try {
      const alerts = await supportResistanceService.checkResistanceAlerts(symbols, currentPrices || {})
      socket.emit('resistance-alerts-result', {
        success: true,
        alerts,
        timestamp: Date.now()
      })
    } catch (error) {
      console.error(`❌ Error checking resistance alerts:`, error)
      socket.emit('resistance-alerts-result', {
        success: false,
        error: error.message
      })
    }
  })

  // Check EMA crossovers for symbols
  socket.on('check-ema-crossovers', async ({ symbols }) => {
    console.log(`📊 Checking EMA crossovers for ${symbols.length} symbols`)
    try {
      const alerts = await emaAlertService.checkEMACrossovers(symbols)
      socket.emit('ema-crossovers-result', {
        success: true,
        alerts,
        timestamp: Date.now()
      })
    } catch (error) {
      console.error(`❌ Error checking EMA crossovers:`, error)
      socket.emit('ema-crossovers-result', {
        success: false,
        error: error.message
      })
    }
  })
})

// Helper function to apply split adjustments
function applysplits(trades, splits) {
  return trades.map(trade => {
    if (splits[trade.symbol]) {
      const ratio = splits[trade.symbol]
      return {
        ...trade,
        price: trade.price / ratio
      }
    }
    return trade
  })
}

// Helper function to enrich P&L data with Made Up Ground calculation
// Formula: (today real PNL - 1 week ago real pnl) - (1 week ago quantity * (today price - 1 week ago price))
function enrichWithMadeUpGround(currentPnL, weekAgoSnapshot) {
  console.log(`🔍 enrichWithMadeUpGround: Processing ${currentPnL.length} positions with ${weekAgoSnapshot.length} week-ago snapshots`)

  // Create a map of week-ago data by symbol for quick lookup
  const weekAgoMap = {}
  weekAgoSnapshot.forEach(snap => {
    weekAgoMap[snap.symbol] = snap
  })

  // Enrich each current P&L entry with Made Up Ground
  let enrichedCount = 0
  const result = currentPnL.map(position => {
    const weekAgo = weekAgoMap[position.symbol]

    if (!weekAgo) {
      // No historical data for this symbol - might be a new position
      return {
        ...position,
        madeUpGround: null,
        madeUpGroundAvailable: false
      }
    }

    enrichedCount++

    // Calculate Made Up Ground
    // (today real PNL - 1 week ago real pnl) - (1 week ago quantity * (today price - 1 week ago price))
    const todayRealPnL = position.real?.realizedPnL || 0
    const weekAgoRealPnL = weekAgo.realized_pnl || 0
    const weekAgoQuantity = weekAgo.position || 0
    const todayPrice = position.currentPrice || 0
    const weekAgoPrice = weekAgo.current_price || 0

    const pnlChange = todayRealPnL - weekAgoRealPnL
    const priceMovementEffect = weekAgoQuantity * (todayPrice - weekAgoPrice)
    const madeUpGround = pnlChange - priceMovementEffect

    // Debug first symbol to see actual values
    if (enrichedCount === 1) {
      console.log(`   📊 Sample calculation for ${position.symbol}:`)
      console.log(`      Today real P&L: ${todayRealPnL}, Week ago real P&L: ${weekAgoRealPnL}`)
      console.log(`      P&L change: ${pnlChange}`)
      console.log(`      Week ago position: ${weekAgoQuantity}, Today price: ${todayPrice}, Week ago price: ${weekAgoPrice}`)
      console.log(`      Price movement effect: ${priceMovementEffect}`)
      console.log(`      Made Up Ground: ${madeUpGround}`)
    }

    return {
      ...position,
      madeUpGround: Number.isFinite(madeUpGround) ? madeUpGround : null,
      madeUpGroundAvailable: true,
      weekAgoData: {
        realizedPnL: weekAgoRealPnL,
        position: weekAgoQuantity,
        price: weekAgoPrice
      }
    }
  })

  console.log(`✅ Enriched ${enrichedCount} positions with Made Up Ground data`)
  return result
}

// Background job: Update prices every minute and broadcast to clients
// TEMPORARILY DISABLED: Causing SIGTERM crashes - investigating
let recordingCounter = 0
/*
setInterval(async () => {
  console.log('🔄 Price update job starting...')
  try {
    const updatedPrices = await priceService.refreshPrices()
    console.log('✅ refreshPrices completed')
    recordingCounter++

    // Every 5 minutes, record prices and signals to database
    const shouldRecord = recordingCounter % 5 === 0
    if (shouldRecord && trackedSymbols.size > 0) {
      console.log(`📊 Recording prices and signals for ${trackedSymbols.size} symbols...`)

      // Record prices
      try {
        databaseService.recordPrices(updatedPrices)
      } catch (err) {
        console.error(`❌ Error recording prices:`, err.message)
      }

      // Fetch and record signals for all tracked symbols
      const signalsToRecord = []
      for (const symbol of trackedSymbols) {
        try {
          const signal = await signalService.getSignal(symbol)
          if (signal) {
            signalsToRecord.push(signal)
          }
        } catch (err) {
          console.error(`❌ Error fetching signal for ${symbol}:`, err.message)
        }
      }

      if (signalsToRecord.length > 0) {
        try {
          databaseService.recordSignals(signalsToRecord)
          console.log(`✅ Recorded ${signalsToRecord.length} signals`)
        } catch (err) {
          console.error(`❌ Error recording signals:`, err.message)
        }
      }

      // Analyze signal performance (every 5 minutes)
      try {
        databaseService.analyzeSignalPerformance()
      } catch (err) {
        console.error(`❌ Error analyzing signal performance:`, err.message)
      }
    }

    // Broadcast price updates to all clients
    console.log(`🔄 Starting price update broadcast to ${clientSessions.size} client(s)...`)

    let successCount = 0
    let skipCount = 0

    // Fetch 1-week-ago snapshot for Made Up Ground calculation (once for all clients)
    console.log('🔍 Background job: Checking for Made Up Ground data')
    let weekAgoDate = null
    let weekAgoSnapshot = []
    try {
      const result = databaseService.getPnLSnapshotFromDaysAgo(7)
      if (result && result.data) {
        weekAgoDate = result.date
        weekAgoSnapshot = result.data
        console.log(`   Week ago snapshot: ${weekAgoSnapshot.length} records from ${weekAgoDate || 'null'}`)
      } else {
        console.log(`   No week-ago snapshot available`)
      }
    } catch (err) {
      console.error(`   ❌ Error fetching week-ago snapshot:`, err.message)
    }

    for (const [socketId, session] of clientSessions.entries()) {
      const socket = io.sockets.sockets.get(socketId)
      if (!socket) {
        console.log(`  ⏭️  Socket ${socketId.substring(0, 8)} not found`)
        skipCount++
        continue
      }

      if (!session.trades || session.trades.length === 0) {
        console.log(`  ⏭️  Socket ${socketId.substring(0, 8)} has no trades, skipping`)
        skipCount++
        continue
      }

      try {
        // Merge with manual prices
        const prices = { ...updatedPrices, ...session.manualPrices }

        // Recalculate P&L with new prices
        const adjustedTrades = applysplits(session.trades, session.splitAdjustments)
        let pnlData = calculatePnL(adjustedTrades, prices, true, null, null, session.dividendsAndInterest || [])

        // Enrich with Made Up Ground if we have historical data
        console.log(`  🔍 About to check enrichment: weekAgoSnapshot.length = ${weekAgoSnapshot.length}`)
        if (weekAgoSnapshot.length > 0) {
          try {
            console.log(`  ✅ Calling enrichWithMadeUpGround with ${pnlData.length} positions`)
            pnlData = enrichWithMadeUpGround(pnlData, weekAgoSnapshot)
          } catch (enrichErr) {
            console.error(`  ❌ Error enriching with Made Up Ground:`, enrichErr.message)
          }
        } else {
          console.log(`  ❌ Skipping enrichment: no week-ago data`)
        }

        socket.emit('price-update', {
          currentPrices: prices,
          pnlData,
          timestamp: new Date(),
          madeUpGroundDate: weekAgoDate
        })

        console.log(`  ✅ Sent update to ${socketId.substring(0, 8)} (${session.trades.length} trades, ${pnlData.length} positions)`)
        successCount++
      } catch (err) {
        console.error(`  ❌ Error broadcasting to ${socketId.substring(0, 8)}:`, err.message)
        skipCount++
      }
    }

    console.log(`📡 Price update complete: ${successCount} sent, ${skipCount} skipped`)

    // Save snapshot only if there's an active session viewing the data
    // Don't create snapshots for dates without actual CSV uploads
    try {
      console.log('📸 Checking for active sessions to save snapshot...')
      const firstSession = Array.from(clientSessions.values()).find(s => s.trades && s.trades.length > 0)

      if (firstSession) {
        // Only save snapshots when someone is actively viewing their portfolio
        const todayDate = new Date().toISOString().split('T')[0]
        console.log(`📊 Active session detected, updating snapshot for ${todayDate} (user: ${firstSession.userId})`)
        const prices = { ...updatedPrices, ...firstSession.manualPrices }
        const adjustedTrades = applysplits(firstSession.trades, firstSession.splitAdjustments)
        const pnlData = calculatePnL(adjustedTrades, prices, true, null, null, firstSession.dividendsAndInterest || [])

        databaseService.savePnLSnapshot(todayDate, pnlData, firstSession.userId)
        console.log('✅ Snapshot saved successfully')
      } else {
        console.log('ℹ️  No active sessions - skipping snapshot')
      }
      // No active sessions - don't create snapshots for dates without CSV uploads
    } catch (error) {
      console.error('❌ Error saving snapshot:', error.message)
      console.error('Stack:', error.stack)
    }

    console.log('✅ Price update job completed successfully')
  } catch (error) {
    console.error('❌ FATAL: Error in price update job:', error.message)
    console.error('Stack:', error.stack)
    // Log but don't crash - the global handlers will catch it
  }
}, 60000) // Every 1 minute
*/

console.log('ℹ️  Price update background job is DISABLED - investigating crashes')

// Daily database cleanup (runs at 3 AM)
const scheduleCleanup = () => {
  try {
    const now = new Date()
    const next3AM = new Date(now)
    next3AM.setHours(3, 0, 0, 0)

    if (next3AM <= now) {
      next3AM.setDate(next3AM.getDate() + 1)
    }

    const timeUntilCleanup = next3AM.getTime() - now.getTime()

    setTimeout(() => {
      try {
        console.log('🧹 Running daily database cleanup...')
        databaseService.cleanup()
        console.log('✅ Daily database cleanup complete')
        scheduleCleanup() // Schedule next cleanup
      } catch (error) {
        console.error('❌ Error in daily database cleanup:', error.message)
        console.error('Stack:', error.stack)
        // Still schedule next cleanup even if this one failed
        scheduleCleanup()
      }
    }, timeUntilCleanup)

    console.log(`📅 Next database cleanup scheduled for ${next3AM.toLocaleString()}`)
  } catch (error) {
    console.error('❌ Error scheduling database cleanup:', error.message)
    console.error('Stack:', error.stack)
  }
}
scheduleCleanup()

// REST API endpoints (optional, for HTTP access)
app.get('/', (req, res) => {
  res.json({
    name: 'Robinhood P&L Tracker Server',
    status: 'running',
    version: '2.0.0',
    endpoints: {
      health: '/health',
      prices: '/prices?symbols=AAPL,GOOGL',
      trackedSymbols: '/api/tracked-symbols',
      signalAccuracy: '/api/signal-accuracy?symbol=AAPL&hours=168',
      signals: '/api/signals/:symbol?limit=50',
      priceHistory: '/api/prices/:symbol?limit=288'
    }
  })
})

app.get('/health', (req, res) => {
  try {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      clients: clientSessions.size,
      trackedSymbols: priceService.getTrackedSymbols().length,
      recordingSymbols: trackedSymbols.size,
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    }
    console.log(`✅ Health check: ${healthData.status}, uptime: ${Math.round(healthData.uptime)}s, memory: ${healthData.memory.used}MB`)
    res.json(healthData)
  } catch (error) {
    console.error('❌ Error in health endpoint:', error.message)
    res.status(500).json({
      status: 'error',
      error: error.message
    })
  }
})

// Authentication endpoints
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password, email } = req.body
    const user = await authService.createUser(username, password, email)
    res.json({ success: true, user })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body
    const result = await authService.login(username, password)

    // Set session cookie (httpOnly for security). `secure` in production so the
    // cookie is only sent over HTTPS (Railway serves HTTPS).
    res.cookie('session_token', result.sessionToken, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    })

    res.json({ success: true, user: { ...result.user, userId: result.user.id } })
  } catch (error) {
    res.status(401).json({ success: false, error: error.message })
  }
})

app.post('/api/auth/logout', (req, res) => {
  try {
    const sessionToken = req.cookies.session_token
    if (sessionToken) {
      authService.logout(sessionToken)
      res.clearCookie('session_token')
    }
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.get('/api/auth/me', (req, res) => {
  try {
    const sessionToken = req.cookies.session_token
    const user = authService.verifySession(sessionToken)

    if (user) {
      res.json({ success: true, user })
    } else {
      res.status(401).json({ success: false, error: 'Not authenticated' })
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Middleware to require authentication for protected routes.
// Verifies the httpOnly session cookie and attaches { userId, username, email }.
const requireAuth = (req, res, next) => {
  const user = authService.verifySession(req.cookies?.session_token)
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' })
  }
  req.user = user
  next()
}

// Debug endpoint to test Polygon connection and open option positions
app.get('/api/debug/polygon-options', requireAuth, async (req, res) => {
  try {
    const polygonKey = process.env.POLYGON_API_KEY || 'YOUR_API_KEY_HERE'
    const keyPreview = polygonKey.slice(0, 6) + '...'
    const openOpts = databaseService.getOpenOptionPositions(req.user.userId)

    const results = []
    for (const pos of openOpts) {
      const polygonTicker = toPolygonTicker(pos.symbol)
      const parsed = parseOptionDescription(pos.symbol)
      let polygonResult = null
      let error = null
      if (polygonTicker && parsed) {
        try {
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
          const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 8000 })
          polygonResult = resp.data
        } catch (e) {
          error = e.message
        }
      }
      results.push({ symbol: pos.symbol, polygonTicker, net_long: pos.net_long, net_short: pos.net_short, polygonResult, error })
    }

    res.json({ success: true, keyPreview, openPositionCount: openOpts.length, results })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// What-If analysis: compare hold-to-expiry vs actual P&L for a week's original opens
// Optional ?week=YYYY-MM-DD to analyze a historical week (uses DB outcomes instead of Polygon)
app.get('/api/whatif', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const today = new Date().toISOString().slice(0, 10)

    // Determine which week to analyze
    const weekParam = req.query.week || null
    let mondayStr, nextMondayStr

    if (weekParam) {
      mondayStr = weekParam
      const next = new Date(weekParam + 'T12:00:00')
      next.setDate(next.getDate() + 7)
      nextMondayStr = next.toISOString().slice(0, 10)
    } else {
      const now = new Date()
      const dow = now.getDay()
      const monday = new Date(now)
      monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1))
      monday.setHours(0, 0, 0, 0)
      mondayStr = monday.toISOString().slice(0, 10)
      nextMondayStr = null
    }

    const isHistorical = weekParam !== null

    // Pull all option trades for the target week
    const weekTrades = databaseService.getOptionTradesForWeek(userId, mondayStr, nextMondayStr)

    // Group by contract symbol — track opens and closes separately
    const contractMap = {}
    weekTrades.forEach(t => {
      const tc = (t.trans_code || '').toUpperCase()
      if (!['BTO', 'STO', 'BTC', 'STC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)) return
      const symbol = t.symbol
      if (!symbol) return
      const isClosing = ['BTC', 'STC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)
      const isExpiry = ['OEXP', 'OASGN', 'OEXC'].includes(tc)
      const cashFlow = t.is_buy ? -(t.amount || 0) : (t.amount || 0)
      const contracts = Math.abs(t.quantity || 1)

      if (!contractMap[symbol]) {
        contractMap[symbol] = { symbol, parsed: parseOptionDescription(symbol), opens: [], closes: [], expired: false }
      }
      const cm = contractMap[symbol]
      if (isClosing) {
        cm.closes.push({ contracts, cashFlow, tc, isExpiry })
        if (isExpiry) cm.expired = true
      } else {
        cm.opens.push({ contracts, cashFlow, price: t.price || 0, date: t.trans_date })
      }
    })

    const polygonKey = process.env.POLYGON_API_KEY || ''
    const results = []

    for (const cm of Object.values(contractMap)) {
      if (!cm.parsed || cm.opens.length === 0) continue
      const expiry = `${cm.parsed.year}-${cm.parsed.month}-${cm.parsed.day}`
      const isExpired = cm.expired || expiry < today

      const totalOpenContracts = cm.opens.reduce((s, o) => s + o.contracts, 0)
      const totalOpenPremium = cm.opens.reduce((s, o) => s + o.cashFlow, 0) // + for STO (received), - for BTO (paid)
      const isShort = totalOpenPremium >= 0
      const avgOpenPrice = totalOpenContracts > 0 ? Math.abs(totalOpenPremium) / totalOpenContracts : 0

      // Contracts closed early (BTC/STC, not expiry)
      const earlyClosedContracts = cm.closes.filter(c => !c.isExpiry).reduce((s, c) => s + c.contracts, 0)
      const stillOpenContracts = Math.max(0, totalOpenContracts - cm.closes.reduce((s, c) => s + c.contracts, 0))

      // Determine the current mark price for the "hold" scenario
      let currentMark = 0
      let outcomeCode = null
      if (!isExpired) {
        if (isHistorical) {
          // For historical weeks: look up the eventual OEXP/OASGN/OEXC outcome in the DB
          const outcome = databaseService.getContractOutcome(userId, cm.symbol)
          if (outcome) {
            outcomeCode = (outcome.trans_code || '').toUpperCase()
            if (['OASGN', 'OEXC'].includes(outcomeCode) && cm.parsed.strike) {
              // Assigned/exercised: compute intrinsic value from stock price on that date
              try {
                const stockPrice = await priceService.getPriceForDate(cm.parsed.ticker, outcome.trans_date)
                const strike = cm.parsed.strike
                currentMark = cm.parsed.type === 'call'
                  ? Math.max(0, stockPrice - strike)
                  : Math.max(0, strike - stockPrice)
              } catch (e) { currentMark = 0 }
            }
            // OEXP → currentMark stays 0 (expired worthless)
          }
        } else if (polygonKey) {
          // For current week: fetch live mark from Polygon
          const polygonTicker = toPolygonTicker(cm.symbol)
          if (polygonTicker) {
            try {
              const url = `https://api.polygon.io/v3/snapshot/options/${cm.parsed.ticker}/${polygonTicker}`
              const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 5000 })
              const snap = resp.data?.results
              if (snap) {
                const mid = snap.last_quote?.midpoint ||
                  (snap.last_quote?.bid && snap.last_quote?.ask
                    ? (snap.last_quote.bid + snap.last_quote.ask) / 2 : 0)
                const fallback = snap.day?.close || snap.last_trade?.price || 0
                currentMark = Math.max(mid || 0, fallback || 0) || mid || fallback || 0
              }
            } catch (e) { /* ignore */ }
          }
        }
      }

      // Hold P&L: what if they held ALL originally opened contracts from open to now
      const holdPnl = isShort
        ? Math.round((totalOpenPremium - currentMark * totalOpenContracts * 100) * 100) / 100
        : Math.round((currentMark * totalOpenContracts * 100 + totalOpenPremium) * 100) / 100  // totalOpenPremium is negative for BTO

      // Actual cash-flow P&L: net of all open + close premiums on this contract
      const totalClosePremium = cm.closes.reduce((s, c) => s + c.cashFlow, 0)
      const actualCashFlow = Math.round((totalOpenPremium + totalClosePremium) * 100) / 100

      results.push({
        symbol: cm.symbol,
        ticker: cm.parsed.ticker,
        expiry,
        strike: cm.parsed.strike,
        optionType: cm.parsed.type,
        isShort,
        openContracts: totalOpenContracts,
        avgOpenPrice: Math.round(avgOpenPrice * 100) / 100,
        currentMark: Math.round(currentMark * 100) / 100,
        holdPnl,
        actualCashFlow,
        earlyClosedContracts,
        stillOpenContracts,
        expired: isExpired,
        outcomeCode
      })
    }

    results.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.expiry.localeCompare(b.expiry))
    res.json({ success: true, whatIf: results, isHistorical, weekStart: mondayStr })
  } catch (error) {
    console.error('Error in /api/whatif:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Dedicated lightweight endpoint: open option positions with live mark prices
app.get('/api/options-pnl/open-positions', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const polygonKey = process.env.POLYGON_API_KEY || ''
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const openOpts = databaseService.getOpenOptionPositions(req.user.userId, brokerFilter)

    // Filter out positions where option has already expired
    const activeOpts = openOpts.filter(pos => {
      const parsed = parseOptionDescription(pos.symbol)
      if (!parsed) return false
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      return expiry >= today
    })

    console.log(`Open option positions: ${openOpts.length} total, ${activeOpts.length} non-expired`)

    // Collect all unique underlying tickers (active + historical) for stock price fetch
    const allOptionTrades = databaseService.getOptionTrades(req.user.userId, brokerFilter)
    const allUnderlyingTickers = [...new Set([
      ...activeOpts.map(pos => parseOptionDescription(pos.symbol)?.ticker),
      ...allOptionTrades.map(t => parseOptionDescription(t.symbol)?.ticker)
    ].filter(Boolean))]

    // Fetch Polygon mark prices + underlying stock prices
    const markPrices = {}
    const polygonStockPrices = {}
    if (polygonKey) {
      // Step 1: options snapshots for active positions (gets mark price + underlying price in one call)
      for (const pos of activeOpts) {
        const polygonTicker = toPolygonTicker(pos.symbol)
        const parsed = parseOptionDescription(pos.symbol)
        if (!polygonTicker || !parsed) continue
        try {
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
          const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 8000 })
          const snap = resp.data?.results
          if (snap) {
            const mid = snap.last_quote?.midpoint || (snap.last_quote?.bid && snap.last_quote?.ask ? (snap.last_quote.bid + snap.last_quote.ask) / 2 : 0)
            const bid = snap.last_quote?.bid || 0
            const ask = snap.last_quote?.ask || 0
            const fallback = snap.day?.close || snap.last_trade?.price || 0
            // Use the higher of midpoint vs day close — deep ITM options often have stale quotes
            const best = Math.max(mid || 0, fallback || 0) || mid || fallback || 0
            markPrices[pos.symbol] = { bid, ask, mid: best, fallback }
            const underlyingPrice = snap.underlying_asset?.price
            if (underlyingPrice > 0) polygonStockPrices[parsed.ticker] = underlyingPrice
          } else {
            console.warn(`Polygon ${pos.symbol}: no results — status=${resp.data?.status}`)
          }
        } catch (e) {
          console.warn(`Polygon mark price failed for ${pos.symbol}:`, e.response?.status, e.message)
        }
      }

      // Stock prices for closed-option tickers come from the frontend (stockEntry?.toPrice)
      // No additional fetch needed here — underlying_asset.price covers active positions
    } else {
      console.warn('POLYGON_API_KEY not set — skipping options mark prices')
    }

    // Underlying stock prices — fall back to a direct quote fetch for tickers the
    // option snapshot didn't cover, so we can model a mark when an option has no
    // live quote (common for thin / far-OTM strikes on the delayed data plan).
    const needTickers = allUnderlyingTickers.filter(t => !(polygonStockPrices[t] > 0))
    if (needTickers.length > 0) {
      try {
        const fetched = await priceService.fetchPrices(needTickers)
        needTickers.forEach(t => { if (fetched[t] > 0) polygonStockPrices[t] = fetched[t] })
      } catch (e) { console.warn('open-positions stock price fallback failed:', e.message) }
    }
    // Short-call entries carry the sale-day premium + underlying, letting us model a
    // Black–Scholes mark when a short call has no live option quote.
    const shortEntryBySymbol = {}
    for (const e of databaseService.getShortCallEntries(req.user.userId)) shortEntryBySymbol[e.symbol] = e

    const positions = []
    activeOpts.forEach(pos => {
      const quotes = markPrices[pos.symbol] || null
      const parsed = parseOptionDescription(pos.symbol)
      if (!parsed) return
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      const isLong = pos.net_long > 0
      const openContracts = isLong ? pos.net_long : pos.net_short
      const totalCostBasis = isLong ? pos.total_paid : pos.total_received
      const avgCostPerContract = openContracts > 0 ? Math.abs(totalCostBasis) / (isLong ? pos.bto_contracts : pos.sto_contracts) : 0
      const underlyingNow = polygonStockPrices[parsed.ticker] || 0
      // Prefer a live quote; else model a mark so the position still shows a P&L
      // (otherwise the tax/close simulation can't include it). Short calls get a
      // Black–Scholes mark anchored to their sale premium; everything else falls
      // back to intrinsic value (0 for an OTM option ≈ worthless).
      let mark = quotes?.mid || 0
      let markSource = mark > 0 ? 'quote' : null
      if (!(mark > 0) && underlyingNow > 0) {
        const entry = shortEntryBySymbol[pos.symbol]
        const modeled = (!isLong && parsed.type === 'call' && entry) ? modelOptionMark(entry, parsed, underlyingNow) : 0
        if (modeled > 0) { mark = modeled; markSource = 'model' }
        else {
          mark = parsed.type === 'call' ? Math.max(0, underlyingNow - parsed.strike) : Math.max(0, parsed.strike - underlyingNow)
          markSource = 'intrinsic'
        }
      }
      const currentValue = mark * 100 * openContracts
      const unrealizedPnl = isLong
        ? currentValue - (avgCostPerContract * openContracts)
        : (avgCostPerContract * openContracts) - currentValue

      const stockPrice = polygonStockPrices[parsed.ticker] || null

      // Remaining premium (extrinsic value) for short calls and long puts
      let remainingPremium = null
      let remainingPremiumLabel = null
      if (mark > 0 && stockPrice) {
        if (!isLong && parsed.type === 'call') {
          const intrinsic = Math.max(0, stockPrice - parsed.strike)
          const extrinsic = Math.round(Math.max(0, mark - intrinsic) * 100) / 100
          if (extrinsic > 0) { remainingPremium = extrinsic; remainingPremiumLabel = 'Rem Short Call Premium' }
        } else if (isLong && parsed.type === 'put') {
          const intrinsic = Math.max(0, parsed.strike - stockPrice)
          const extrinsic = Math.round(Math.max(0, mark - intrinsic) * 100) / 100
          if (extrinsic > 0) { remainingPremium = extrinsic; remainingPremiumLabel = 'Rem Long Put Premium' }
        }
      }

      positions.push({
        symbol: pos.symbol,
        ticker: parsed.ticker,
        expiry,
        strike: parsed.strike,
        optionType: parsed.type,
        openContracts,
        isLong,
        avgCostPerContract: Math.round(avgCostPerContract * 100) / 100,
        markPrice: mark,
        markSource,
        currentValue: Math.round(currentValue * 100) / 100,
        unrealizedPnl: markSource ? Math.round(unrealizedPnl * 100) / 100 : null,
        stockPrice,
        remainingPremium,
        remainingPremiumLabel
      })
    })

    positions.sort((a, b) => a.expiry.localeCompare(b.expiry))

    const allStockPrices = polygonStockPrices

    res.json({
      success: true,
      positions,
      stockPrices: allStockPrices,
      fetchedAt: new Date().toISOString(),
      expiredFiltered: openOpts.length - activeOpts.length,
      polygonEnabled: !!polygonKey
    })
  } catch (e) {
    console.error('Error in /api/options-pnl/open-positions:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/options-pnl/ytd — options P&L per underlying from a configurable start date
app.get('/api/options-pnl/ytd', requireAuth, async (req, res) => {
  // basis=corrected -> FIFO cost basis, settlements booked into realized, long
  // option legs counted in Open P&L. Default keeps every figure as it was.
  const corrected = req.query.basis === 'corrected'
  try {
    const userId = req.user.userId
    const globalStart = req.query.startDate || '2000-01-01'
    const perSymbolDates = req.query.symbolDates ? JSON.parse(req.query.symbolDates) : {}
    // Point-in-time "as of" date (YYYY-MM-DD): chop off trades after it and price
    // everything as of that day's close. When absent, this is the normal live view.
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf || '') ? req.query.asOf : null

    // Broker tab: 'all' (or absent) keeps every broker. Filtering here rather
    // than in the query keeps the LIFO pass below matching only within the
    // selected broker, which is the same rule the stock P&L follows.
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null

    const allTrades0 = databaseService.getOptionTradesForYTD(userId)
    let allTrades = asOf ? allTrades0.filter(t => t.trans_date <= asOf) : allTrades0
    if (brokerFilter) allTrades = allTrades.filter(t => (t.broker || 'robinhood') === brokerFilter)

    // LIFO pass over ALL trades
    const lifoStacks = {}
    const isOpening = tc => ['BTO', 'STO'].includes((tc || '').toUpperCase())
    const sortedTrades = [...allTrades].sort((a, b) =>
      a.trans_date.localeCompare(b.trans_date) ||
      (isOpening(a.trans_code) ? 0 : 1) - (isOpening(b.trans_code) ? 0 : 1)
    )
    sortedTrades.forEach(t => {
      const tc = (t.trans_code || '').toUpperCase()
      const parsed = parseOptionDescription(t.symbol || '')
      // Broker is part of the stack key for the same reason it's part of the
      // stock matching: a close at one broker can't lift a position opened at
      // another. With no filter this keeps each broker's stack separate and
      // the realized totals simply add up.
      const contractKey = parsed
        ? `${parsed.ticker}|${parsed.year}${parsed.month}${parsed.day}|${parsed.type}|${parsed.strike}`
        : (t.symbol || '')
      const sym = `${t.broker || 'robinhood'}::${contractKey}`
      const contracts = Math.abs(t.contracts || 1)
      const amount = Math.abs(t.amount)
      const ppc = contracts > 0 ? amount / contracts : amount
      if (!lifoStacks[sym]) lifoStacks[sym] = { long: [], short: [] }
      const stacks = lifoStacks[sym]
      if (tc === 'BTO') {
        stacks.long.push({ ppc, remaining: contracts, symbol: t.symbol, parsed })
      } else if (tc === 'STO') {
        stacks.short.push({ ppc, remaining: contracts, symbol: t.symbol, parsed })
      } else if (['STC', 'BTC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)) {
        // Settlements book on BOTH bases now.
        //
        // The legacy basis used to skip them. That was a faithful reproduction of
        // an older bug — a settlement's symbol carried an "Option Expiration for"
        // prefix, so it never matched the contract it closed — kept deliberately
        // so the figure read as it always had. It was calibrated on a book whose
        // expiries were mostly SHORT calls expiring worthless, where booking
        // nothing and keeping the premium land in roughly the same place.
        //
        // It is wrong for bought options. A long that expires out of the money is
        // a real loss of the whole premium, and skipping it made those losses
        // disappear from Options YTD entirely — a weekly habit of cheap OTM puts
        // put thousands a year into that gap while the Dashboard, on the corrected
        // basis, booked them correctly all along.
        let closingShort, stack
        if (tc === 'BTC') { stack = stacks.short; closingShort = true }
        else if (tc === 'STC' || tc === 'OEXC') { stack = stacks.long; closingShort = false }
        else { closingShort = stacks.short.length > 0; stack = closingShort ? stacks.short : stacks.long }
        let left = contracts; let costBasis = 0
        while (left > 0 && stack.length > 0) {
          const top = stack[stack.length - 1]
          const matched = Math.min(left, top.remaining)
          costBasis += matched * top.ppc
          left -= matched; top.remaining -= matched
          if (top.remaining === 0) stack.pop()
        }
        if (left === 0) {
          const proceeds = ['OEXP', 'OASGN'].includes(tc) ? 0 : amount
          t._realizedPnl = Math.round((closingShort ? costBasis - proceeds : proceeds - costBasis) * 100) / 100
          t._closingShort = closingShort
        }
      }
    })

    // Open Premium = credit collected on OPEN SHORT calls. This is sourced from the
    // SAME data the Short Call Tracker uses (short_call_entries), NOT the LIFO trade
    // stacks. The trades table's short stack can be empty (e.g. multi-fill collapse or
    // short opens recorded only as entries), so deriving it here guaranteed the two
    // panels disagreed. Mirroring the tracker keeps Open Premium / Open P&L consistent.
    const openPremiumByTicker = {}
    const openUnrealizedByTicker = {}
    const openDailyByTicker = {}   // option side of today's mark-to-market move (EOD close → now)
    // Which basis each ticker's day move came from, so a figure that disagrees
    // with a broker can be explained instead of guessed at.
    const dayBasisByTicker = {}    // ticker -> { market: n, model: n }
    // Tickers with a leg whose day move can't be established. A day is only
    // reportable when every part of the position is in it — a partial one is a
    // different number, and on a down day an opposite-signed one.
    const dayGapTickers = new Set()
    // ticker -> 'market' | 'model' | 'mixed', from how each leg's mark was got.
    const openBasisByTicker = {}
    // What it would really cost to get out: shorts bought back at the ASK,
    // longs sold at the BID. Always worse than the mid-based figure, which is
    // the point — the mid is a valuation convention, not a fill.
    const openExitByTicker = {}
    const exitSpreadByTicker = {}   // total mid-vs-exit gap, so the cost is visible
    // Theta projection: what Open P&L becomes in 1/2/3 months if the underlying
    // doesn't move. Keyed [months][ticker].
    const PROJECT_MONTHS = [1, 2, 3]
    const openProjectedByTicker = { 1: {}, 2: {}, 3: {} }
    const openProjectedLegs = { 1: {}, 2: {}, 3: {} }   // { ticker: {expired, total} }

    // What-if: every underlying shocked by a percentage, right now. The theta
    // projection next door moves time with the underlying held still; this is
    // the same repricing with the axes swapped — the underlying moves and time
    // stands still, so what comes back is the move's effect alone.
    //
    // Vol is held at whatever is backed out of the current mark (sticky strike).
    // Real markets reprice vol on a large move — a selloff especially — so the
    // downside here is the optimistic end of the range, not a forecast.
    const SCENARIO_MOVES = [-30, -20, -15, -10, -5, -2.5, 2.5, 5, 10, 15, 20, 30]
    const openScenarioByTicker = {}          // { move: { ticker: pnl } }
    SCENARIO_MOVES.forEach(m => { openScenarioByTicker[m] = {} })
    const polygonKey = process.env.POLYGON_API_KEY || ''
    if (!asOf) {
      const shortEntries = databaseService.getShortCallEntries(userId, brokerFilter)
      const openPositions = databaseService.getOpenOptionPositions(userId, brokerFilter)
      // What was held INTO today vs opened today. A leg opened this morning has
      // no business carrying yesterday's move: a PLTR $170 put re-bought for
      // pennies was charged the 3.15 -> 0.12 collapse it was flat through.
      const dayBaseline = databaseService.getOptionDayBaseline(userId, todayStrLocal(), brokerFilter)
      // Split a leg's size into the part held overnight and the part added today,
      // and price each from the right starting point. Returns total dollars.
      //   overnightPerShare — the leg's move from yesterday's close (already signed
      //                       for the side by the caller)
      //   nowMark           — the current mark per share
      //   entryPrice        — average price paid/received per share for today's opens
      const daySplit = (symbol, contracts, side, overnightPerShare, nowMark) => {
        const b = dayBaseline[symbol]
        if (!b) return overnightPerShare * contracts * 100
        const prior = side === 'short' ? b.priorShort : b.priorLong
        const held = Math.max(0, Math.min(prior, contracts))
        const fresh = Math.max(0, contracts - held)
        let total = overnightPerShare * held * 100
        if (fresh > 0) {
          const entry = side === 'short' ? b.openedShortPrice : b.openedLongPrice
          // No usable entry price means nothing honest to say about the new part;
          // leaving it out beats inventing a move from a close it never saw.
          if (entry > 0 && nowMark > 0) {
            const perShare = side === 'short' ? (entry - nowMark) : (nowMark - entry)
            total += perShare * fresh * 100
          }
        }
        return total
      }
      const netShortBySymbol = {}
      openPositions.forEach(p => { netShortBySymbol[p.symbol] = p.net_short })
      const openShortSymbols = new Set(openPositions.filter(p => p.net_short > 0).map(p => p.symbol))
      // Open AND not yet expired. An expired contract can't be marked to market
      // — Polygon answers "Options contract not found" — so pricing it is a
      // guaranteed-failed request on every page load. MRVL alone was making a
      // dozen of them.
      //
      // getOpenOptionPositions already nets settlements out, so anything still
      // listed as open past its expiry is a contract whose settlement never
      // arrived in the CSV rather than a live position. Either way there's
      // nothing to price.
      const notExpired = (sym) => {
        const p = parseOptionDescription(sym)
        if (!p) return true                     // unparseable: leave it alone
        return `${p.year}-${p.month}-${p.day}` >= todayStrLocal()
      }
      const openEntries = shortEntries.filter(e => openShortSymbols.has(e.symbol) && notExpired(e.symbol))
      // How many of each entry's contracts are still open, netted from trades.
      const openContractsByEntry = allocateOpenShortContracts(
        openEntries, openShortSymbols, netShortBySymbol)

      // Open LONG legs. Everything below used to run off short_call_entries only,
      // so a bought contract contributed nothing to Open P&L, Day P&L, the theta
      // projection or the what-if. On a vertical that shows the short leg's loss
      // on a rally with no offsetting gain from the long leg, and no shares to
      // add a positive either — the day reads far worse than the position did,
      // which is indistinguishable from a sign error.
      const openLongs = openPositions
        .filter(p => p.net_long > 0)
        .map(p => {
          const parsed = parseOptionDescription(p.symbol)
          if (!parsed) return null
          return {
            symbol: p.symbol,
            ticker: parsed.ticker,
            parsed,
            contracts: p.net_long,
            // Per SHARE, to match how the short side carries premium.
            costPerShare: p.bto_contracts > 0 ? Math.abs(p.total_paid) / p.bto_contracts / 100 : 0,
          }
        })
        .filter(Boolean)

      // Every leg that needs a mark, long or short.
      const priceLegs = [
        ...openEntries.map(e => ({ symbol: e.symbol, ticker: e.ticker })),
        // Priced on both bases: the legacy basis still needs these for the day
        // move, even though it leaves them out of the cumulative figures.
        ...openLongs.filter(l => notExpired(l.symbol)).map(l => ({ symbol: l.symbol, ticker: l.ticker })),
      ].filter((v, i, a) => a.findIndex(x => x.symbol === v.symbol) === i)

      // Fetch current per-share option prices for the open short calls (same as tracker):
      // real quote mid → Black–Scholes model mark → stale daily close.
      // optToday: a real trade or close printed TODAY. It sits between a live
      // quote and the model, because it's a measurement rather than an estimate
      // — the model should only win when the market hasn't spoken recently.
      const optFresh = {}, optToday = {}, optClose = {}, optPrevClose = {}, stockByTicker = {}
      // Raw bid/ask per contract, for the realistic cost of getting out.
      const optQuote = {}
      // When each stale close was printed, so it can be aged forward.
      const optCloseDate = {}
      if (polygonKey && priceLegs.length > 0) {
        await Promise.all(priceLegs.map(async entry => {
          const polyTicker = toPolygonTicker(entry.symbol)
          const parsed = parseOptionDescription(entry.symbol)
          if (!polyTicker || !parsed) return
          const quote = await fetchOptionQuote(polyTicker, polygonKey)
          const qMid = quote.mid
          if (qMid > 0) optFresh[entry.symbol] = qMid
          if (quote.bid > 0 || quote.ask > 0) optQuote[entry.symbol] = quote
          try {
            const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polyTicker}`
            const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })
            const snap = resp.data?.results
            if (snap) {
              if (!(qMid > 0)) {
                const fresh = freshOptionMark(snap)
                if (fresh > 0) optFresh[entry.symbol] = fresh
              }
              const stale = staleOptionMark(snap)
              if (stale > 0) {
                optClose[entry.symbol] = stale
                const md = marketMarkDate(snap)
                if (md) optCloseDate[entry.symbol] = md
                // A print from TODAY is real market data and outranks the model;
                // only an old one is a fallback.
                if (marketMarkIsToday(snap)) optToday[entry.symbol] = stale
              }
              // Option's prior-day EOD close (for today's mark-to-market move) — same snapshot, no extra call.
              if (snap.day?.previous_close > 0) optPrevClose[entry.symbol] = snap.day.previous_close
              const u = snap.underlying_asset?.price
              if (u > 0) stockByTicker[parsed.ticker] = u
            }
          } catch (e) { /* no price for this leg */ }
        }))
        // Resolve any missing underlying stock prices (Yahoo fallback), like the tracker,
        // so the Black–Scholes model has an underlying and doesn't fall to the stale close.
        const openTickers = [...new Set(priceLegs.map(e => e.ticker).filter(Boolean))]
        const missing = openTickers.filter(t => !(stockByTicker[t] > 0))
        if (missing.length > 0) {
          try {
            const fetched = await priceService.fetchPrices(missing)
            missing.forEach(t => { if (fetched[t] > 0) stockByTicker[t] = fetched[t] })
          } catch (e) { /* leave missing */ }
        }
      }

      // Yesterday's underlying close for the open names, so the daily option move can be
      // priced on the SAME basis as "now" (model↔model) rather than mixing a live model
      // mark with a stale market print — otherwise a short call looks like it moved the
      // wrong way on a big stock day.
      const openPrevUnderlying = {}
      {
        const openTickers = [...new Set(priceLegs.map(e => e.ticker).filter(Boolean))]
        if (openTickers.length > 0) {
          try {
            const dc = await priceService.fetchDailyChange(openTickers)
            Object.entries(dc).forEach(([t, v]) => { if (v.prevClose > 0) openPrevUnderlying[t] = v.prevClose })
          } catch (e) { /* fall back to the market prior close below */ }
        }
      }

      // Underlying prices on each stale close's date, fetched up front because
      // the loop below is synchronous. One lookup per distinct (ticker, date)
      // rather than per contract — several strikes usually share a close date.
      const undThenByKey = {}
      {
        const needed = [...new Set(
          openEntries
            .filter(e => optClose[e.symbol] > 0 && optCloseDate[e.symbol] && e.ticker)
            .map(e => `${e.ticker}|${optCloseDate[e.symbol]}`)
        )]
        await Promise.all(needed.map(async key => {
          const [tk, dt] = key.split('|')
          try {
            const px = await priceService.getPriceForDate(tk, dt)
            if (px > 0) undThenByKey[key] = px
          } catch (e) { /* leave missing; the model still covers it */ }
        }))
      }

      openEntries.forEach(entry => {
        const ticker = entry.ticker
        if (!ticker) return
        // Size from the position still OPEN, not from what was once sold. The
        // old rescale only fired for single-entry symbols and only corrected
        // undercounts, so a partly-bought-back contract stayed overstated.
        const entryContracts = entry.contracts || 1
        const alloc = openContractsByEntry[entry.id]
        const effContracts = alloc != null ? alloc : entryContracts
        const shares = effContracts * 100
        const premiumPerShare = entryContracts > 0 ? entry.premium / (entryContracts * 100) : entry.premium
        const parsed = parseOptionDescription(entry.symbol)
        openPremiumByTicker[ticker] = (openPremiumByTicker[ticker] || 0) + premiumPerShare * shares
        // Priority: live quote -> a print from TODAY -> model -> stale close.
        //
        // The middle step is new. A contract that traded today has a real market
        // price sitting in the same field as one that last traded weeks ago, and
        // both were being passed over for the model. That's right for the frozen
        // one and wrong for the fresh one — and the model can drift a long way,
        // because its vol is backed out of the ORIGINAL sale. MRVL was sold near
        // $150 and now trades near $236, so a vol anchored to that sale is
        // describing a different world. That's where -3,200 against a broker's
        // -2,000 comes from.
        const usedQuote = optFresh[entry.symbol] != null
        let currentOptionPrice = optFresh[entry.symbol]
        // Which basis this mark is on decides what it can legitimately be
        // compared against. 'quote' and 'close' both come from the market;
        // 'model' is a Black-Scholes estimate and is only comparable to another
        // run of the same model.
        let markBasis = usedQuote ? 'quote' : null
        if (currentOptionPrice == null && optToday[entry.symbol] > 0) {
          currentOptionPrice = optToday[entry.symbol]
          markBasis = 'today'
        }
        // A stale close AGED FORWARD for what the underlying has done since.
        //
        // This is the case that produced -3,363 against a broker's -2,000. The
        // MRVL 2028 $380 last printed at $76.25 with a volume of ONE, four days
        // ago — and MRVL has fallen 8.65% since. Using that print unchanged
        // marks the position at a price the stock no longer supports.
        //
        // Ageing it is strictly better than either alternative: it starts from
        // a real trade in THIS contract rather than a months-old sale like the
        // model does, and unlike the raw close it accounts for the move since.
        // Same repricing the extended-hours view already uses.
        if (currentOptionPrice == null) {
          const closeMark = optClose[entry.symbol]
          const closeDate = optCloseDate[entry.symbol]
          const undNow = stockByTicker[entry.ticker]
          if (closeMark > 0 && closeDate && undNow > 0) {
            try {
              const undThen = undThenByKey[`${entry.ticker}|${closeDate}`] || 0
              if (undThen > 0 && Math.abs(undNow - undThen) / undThen > 0.001) {
                const yrs = ms => ms / (365.25 * 24 * 3600 * 1000)
                const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
                const T0 = yrs(new Date(expiry).getTime() - new Date(closeDate).getTime())
                const T1 = yrs(new Date(expiry).getTime() - Date.now())
                if (T0 > 0 && T1 > 0) {
                  const sigma = impliedVol(closeMark, undThen, parsed.strike, T0, RISK_FREE_RATE, parsed.type)
                  if (sigma > 0) {
                    const aged = repriceFromClose({
                      type: parsed.type, closeMark, S0: undThen, S1: undNow,
                      K: parsed.strike, T0, T1, sigma, r: RISK_FREE_RATE,
                    })
                    if (aged > 0) { currentOptionPrice = aged; markBasis = 'agedClose' }
                  }
                }
              }
            } catch (e) { /* fall through to the model */ }
          }
        }

        if (currentOptionPrice == null) {
          const model = modelOptionMark(entry, parsed, stockByTicker[entry.ticker])
          if (model > 0) { currentOptionPrice = model; markBasis = 'model' }
          else { currentOptionPrice = optClose[entry.symbol]; markBasis = 'close' }
        }
        if (currentOptionPrice != null) {
          // Short: buying it back costs the ask. Without a two-sided quote there
          // is nothing honest to say, so it contributes nothing rather than
          // silently reusing the mid and pretending it's an exit price.
          const q = optQuote[entry.symbol]
          if (q?.ask > 0) {
            openExitByTicker[ticker] = (openExitByTicker[ticker] || 0) + (premiumPerShare - q.ask) * shares
            if (q.mid > 0) {
              exitSpreadByTicker[ticker] = (exitSpreadByTicker[ticker] || 0) + (q.ask - q.mid) * shares
            }
          }

          // Aged and modelled marks are both estimates. Grouping the aged one
          // with the market would hide that it's been adjusted.
          const isMarket = markBasis === 'quote' || markBasis === 'today'
          const prevBasis = openBasisByTicker[ticker]
          const thisBasis = isMarket ? 'market' : 'model'
          openBasisByTicker[ticker] = !prevBasis ? thisBasis
            : prevBasis === thisBasis ? thisBasis : 'mixed'
          // Short call P&L = (premium collected − current cost to buy back) × shares.
          openUnrealizedByTicker[ticker] =
            (openUnrealizedByTicker[ticker] || 0) + (premiumPerShare - currentOptionPrice) * shares
          // Today's option move for a short: (yesterday's mark − now) × shares. Positive when
          // the call got cheaper today. Price both ends on the same basis so the option
          // correctly offsets the stock (short call loses when the stock rises):
          //   • live quote  → yesterday's market close vs today's quote
          //   • modeled LEAP → same Black–Scholes model at yesterday's vs today's underlying
          const prevMkt = optPrevClose[entry.symbol]
          // Order matters, and both extremes have burned us. A LIVE quote at
          // both ends is the actual move and beats any model of it — modelled
          // deltas overstated a short call's loss on a rally and put the day at
          // -485 against a broker's +900. But a STALE daily close is not
          // today's market data, and treating it as if it were invents moves on
          // contracts that barely trade. So: live quote, then the model, then
          // two daily prints.
          let dayOptPerShare = null
          if ((optFresh[entry.symbol] > 0 || optToday[entry.symbol] > 0) && prevMkt > 0) {
            // A LIVE quote against yesterday's close. Both market, both current.
            dayOptPerShare = prevMkt - (optFresh[entry.symbol] || optToday[entry.symbol])
          } else if (openPrevUnderlying[ticker] > 0 && stockByTicker[ticker] > 0) {
            const mNow = modelOptionMark(entry, parsed, stockByTicker[ticker])
            const mPrev = modelOptionMark(entry, parsed, openPrevUnderlying[ticker])
            if (mNow > 0 && mPrev > 0) dayOptPerShare = mPrev - mNow
          }
          // Last resort: two daily prints. Deliberately BELOW the model, because
          // on a contract that barely trades neither print is necessarily from
          // the session it claims — a 2028 LEAP can carry a close from days ago
          // against a previous_close from days before that, and differencing
          // them invents a move that never happened. A short TQQQ $110 call read
          // roughly +$643 that way on a day worth about +$150, which flipped the
          // whole row positive while the stock was down 5%. The model tracks the
          // underlying and is the better answer for exactly these contracts.
          if (dayOptPerShare == null && optClose[entry.symbol] > 0 && prevMkt > 0
              && markBasis !== 'model') {
            dayOptPerShare = prevMkt - optClose[entry.symbol]
          }
          // Still nothing means no comparable pair at all. Subtracting a market
          // close from a MODEL mark measures the gap between model and market,
          // not a day's move — it persists whatever the stock did and never
          // reconciles. MRVL read -835 that way. Reporting nothing is honest.
          if (dayOptPerShare == null) dayGapTickers.add(ticker)
          if (dayOptPerShare != null) {
            openDailyByTicker[ticker] = (openDailyByTicker[ticker] || 0) +
              daySplit(entry.symbol, effContracts, 'short', dayOptPerShare, currentOptionPrice)
            const bs = dayBasisByTicker[ticker] || (dayBasisByTicker[ticker] = { market: 0, model: 0 })
            if ((optFresh[entry.symbol] > 0 || optToday[entry.symbol] > 0) && prevMkt > 0) bs.market += 1
            else if (openPrevUnderlying[ticker] > 0 && stockByTicker[ticker] > 0) bs.model += 1
            else bs.market += 1     // two daily prints
          }

          // ── Theta projection ──
          // Roll time forward with the underlying and vol held fixed, so the only
          // thing moving is decay. Vol is backed out of the CURRENT mark, which
          // makes the projection continuous with the Open P&L beside it: at zero
          // months it reproduces today's number exactly.
          const S = stockByTicker[ticker]
          if (parsed && S > 0) {
            const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
            const yrs = ms => ms / (365.25 * 24 * 3600 * 1000)
            const T0 = yrs(new Date(expiry).getTime() - Date.now())
            if (T0 > 0) {
              let sigma = impliedVol(currentOptionPrice, S, parsed.strike, T0, RISK_FREE_RATE, parsed.type)
              if (!(sigma > 0)) sigma = 0.001   // deep ITM: price is all intrinsic, no vol info
              for (const months of PROJECT_MONTHS) {
                const T1 = T0 - months / 12
                let projMark
                let expired = false
                if (T1 <= 0) {
                  // Already expired by this horizon. With the stock where it is,
                  // the contract settles at intrinsic — this is the max-profit
                  // case for a short call, not a decayed guess.
                  expired = true
                  projMark = parsed.type === 'put'
                    ? Math.max(0, parsed.strike - S)
                    : Math.max(0, S - parsed.strike)
                } else {
                  projMark = repriceFromClose({
                    type: parsed.type, closeMark: currentOptionPrice,
                    S0: S, S1: S, K: parsed.strike, T0, T1, sigma, r: RISK_FREE_RATE,
                  })
                }
                if (projMark == null) continue
                openProjectedByTicker[months][ticker] =
                  (openProjectedByTicker[months][ticker] || 0) + (premiumPerShare - projMark) * shares
                const legs = openProjectedLegs[months][ticker] || { expired: 0, total: 0 }
                legs.total += 1
                if (expired) legs.expired += 1
                openProjectedLegs[months][ticker] = legs
              }

              // ── Price shock ──
              // Same vol, same expiry, underlying moved. Time is held still so
              // this isolates the move; decay is what the projection beside it
              // is for. At 0% it reproduces today's Open P&L exactly, which is
              // what makes the two continuous with each other.
              for (const move of SCENARIO_MOVES) {
                const S1 = S * (1 + move / 100)
                const shocked = repriceFromClose({
                  type: parsed.type, closeMark: currentOptionPrice,
                  S0: S, S1, K: parsed.strike, T0, T1: T0, sigma, r: RISK_FREE_RATE,
                })
                if (shocked == null) continue
                openScenarioByTicker[move][ticker] =
                  (openScenarioByTicker[move][ticker] || 0) + (premiumPerShare - shocked) * shares
              }
            }
          }
        }
      })

      // ── Long legs ──
      // Same four figures as the shorts above, with the sign the other way up: a
      // long gains when its mark RISES, so P&L is mark − cost rather than
      // premium − mark. Marked from the same quotes so the two sides of a spread
      // are comparable. No model fallback here — modelOptionMark anchors to a
      // short call's sale premium and has nothing to say about a bought
      // contract, so a leg with no mark contributes nothing rather than a guess.
      // Long legs always contribute TODAY'S MOVE, on both bases.
      //
      // Gating these behind the corrected basis was wrong for Day P&L. Open P&L
      // and Net + Open are cumulative figures that were calibrated on short legs
      // alone, so those stay as they were — but a DAY figure built from short
      // calls only isn't a different convention, it's a partial one. This
      // account holds far more bought contracts than sold (2,110 BTO against
      // 348 STO), so leaving them out left the day dominated by a minority of
      // the book and reading backwards against the broker on any real move.
      openLongs.forEach(leg => {
        const ticker = leg.ticker
        if (!ticker) return
        const shares = leg.contracts * 100
        const nowMark = optFresh[leg.symbol] ?? optClose[leg.symbol] ?? null
        if (!(nowMark > 0)) { dayGapTickers.add(ticker); return }

        const S = stockByTicker[ticker]
        const expiry = `${leg.parsed.year}-${leg.parsed.month}-${leg.parsed.day}`
        const yrs = ms => ms / (365.25 * 24 * 3600 * 1000)
        const T0 = yrs(new Date(expiry).getTime() - Date.now())
        let sigma = null
        if (S > 0 && T0 > 0) {
          sigma = impliedVol(nowMark, S, leg.parsed.strike, T0, RISK_FREE_RATE, leg.parsed.type)
          if (!(sigma > 0)) sigma = 0.001
        }

        // Today's move, same order of preference as the short legs. Long:
        // dearer is better, so now − prev.
        //
        // This used to difference two daily prints with no model fallback,
        // which is the bug fixed for short legs and left here. On a contract
        // that barely trades neither print is necessarily from the session it
        // claims, so the difference is a move that never happened — and with
        // far more bought contracts than sold, those phantom moves dominated
        // the day and held its sign against the broker.
        const prevMark = optPrevClose[leg.symbol]
        let dayLongPerShare = null
        let basis = null
        if (optFresh[leg.symbol] > 0 && prevMark > 0) {
          dayLongPerShare = optFresh[leg.symbol] - prevMark
          basis = 'market'
        } else if (sigma != null && openPrevUnderlying[ticker] > 0) {
          // Same contract, same vol, yesterday's underlying — the move the
          // stock actually made, rather than the gap between two stale prints.
          const mPrev = repriceFromClose({
            type: leg.parsed.type, closeMark: nowMark,
            S0: S, S1: openPrevUnderlying[ticker], K: leg.parsed.strike,
            T0, T1: T0, sigma, r: RISK_FREE_RATE,
          })
          if (mPrev > 0) { dayLongPerShare = nowMark - mPrev; basis = 'model' }
        }
        if (dayLongPerShare == null && prevMark > 0 && optClose[leg.symbol] > 0
            && optFresh[leg.symbol] > 0) {
          dayLongPerShare = optClose[leg.symbol] - prevMark
          basis = 'market'
        }

        if (dayLongPerShare != null) {
          openDailyByTicker[ticker] = (openDailyByTicker[ticker] || 0) +
            daySplit(leg.symbol, leg.contracts, 'long', dayLongPerShare, nowMark)
          const bs = dayBasisByTicker[ticker] || (dayBasisByTicker[ticker] = { market: 0, model: 0 })
          bs[basis] += 1
        } else {
          // A leg we can't move honestly makes the whole ticker's day partial.
          dayGapTickers.add(ticker)
        }

        // Long: selling it takes the bid.
        const lq = optQuote[leg.symbol]
        if (lq?.bid > 0) {
          openExitByTicker[ticker] = (openExitByTicker[ticker] || 0) + (lq.bid - leg.costPerShare) * shares
          if (lq.mid > 0) {
            exitSpreadByTicker[ticker] = (exitSpreadByTicker[ticker] || 0) + (lq.mid - lq.bid) * shares
          }
        }

        // Long legs count on BOTH bases now.
        //
        // They were gated to the corrected basis to protect figures calibrated
        // on short legs alone. That made sense when the long leg was an
        // occasional spread; it doesn't for a collar, where a bought put is
        // half the position by design. Excluding it meant Open P&L showed the
        // short call moving against a falling stock while the put that offsets
        // it — the whole point of holding it — contributed nothing.
        //
        // The projection and what-if below stay corrected-only: those are
        // forward-looking columns, not the position's current value.

        openUnrealizedByTicker[ticker] =
          (openUnrealizedByTicker[ticker] || 0) + (nowMark - leg.costPerShare) * shares

        // S, T0 and sigma are already established above for the day move.
        if (!corrected || !(S > 0) || !(T0 > 0) || sigma == null) return

        for (const months of PROJECT_MONTHS) {
          const T1 = T0 - months / 12
          let projMark, expired = false
          if (T1 <= 0) {
            expired = true
            projMark = leg.parsed.type === 'put'
              ? Math.max(0, leg.parsed.strike - S)
              : Math.max(0, S - leg.parsed.strike)
          } else {
            projMark = repriceFromClose({
              type: leg.parsed.type, closeMark: nowMark,
              S0: S, S1: S, K: leg.parsed.strike, T0, T1, sigma, r: RISK_FREE_RATE,
            })
          }
          if (projMark == null) continue
          openProjectedByTicker[months][ticker] =
            (openProjectedByTicker[months][ticker] || 0) + (projMark - leg.costPerShare) * shares
          const legs = openProjectedLegs[months][ticker] || { expired: 0, total: 0 }
          legs.total += 1
          if (expired) legs.expired += 1
          openProjectedLegs[months][ticker] = legs
        }

        for (const move of SCENARIO_MOVES) {
          const shocked = repriceFromClose({
            type: leg.parsed.type, closeMark: nowMark,
            S0: S, S1: S * (1 + move / 100), K: leg.parsed.strike, T0, T1: T0, sigma, r: RISK_FREE_RATE,
          })
          if (shocked == null) continue
          openScenarioByTicker[move][ticker] =
            (openScenarioByTicker[move][ticker] || 0) + (shocked - leg.costPerShare) * shares
        }
      })
    } else {
      // As-of view: open premium = credit still open on short legs, taken from the
      // LIFO leftover (positions still open on the as-of date). Open P&L is a
      // Black-Scholes ESTIMATE — the short call repriced at the underlying's close
      // on asOf (no historical option quotes exist to price it exactly).
      const shortEntryBySymbol = {}
      for (const e of databaseService.getShortCallEntries(userId, brokerFilter)) shortEntryBySymbol[e.symbol] = e
      const openShortLots = []
      Object.values(lifoStacks).forEach(stacks => {
        stacks.short.forEach(lot => {
          if (!(lot.remaining > 0) || !lot.parsed?.ticker) return
          openPremiumByTicker[lot.parsed.ticker] = (openPremiumByTicker[lot.parsed.ticker] || 0) + lot.remaining * lot.ppc
          openShortLots.push(lot)
        })
      })
      // Underlying close on the as-of date for the open tickers (cached historical).
      const openTickers = [...new Set(openShortLots.map(l => l.parsed.ticker))]
      const asOfUnderlying = {}
      await Promise.all(openTickers.map(async t => {
        try { const p = await priceService.getPriceForDate(t, asOf); if (p > 0) asOfUnderlying[t] = p } catch (e) { /* leave missing */ }
      }))
      openShortLots.forEach(lot => {
        const ticker = lot.parsed.ticker
        const underlying = asOfUnderlying[ticker]
        const entry = shortEntryBySymbol[lot.symbol] // short_call_entries are calls; puts skipped
        if (!(underlying > 0) || !entry) return
        const mark = modelOptionMark(entry, lot.parsed, underlying, asOf)
        if (!(mark > 0)) return
        const premiumPerShare = lot.ppc / 100
        const shares = lot.remaining * 100
        openUnrealizedByTicker[ticker] = (openUnrealizedByTicker[ticker] || 0) + (premiumPerShare - mark) * shares
      })
    }

    // Group realized P&L by underlying, split by short/long x call/put, date-filtered
    const byUnderlying = {}
    allTrades.forEach(t => {
      const parsed = parseOptionDescription(t.symbol || '')
      const ticker = parsed?.ticker || (t.symbol || '').split(' ')[0].toUpperCase()
      if (!ticker || ticker.length > 6 || !/^[A-Z]+$/.test(ticker)) return
      const effectiveStart = perSymbolDates[ticker] || globalStart
      if (!byUnderlying[ticker]) {
        byUnderlying[ticker] = {
          ticker, startDate: effectiveStart,
          realizedShortCalls: 0, realizedLongCalls: 0,
          realizedShortPuts: 0, realizedLongPuts: 0,
          totalRealized: 0, tradeCount: 0
        }
      }
      const entry = byUnderlying[ticker]
      entry.startDate = perSymbolDates[ticker] || globalStart
      if (t.trans_date < effectiveStart) return
      const tc = (t.trans_code || '').toUpperCase()
      const isClosing = ['STC', 'BTC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)
      const optionType = parsed?.type || null
      entry.tradeCount++
      if (isClosing && t._realizedPnl != null) {
        entry.totalRealized += t._realizedPnl
        if (optionType === 'call') {
          if (t._closingShort) entry.realizedShortCalls += t._realizedPnl
          else entry.realizedLongCalls += t._realizedPnl
        } else if (optionType === 'put') {
          if (t._closingShort) entry.realizedShortPuts += t._realizedPnl
          else entry.realizedLongPuts += t._realizedPnl
        }
      }
    })

    // Only keep tickers with at least one option trade on/after the effective start date.
    // tradeCount is incremented only for trades that pass the start-date filter above, so
    // this drops anything not traded after the start date (including open-premium-only tickers).
    Object.keys(byUnderlying).forEach(ticker => {
      if (!(byUnderlying[ticker].tradeCount > 0)) delete byUnderlying[ticker]
    })

    // Stock positions + prices — as of the chosen date, or live. Position/cost bounded
    // to trades on/before asOf; price is that day's historical close (else live).
    // 'corrected' opts into the accounting fixes; anything else keeps the
    // original behaviour. The Options YTD panel is read daily and calibrated on
    // the original figures, so it stays on them and the Dashboard asks for the
    // corrected tally instead — the two legitimately differ.
    const stockPositions = databaseService.getStockPositionsWithCost(
      userId, asOf, brokerFilter, corrected ? 'fifo' : 'average')
    const stockCostOverrides = databaseService.getCostOverrides(userId, brokerFilter)
    // Scoped to the panel's period and broker, like realized OPTION P&L already
    // is. The question this panel answers is "where am I since I started",
    // not "what is my tax liability for the year" — an all-time figure answers
    // the second and buries the first.
    const stockRealized = databaseService.getStockRealizedPnL(
      userId, stockCostOverrides, asOf, brokerFilter, globalStart, perSymbolDates)

    // A manual cost sets the basis at the period start; shares bought after it
    // come in at what was actually paid. Without this, HOOD's 100 repurchased at
    // $110.48 were priced at the $84.31 override and showed +$2,048 when the lot
    // was down $569. Only names with an override are affected.
    const effectiveCost = databaseService.getStockEffectiveCost(
      userId, stockCostOverrides, asOf, brokerFilter, globalStart, perSymbolDates)
    const basisFor = (ticker, sp) =>
      sp ? (effectiveCost[ticker] || stockCostOverrides[ticker] || sp.avgCost) : null

    // Rows so far come only from option activity, so a stock held without any
    // options never appeared at all. Add those as stock-only rows.
    // getStockPositionsWithCost already filters to HAVING position > 0, so this
    // can only introduce currently-held names — sold-out tickers never appear
    // and the panel doesn't accumulate history.
    Object.keys(stockPositions).forEach(ticker => {
      if (byUnderlying[ticker]) return
      if (!(stockPositions[ticker]?.position > 0)) return
      byUnderlying[ticker] = {
        ticker, startDate: perSymbolDates[ticker] || globalStart,
        realizedShortCalls: 0, realizedLongCalls: 0,
        realizedShortPuts: 0, realizedLongPuts: 0,
        totalRealized: 0, tradeCount: 0,
        stockOnly: true,
      }
    })
    const allTickers = [...new Set([...Object.keys(byUnderlying), ...Object.keys(stockPositions)])]
    // Price at the START of the window. stockUnrealizedPnL is gain since
    // PURCHASE, which ignores the selected period entirely — a name bought
    // years ago shows its whole lifetime move no matter what period is chosen.
    // This gives callers a genuinely period-scoped figure instead.
    const periodStartPrices = {}
    if (!asOf && allTickers.length > 0 && req.query.startDate) {
      await Promise.all(allTickers.map(async t => {
        try {
          const p = await priceService.getPriceForDate(t, globalStart)
          if (p > 0) periodStartPrices[t] = p
        } catch { /* no historical price — caller falls back */ }
      }))
    }

    const stockPrices = {}
    if (allTickers.length > 0 && asOf) {
      // Historical close on the as-of date.
      await Promise.all(allTickers.map(async t => {
        try { const p = await priceService.getPriceForDate(t, asOf); if (p > 0) stockPrices[t] = p } catch (e) { /* leave missing */ }
      }))
    } else if (allTickers.length > 0) {
      try {
        const fetched = await priceService.fetchPrices(allTickers)
        allTickers.forEach(t => { if (fetched[t] > 0) stockPrices[t] = fetched[t] })
      } catch (e) {
        console.warn('YTD price fetch failed:', e.message)
        const cached = priceService.getCurrentPrices()
        allTickers.forEach(t => { if (cached[t] > 0) stockPrices[t] = cached[t] })
      }
    }

    // Fill any missing prices from the in-memory cache (live view only).
    if (!asOf) {
      const cachedPrices = priceService.getCurrentPrices()
      allTickers.forEach(t => { if (!stockPrices[t] && cachedPrices[t] > 0) stockPrices[t] = cachedPrices[t] })
    }
    const pricesFetched = Object.keys(stockPrices).filter(t => stockPrices[t] > 0).length
    console.log(`YTD${asOf ? ` (as of ${asOf})` : ''}: ${Object.keys(stockPositions).length} stock positions, ${allTickers.length} tickers, ${pricesFetched} prices`)

    // Weekly/daily change are "today"-relative — only for the live view.
    let weeklyChange = {}
    let dailyChange = {}
    if (allTickers.length > 0 && !asOf) {
      try { weeklyChange = await priceService.fetchWeeklyChange(allTickers) } catch (e) { console.warn('YTD weekly change fetch failed:', e.message) }
      try { dailyChange = await priceService.fetchDailyChange(allTickers) } catch (e) { console.warn('YTD daily change fetch failed:', e.message) }
    }

    const r2 = n => Math.round(n * 100) / 100
    const result = Object.values(byUnderlying)
      .map(e => {
        const sp = stockPositions[e.ticker]
        const cp = stockPrices[e.ticker] || null
        const wk = weeklyChange[e.ticker]
        const dc = dailyChange[e.ticker]
        // Today's mark-to-market move (EOD close → now): shares × stock day move +
        // the option side accumulated above (contracts × 100 × option day move).
        const dayStockPnl = (sp && sp.position > 0 && dc && dc.prevClose > 0)
          ? r2(sp.position * (dc.current - dc.prevClose)) : null
        const dayOptionPnl = openDailyByTicker[e.ticker] != null ? r2(openDailyByTicker[e.ticker]) : null
        // A day is only reportable when every side of the position is in it.
        // Shares held but no daily price left dayStockPnl null, and this then
        // published the OPTION side alone as though it were the whole day. On a
        // down day that inverts the answer — the stock falls while short options
        // gain — so the column read positive against a broker's -2,200. A
        // missing half is not a small error in a total, it is a different
        // number. Report nothing and say why instead.
        // Two different kinds of missing, and only one justifies withholding.
        //
        // No daily STOCK price while shares are held is the dangerous one: the
        // total then reduces to the option side alone, which on a down day
        // carries the opposite sign. That still reports nothing.
        //
        // An option leg that couldn't be priced is not the same thing. The
        // total is a little incomplete, not inverted — and refusing it while
        // showing both halves beside it was the worst of both: the parts were
        // there and the sum wasn't.
        const missingStockDay = !!(sp && sp.position > 0) && dayStockPnl == null
        const partialLegs = dayGapTickers.has(e.ticker)
        const dayPnl = missingStockDay ? null
          : (dayStockPnl != null || dayOptionPnl != null)
            ? r2((dayStockPnl || 0) + (dayOptionPnl || 0)) : null
        // Only surface realized stock P&L for CLOSED positions (no open shares) — e.g. JPM.
        // Open positions keep showing just their unrealized (open-share) gain, as before, so
        // active names aren't inflated by all-time realized gains.
        const isOpen = sp && sp.position > 0
        return {
          ...e,
          // True when this row has option activity in the window; false for the
          // stock-only rows added above. Drives the All / Has options / Stock
          // only view filter.
          hasOptions: !e.stockOnly && e.tradeCount > 0,
          realizedShortCalls: r2(e.realizedShortCalls),
          realizedLongCalls: r2(e.realizedLongCalls),
          realizedShortPuts: r2(e.realizedShortPuts),
          realizedLongPuts: r2(e.realizedLongPuts),
          totalRealized: r2(e.totalRealized),
          openPremium: r2(openPremiumByTicker[e.ticker] || 0),
          openUnrealizedPnL: openUnrealizedByTicker[e.ticker] != null ? r2(openUnrealizedByTicker[e.ticker]) : null,
          // Open P&L projected forward on theta alone (underlying held flat).
          // { "1": {pnl, expiredLegs, totalLegs}, "2": …, "3": … }
          // Open option P&L if this underlying moved x% right now, keyed by
          // percent. The stock side isn't here on purpose: shares reprice
          // linearly, so the caller can shift them itself without a round trip.
          openScenario: SCENARIO_MOVES.reduce((acc, m) => {
            const v = openScenarioByTicker[m][e.ticker]
            if (v != null) acc[m] = r2(v)
            return acc
          }, {}),
          openProjected: PROJECT_MONTHS.reduce((acc, m) => {
            const v = openProjectedByTicker[m][e.ticker]
            if (v != null) {
              const legs = openProjectedLegs[m][e.ticker] || { expired: 0, total: 0 }
              acc[m] = { pnl: r2(v), expiredLegs: legs.expired, totalLegs: legs.total }
            }
            return acc
          }, {}),
          stockPosition: sp?.position ?? null,
          stockAvgCost: sp?.avgCost ?? null,
          stockCurrentPrice: cp,
          // Manual avg-cost overrides are honoured here. They were applied only
          // in the Positions panel's own render, so every other consumer — the
          // charts especially — silently used the computed cost instead.
          stockUnrealizedPnL: sp && cp
            ? r2(sp.position * (cp - basisFor(e.ticker, sp)))
            : null,
          stockCostUsed: basisFor(e.ticker, sp),
          stockCostIsOverride: !!stockCostOverrides[e.ticker],
          // True when the override was blended with buys made after the period
          // start rather than applied flat to every share.
          stockCostIsBlended: !!effectiveCost[e.ticker]
            && effectiveCost[e.ticker] !== stockCostOverrides[e.ticker],
          // Movement over the selected period on the shares currently held —
          // shares x (price now - price at period start). Null when there's no
          // historical price, so callers can tell "no data" from "no move".
          stockPeriodPnl: (sp && cp && periodStartPrices[e.ticker] > 0)
            ? r2(sp.position * (cp - periodStartPrices[e.ticker]))
            : null,
          periodStartPrice: periodStartPrices[e.ticker] ?? null,
          // Shown whether or not shares are still held.
          //
          // It used to appear only once a position was fully closed, so selling
          // part of a holding moved money out of view: PLTR read 8,000 and then
          // 2,000 the moment 100 shares were sold, because the gain on them
          // stopped being rendered anywhere. Now that the figure is scoped to
          // the period and booked at the cost prevailing at each sale, there is
          // nothing to protect against — it's this period's realized gain, not
          // years of accumulated history.
          stockRealizedPnL: stockRealized[e.ticker] != null ? r2(stockRealized[e.ticker]) : null,
          // Kept as an alias so the Stock Realized column keeps working; it is
          // now the same figure as stockRealizedPnL, which is no longer gated.
          stockRealizedAll: stockRealized[e.ticker] != null ? r2(stockRealized[e.ticker]) : null,
          weeklyChangePct: wk ? wk.pct : null,
          weeklyChange: wk ? wk.change : null,
          dayPnl,
          dayStockPnl,
          dayOptionPnl,
          // True when shares are held but no daily price arrived, so the day
          // can't be reported. Surfaced rather than hidden: the failure mode it
          // replaces was silent and inverted the sign.
          dayIncomplete: missingStockDay,
          // Shown but not whole: at least one option leg had no usable move.
          dayPartial: partialLegs && !missingStockDay,
          // 'market' when every option leg's day move came from real prints at
          // both ends, 'model' when none did, 'mixed' in between. A model-derived
          // day move is an estimate of the move, not the move — worth being able
          // to see when a figure disagrees with the broker.
          // Which basis today's OPEN P&L rests on for this ticker: a real market
          // mark, or a model estimate. Reported so an estimate reads as one
          // rather than as a measurement.
          openMarkBasis: openBasisByTicker[e.ticker] || null,
          // Null when no two-sided quote was available for any leg — an absent
          // figure is honest, a mid dressed up as an exit price is not.
          openExitPnL: openExitByTicker[e.ticker] != null ? r2(openExitByTicker[e.ticker]) : null,
          exitSpreadCost: exitSpreadByTicker[e.ticker] != null ? r2(exitSpreadByTicker[e.ticker]) : null,
          dayOptionBasis: (() => {
            const bs = dayBasisByTicker[e.ticker]
            if (!bs) return null
            if (bs.model === 0) return 'market'
            if (bs.market === 0) return 'model'
            return 'mixed'
          })(),
          dayStockChangePct: dc ? dc.pct : null
        }
      })
      .sort((a, b) => b.totalRealized - a.totalRealized)

    // ?ticker=MRVL narrows the response to one name. Reusing this endpoint
    // rather than a parallel debug route means the decomposition is the panel's
    // own arithmetic by construction — a separate route could drift and then
    // "agree" with a bug instead of exposing it.
    if (req.query.ticker) {
      const t = String(req.query.ticker).toUpperCase()
      // result is an ARRAY (Object.values above), not a map — look it up by field.
      const row = result.find(r => String(r.ticker).toUpperCase() === t)
      if (!row) {
        return res.json({
          success: true, ticker: t, found: false, globalStart,
          available: result.map(r => r.ticker).sort(),
        })
      }
      const stockRealizedTerm = row.stockRealizedPnL || 0
      const stockUnrealTerm = row.stockUnrealizedPnL || 0
      const optionsRealized = row.totalRealized || 0
      const openTerm = row.openUnrealizedPnL || 0
      const net = optionsRealized + stockUnrealTerm + stockRealizedTerm
      return res.json({
        success: true, ticker: t, found: true,
        window: { globalStart, effectiveStart: perSymbolDates[t] || globalStart, asOf },
        terms: {
          optionsRealized,
          stockUnrealized: stockUnrealTerm,
          stockRealized: stockRealizedTerm,
          openOptions: openTerm,
        },
        net: Math.round(net * 100) / 100,
        netPlusOpen: Math.round((net + openTerm) * 100) / 100,
        breakdown: {
          realizedShortCalls: row.realizedShortCalls,
          realizedLongCalls: row.realizedLongCalls,
          realizedShortPuts: row.realizedShortPuts,
          realizedLongPuts: row.realizedLongPuts,
        },
        row,
      })
    }
    res.json({ success: true, byUnderlying: result, globalStart, perSymbolDates, asOf })
  } catch (e) {
    console.error('Error in /api/options-pnl/ytd:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/vol-scan — per-stock IV vs HV, to flag which names' options are "rich".
//   ?universe=sp500  → the whole S&P/NASDAQ list, served from the background cache (fast)
//   ?tickers=MRVL,HOOD → live scan of a small custom list
//   (default) → your short-call tickers, live
app.get('/api/vol-scan', requireAuth, async (req, res) => {
  try {
    const polygonKey = process.env.POLYGON_API_KEY || ''
    if (!polygonKey) return res.json({ error: 'No POLYGON_API_KEY set' })
    const userId = req.user.userId

    // Large universes are served from the background-populated cache (can't live-fetch 300+).
    const universe = (req.query.universe || '').toLowerCase()
    if (universe === 'sp500' || universe === 'nasdaq' || universe === 'all') {
      const cached = databaseService.getVolScanCache(SP500)
      // Kick off (or continue) the background scan when the cache is sparse, or on ?refresh=1.
      if (!universeScanRunning && (req.query.refresh === '1' || cached.length < SP500.length * 0.6)) {
        runUniverseVolScan() // fire-and-forget; fills the cache over the next few minutes
      }
      const results = cached.map(c => ({
        ticker: c.ticker, stock: c.stock, hv20: c.hv20, hv30: c.hv30, iv: c.iv,
        ivDte: c.iv_dte, ivSource: c.iv_source, ivHvRatio: c.iv_hv_ratio, signal: c.signal,
        ivRank: c.iv_rank, ivPercentile: c.iv_percentile,
        ivHvSpread: (c.iv > 0 && c.hv30 > 0) ? Math.round((c.iv - c.hv30) * 1000) / 10 : null
      })).sort((a, b) => (b.ivHvRatio || 0) - (a.ivHvRatio || 0))
      const cachedAt = cached.reduce((mx, c) => Math.max(mx, c.updated_at || 0), 0)
      return res.json({
        success: true, count: results.length, results, cached: true,
        cachedAt: cachedAt ? cachedAt * 1000 : null,
        universeSize: SP500.length,
        scanRunning: universeScanRunning,
        scanProgress: universeScanRunning ? universeScanProgress : null
      })
    }

    let tickers = (req.query.tickers || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    if (tickers.length === 0) {
      const entries = databaseService.getShortCallEntries(userId)
      tickers = [...new Set(entries.map(e => (e.ticker || '').toUpperCase()).filter(Boolean))]
    }
    tickers = [...new Set(tickers)].slice(0, 60)

    const today = new Date().toISOString().slice(0, 10)
    const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)

    const processTicker = async (ticker) => {
      const row = enrichVolRow(await scanTickerVol(ticker, polygonKey))
      if (row.iv > 0) {
        databaseService.recordIV(ticker, today, row.iv, row.hv30, row.stock)
        Object.assign(row, computeIVRank(databaseService.getIVHistory(ticker, since), row.iv))
        databaseService.upsertVolScan(row)
      }
      return row
    }

    // Limited concurrency to avoid Polygon rate limits / timeouts on big lists.
    const CONCURRENCY = 4
    const results = []
    for (let i = 0; i < tickers.length; i += CONCURRENCY) {
      const batch = await Promise.all(tickers.slice(i, i + CONCURRENCY).map(processTicker))
      results.push(...batch)
    }

    results.sort((a, b) => (b.ivHvRatio || 0) - (a.ivHvRatio || 0))
    res.json({ success: true, count: results.length, results })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/brokers — which brokers this user has data for, for the tab bar.
// ─── Fibonacci + RSI screener ────────────────────────────────────────────────
// Two confirmations of the same idea, which is why they're screened together:
// RSI says momentum is stretched, the retracement says price has actually
// reached a level people watch. Either alone fires constantly; both at once is
// rarer and means more.
//
// Retracement is measured from the swing high of the lookback:
//     pct = (high - price) / (high - low)
// 0% = at the highs, 100% = at the lows. The classic levels are 23.6, 38.2,
// 50, 61.8 and 78.6.
const FIB_LEVELS = [0, 23.6, 38.2, 50, 61.8, 78.6, 100]

const nearestFibLevel = (pct) =>
  FIB_LEVELS.reduce((best, l) => (Math.abs(l - pct) < Math.abs(best - pct) ? l : best), FIB_LEVELS[0])

function screenFibRsi(closes, opts) {
  const { rsiOversold, rsiOverbought, deepRetrace, shallowRetrace, nearLevel } = opts
  if (!Array.isArray(closes) || closes.length < 30) return null

  const price = closes[closes.length - 1]
  const high = Math.max(...closes)
  const low = Math.min(...closes)
  if (!(price > 0) || !(high > low)) return null

  const rsi = calculateRSI(closes, 14)
  if (rsi == null) return null

  const retracePct = Math.round(((high - price) / (high - low)) * 1000) / 10
  const level = nearestFibLevel(retracePct)
  const atLevel = Math.abs(retracePct - level) <= nearLevel

  // Oversold: deep into the range AND momentum washed out.
  // Overbought: up near the highs AND momentum stretched.
  let signal = null
  if (retracePct >= deepRetrace && rsi <= rsiOversold) signal = 'oversold'
  else if (retracePct <= shallowRetrace && rsi >= rsiOverbought) signal = 'overbought'
  if (!signal) return null

  return {
    price: Math.round(price * 100) / 100,
    high: Math.round(high * 100) / 100,
    low: Math.round(low * 100) / 100,
    rsi: Math.round(rsi * 10) / 10,
    retracePct,
    fibLevel: level,
    atLevel,
    signal,
  }
}

app.get('/api/screener/fib-rsi', requireAuth, async (req, res) => {
  const n = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d }
  const opts = {
    rsiOversold: n(req.query.rsiOversold, 35),
    rsiOverbought: n(req.query.rsiOverbought, 65),
    deepRetrace: n(req.query.deepRetrace, 61.8),
    shallowRetrace: n(req.query.shallowRetrace, 23.6),
    nearLevel: n(req.query.nearLevel, 4),
  }
  const range = ['3mo', '6mo', '1y'].includes(req.query.range) ? req.query.range : '6mo'

  try {
    // Holdings first — a signal on something you own matters more than one on a
    // name you don't. Then the rest of the universe.
    const held = Object.keys(databaseService.getStockPositionsWithCost(req.user.userId))
    const universe = [...new Set([...held, ...SP500])].filter(t => /^[A-Z.]{1,6}$/.test(t))

    const hits = []
    const CONC = 6
    for (let i = 0; i < universe.length; i += CONC) {
      const batch = universe.slice(i, i + CONC)
      await Promise.all(batch.map(async ticker => {
        try {
          const hist = await priceService.fetchHistoricalPrices(ticker, range, '1d')
          const closes = (hist || []).map(b => b.close).filter(c => c > 0)
          const r = screenFibRsi(closes, opts)
          if (r) hits.push({ ticker, held: held.includes(ticker), ...r })
        } catch { /* one name failing shouldn't stop the scan */ }
      }))
      if (i + CONC < universe.length) await new Promise(r => setTimeout(r, 250))
    }

    // Strongest first: how far past the RSI threshold, then how close to a level.
    hits.sort((a, b) => {
      if (a.held !== b.held) return a.held ? -1 : 1
      const strength = (h) => h.signal === 'oversold' ? (opts.rsiOversold - h.rsi) : (h.rsi - opts.rsiOverbought)
      return strength(b) - strength(a)
    })

    res.json({ success: true, scanned: universe.length, range, opts, hits })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Day P&L inputs ──────────────────────────────────────────────────────────
// Read-only dump of everything the day calculation consumes, so a wrong figure
// can be reconstructed by hand instead of guessed at. Deliberately raw: the
// three marks per contract, the two prices per stock, and nothing derived.
app.get('/api/debug-day-inputs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const polygonKey = process.env.POLYGON_API_KEY || ''

    const positions = databaseService.getStockPositionsWithCost(userId, null, brokerFilter)
    const open = databaseService.getOpenOptionPositions(userId, brokerFilter)
    const today = new Date().toISOString().slice(0, 10)
    const active = open.filter(p => {
      const parsed = parseOptionDescription(p.symbol)
      if (!parsed) return false
      return `${parsed.year}-${parsed.month}-${parsed.day}` >= today
    })

    const tickers = [...new Set([
      ...Object.keys(positions),
      ...active.map(p => parseOptionDescription(p.symbol)?.ticker).filter(Boolean),
    ])]
    let daily = {}
    try { daily = await priceService.fetchDailyChange(tickers) } catch (e) { /* report as missing */ }

    const stocks = Object.entries(positions).map(([ticker, p]) => {
      const d = daily[ticker]
      return {
        ticker, shares: p.position,
        prevClose: d?.prevClose ?? null,
        current: d?.current ?? null,
        pct: d?.pct ?? null,
        dayStockPnl: d?.prevClose > 0 ? Math.round(p.position * (d.current - d.prevClose) * 100) / 100 : null,
        priceMissing: !d,
      }
    }).sort((a, b) => (a.ticker > b.ticker ? 1 : -1))

    // The three marks each leg is judged on, straight from Polygon.
    const legs = []
    // ?ticker=PLTR narrows to one underlying. The 60-leg cap is ordered by
    // symbol, so without a filter everything past the N's is invisible — PLTR,
    // RDDT, TQQQ and UBER all fell off the end of the list they were needed in.
    const wantTicker = (req.query.ticker || '').trim().toUpperCase()
    const legSource = wantTicker
      ? active.filter(p => parseOptionDescription(p.symbol)?.ticker === wantTicker)
      : active
    for (const p of legSource.slice(0, wantTicker ? 200 : 60)) {
      const parsed = parseOptionDescription(p.symbol)
      const polyTicker = toPolygonTicker(p.symbol)
      const row = {
        symbol: p.symbol, ticker: parsed?.ticker || null,
        side: p.net_short > 0 ? 'SHORT' : 'LONG',
        contracts: p.net_short > 0 ? p.net_short : p.net_long,
        quoteMid: null, dayClose: null, prevClose: null,
      }
      if (polygonKey && polyTicker && parsed) {
        try {
          row.quoteMid = (await fetchOptionQuoteMid(polyTicker, polygonKey)) || null
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polyTicker}`
          const snap = (await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })).data?.results
          if (snap) {
            row.dayClose = staleOptionMark(snap) || null
            row.prevClose = snap.day?.previous_close || null
            row.underlyingNow = snap.underlying_asset?.price || null
          }
        } catch (e) { row.error = e.message }
      }
      legs.push(row)
    }

    // ── Short-entry audit ──
    // Day Options scales each short leg by the contracts on its short_call_entries
    // row, while the true open size is netted from the trades table. Those two
    // disagreeing is invisible in every other figure and doubles a ticker's day
    // move if the same sale is on file twice — so compare them head-on.
    const shortEntries = databaseService.getShortCallEntries(userId, brokerFilter)
    const netShortBySymbol = {}
    open.forEach(p => { netShortBySymbol[p.symbol] = p.net_short })
    const bySymbol = {}
    shortEntries.forEach(e => {
      const b = bySymbol[e.symbol] || (bySymbol[e.symbol] = { rows: 0, contracts: 0, ids: [] })
      b.rows += 1
      b.contracts += (e.contracts || 1)
      b.ids.push(e.id)
    })
    const shortEntryAudit = Object.entries(bySymbol).map(([symbol, b]) => {
      const netShort = netShortBySymbol[symbol] ?? 0
      return {
        symbol,
        ticker: parseOptionDescription(symbol)?.ticker || null,
        entryRows: b.rows,
        entryContracts: b.contracts,
        netShortFromTrades: netShort,
        // >1 means Day Options is scaling this leg up by that factor.
        overstatedBy: netShort > 0 ? Math.round((b.contracts / netShort) * 100) / 100 : null,
        entryIds: b.ids,
      }
    }).filter(r => r.netShortFromTrades > 0 && r.entryContracts !== r.netShortFromTrades)
      .sort((a, b) => (b.overstatedBy || 0) - (a.overstatedBy || 0))

    const stockDayTotal = stocks.reduce((s, r) => s + (r.dayStockPnl || 0), 0)
    res.json({
      success: true, broker: brokerFilter || 'all',
      polygonEnabled: !!polygonKey,
      stockDayTotal: Math.round(stockDayTotal * 100) / 100,
      stocksMissingPrice: stocks.filter(s => s.priceMissing).map(s => s.ticker),
      shortEntryAudit,
      shortEntryAuditNote: 'Symbols where short_call_entries disagrees with the net short from trades. overstatedBy 2 means Day Options counts that leg twice.',
      stocks, legs,
      note: 'quoteMid = live mid; dayClose = today\'s print; prevClose = yesterday\'s. A leg with only dayClose/prevClose and no quoteMid is the case that used to invent moves.',
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/debug-open-breakdown?ticker=MRVL
 *
 * Every OPEN contract for one underlying, with the mark it got, where that mark
 * came from, and what it contributes to Open P&L. Answers "why is this number
 * what it is" by showing the parts rather than the total.
 */
app.get('/api/debug-open-breakdown', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const ticker = String(req.query.ticker || '').toUpperCase()
    const polygonKey = process.env.POLYGON_API_KEY || ''
    if (!ticker) return res.status(400).json({ error: 'ticker is required' })

    const open = databaseService.getOpenOptionPositions(userId)
    const entries = databaseService.getShortCallEntries(userId)
    const today = todayStrLocal()

    const shortOpen = new Set(open.filter(p => p.net_short > 0).map(p => p.symbol))
    const mine = entries.filter(e => (e.ticker || '').toUpperCase() === ticker && shortOpen.has(e.symbol))

    // Long legs too. Built from open positions rather than short_call_entries,
    // which only ever holds sold calls — a spread would otherwise show one side.
    const longs = open.filter(p => p.net_long > 0).map(p => {
      const parsed = parseOptionDescription(p.symbol)
      return parsed && parsed.ticker.toUpperCase() === ticker ? { p, parsed } : null
    }).filter(Boolean)

    const rows = []
    let total = 0
    for (const e of mine) {
      const parsed = parseOptionDescription(e.symbol)
      const expiry = parsed ? `${parsed.year}-${parsed.month}-${parsed.day}` : null
      const row = { symbol: e.symbol, expiry, contracts: e.contracts || 1, premiumTotal: e.premium }
      if (expiry && expiry < today) { row.skipped = 'expired'; rows.push(row); continue }

      const polyTicker = toPolygonTicker(e.symbol)
      let mark = null, basis = null, volume = null
      if (polygonKey && polyTicker && parsed) {
        const q = await fetchOptionQuote(polyTicker, polygonKey)
        if (q.mid > 0) { mark = q.mid; basis = 'quote' }
        try {
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polyTicker}`
          const snap = (await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })).data?.results
          if (snap) {
            volume = snap.day?.volume ?? null
            row.dayClose = snap.day?.close ?? null
            row.prevClose = snap.day?.previous_close ?? null
            row.markIsToday = marketMarkIsToday(snap)
            if (mark == null && row.markIsToday && snap.day?.close > 0) {
              mark = snap.day.close; basis = 'today'
            }
            if (mark == null) {
              const m = modelOptionMark(e, parsed, snap.underlying_asset?.price)
              if (m > 0) { mark = m; basis = 'model' }
              else if (snap.day?.close > 0) { mark = snap.day.close; basis = 'staleClose' }
            }
          }
        } catch (err) { row.snapshotError = err.message }
      }

      const contracts = e.contracts || 1
      const premiumPerShare = contracts > 0 ? e.premium / (contracts * 100) : 0
      row.volume = volume
      row.mark = mark != null ? Math.round(mark * 100) / 100 : null
      row.basis = basis
      row.premiumPerShare = Math.round(premiumPerShare * 100) / 100
      row.openPnl = mark != null
        ? Math.round((premiumPerShare - mark) * 100 * contracts * 100) / 100
        : null
      if (row.openPnl != null) total += row.openPnl
      rows.push(row)
    }

    for (const { p, parsed } of longs) {
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      const row = {
        symbol: p.symbol, expiry, side: 'long', contracts: p.net_long,
        costTotal: Math.abs(p.total_paid),
      }
      if (expiry < today) { row.skipped = 'expired'; rows.push(row); continue }
      const polyTicker = toPolygonTicker(p.symbol)
      let mark = null, basis = null
      if (polygonKey && polyTicker) {
        const q = await fetchOptionQuote(polyTicker, polygonKey)
        if (q.mid > 0) { mark = q.mid; basis = 'quote' }
        try {
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polyTicker}`
          const snap = (await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })).data?.results
          if (snap) {
            row.volume = snap.day?.volume ?? null
            row.dayClose = snap.day?.close ?? null
            row.markIsToday = marketMarkIsToday(snap)
            if (mark == null && snap.day?.close > 0) {
              mark = snap.day.close
              basis = row.markIsToday ? 'today' : 'staleClose'
            }
          }
        } catch (err) { row.snapshotError = err.message }
      }
      const costPerShare = p.bto_contracts > 0 ? Math.abs(p.total_paid) / p.bto_contracts / 100 : 0
      row.mark = mark != null ? Math.round(mark * 100) / 100 : null
      row.basis = basis
      row.costPerShare = Math.round(costPerShare * 100) / 100
      // Long: gains when the mark rises, the opposite of a short.
      row.openPnl = mark != null
        ? Math.round((mark - costPerShare) * 100 * p.net_long * 100) / 100
        : null
      if (row.openPnl != null) total += row.openPnl
      rows.push(row)
    }

    rows.forEach(r => { if (!r.side) r.side = 'short' })
    rows.sort((a, b) => (a.openPnl ?? 0) - (b.openPnl ?? 0))
    res.json({
      ticker,
      openContracts: rows.filter(r => !r.skipped).length,
      totalOpenPnl: Math.round(total * 100) / 100,
      byBasis: rows.reduce((acc, r) => { if (r.basis) acc[r.basis] = (acc[r.basis] || 0) + 1; return acc }, {}),
      rows,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/debug-stock-basis?ticker=PLTR
 *
 * One ticker's stock position with every cost-basis method side by side, and
 * what each implies. Built because three separate explanations were offered for
 * a figure without anyone being able to see the inputs — this shows them.
 */
app.get('/api/debug-stock-basis', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const ticker = String(req.query.ticker || '').toUpperCase()
    if (!ticker) return res.status(400).json({ error: 'ticker is required' })
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null

    const methods = ['moving', 'fifo', 'lifo', 'average']
    const basis = {}
    for (const m of methods) {
      const all = databaseService.getStockPositionsWithCost(userId, null, brokerFilter, m)
      basis[m] = all[ticker] || null
    }

    let price = 0
    try {
      const px = await priceService.fetchPrices([ticker])
      price = px[ticker] || 0
    } catch (e) { /* leave 0 */ }

    // Every stock trade, so the walk can be checked by hand.
    const trades = databaseService.getTradesForStockSymbol(userId, ticker, brokerFilter)
    const buys = trades.filter(t => t.is_buy === 1)
    const sells = trades.filter(t => t.is_buy !== 1)

    const implied = {}
    for (const m of methods) {
      const b = basis[m]
      implied[m] = b && price > 0
        ? {
            position: b.position,
            avgCost: b.avgCost,
            unrealized: Math.round(b.position * (price - b.avgCost) * 100) / 100,
          }
        : null
    }

    // Every term of Net, so a figure that looks wrong can be attributed to a
    // component instead of guessed at. Net = realized options + realized stock
    // + unrealized stock; Net + Open adds the open option marks.
    const fromDate = req.query.startDate || null
    const realizedAll = databaseService.getStockRealizedPnL(userId, {}, null, brokerFilter, null)
    const realizedPeriod = databaseService.getStockRealizedPnL(userId, {}, null, brokerFilter, fromDate)

    // A manual override REPLACES the computed cost wherever it's set, so none
    // of the methods above would be in play for this ticker. Reported first
    // because it silently outranks everything else.
    const overrides = databaseService.getCostOverrides(userId, brokerFilter)
    const override = overrides[ticker] ?? null
    const pos = basis.moving?.position || 0

    res.json({
      ticker,
      price,
      override,
      overrideInUse: override != null,
      overrideImplies: (override != null && price > 0 && pos > 0)
        ? { avgCost: override, unrealized: Math.round(pos * (price - override) * 100) / 100 }
        : null,
      basis,
      implied,
      realized: {
        allTime: realizedAll[ticker] ?? null,
        // What Net actually uses, scoped to the panel's period. Pass
        // ?startDate= to match whatever the panel is showing.
        inPeriod: realizedPeriod[ticker] ?? null,
        fromDate,
      },
      trades: {
        count: trades.length,
        buyCount: buys.length,
        sellCount: sells.length,
        totalBought: Math.round(buys.reduce((n, t) => n + (t.quantity || 0), 0) * 1e4) / 1e4,
        totalSold: Math.round(sells.reduce((n, t) => n + (t.quantity || 0), 0) * 1e4) / 1e4,
        lastFive: trades.slice(-5).map(t => ({
          date: String(t.trans_date).slice(0, 10),
          code: t.trans_code,
          qty: t.quantity,
          amount: t.amount,
        })),
      },
      note: 'moving = broker-style average (sales remove shares at the running average). fifo = oldest sold first, so the shares still held are the newest. lifo = newest sold first, so the shares still held are the oldest — the right read after selling and buying straight back, where the repurchase covers what just left. average = lifetime average of every buy ever, including shares long since sold — what Options YTD currently uses.',
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/collars — the strategy view.
 *
 * Shares, the short call sold against them and the long put protecting them,
 * per ticker, with where the stock sits between the two strikes. That band is
 * the position: above the call is assignment and capped upside, below the put
 * is protection actually paying out, between them is the intended state.
 *
 * Built because the panels list legs separately and never show the shape they
 * form — a rolling collar is one position, not three unrelated rows.
 */
app.get('/api/collars', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const today = todayStrLocal()

    const positions = databaseService.getStockPositionsWithCost(userId, null, brokerFilter, 'moving')
    const overrides = databaseService.getCostOverrides(userId, brokerFilter)
    const open = databaseService.getOpenOptionPositions(userId, brokerFilter)

    // Live, unexpired legs only — an expired contract protects nothing.
    const legs = open.map(p => {
      const parsed = parseOptionDescription(p.symbol)
      if (!parsed) return null
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      if (expiry < today) return null
      return { p, parsed, expiry }
    }).filter(Boolean)

    const tickers = [...new Set([
      ...Object.keys(positions),
      ...legs.map(l => l.parsed.ticker),
    ])]
    let prices = {}
    if (tickers.length) {
      try { prices = await priceService.fetchPrices(tickers) } catch (e) { prices = {} }
    }

    const dte = (e) => Math.round((new Date(e).getTime() - new Date(today).getTime()) / 86400000)

    const rows = tickers.map(ticker => {
      const sp = positions[ticker]
      const price = prices[ticker] || 0
      const mine = legs.filter(l => l.parsed.ticker === ticker)

      // The nearest expiry on each side is the live one — with a rolling collar
      // the far-dated legs are previous rolls still on the books.
      const shortCalls = mine.filter(l => l.p.net_short > 0 && l.parsed.type === 'call')
        .sort((a, b) => a.expiry.localeCompare(b.expiry))
      const longPuts = mine.filter(l => l.p.net_long > 0 && l.parsed.type === 'put')
        .sort((a, b) => a.expiry.localeCompare(b.expiry))

      const call = shortCalls[0]
      const put = longPuts[0]
      const cost = overrides[ticker] ?? sp?.avgCost ?? null

      return {
        ticker,
        shares: sp?.position ?? 0,
        avgCost: cost,
        price,
        call: call ? {
          strike: call.parsed.strike, expiry: call.expiry, dte: dte(call.expiry),
          contracts: call.p.net_short,
          itm: price > 0 && price > call.parsed.strike,
        } : null,
        put: put ? {
          strike: put.parsed.strike, expiry: put.expiry, dte: dte(put.expiry),
          contracts: put.p.net_long,
          itm: price > 0 && price < put.parsed.strike,
        } : null,
        // Extra rolls still open beyond the nearest leg — worth surfacing, since
        // a collar that has been rolled several times accumulates them.
        extraCalls: Math.max(0, shortCalls.length - 1),
        extraPuts: Math.max(0, longPuts.length - 1),
        coveredShares: shortCalls.reduce((n, l) => n + l.p.net_short, 0) * 100,
        protectedShares: longPuts.reduce((n, l) => n + l.p.net_long, 0) * 100,
      }
    })
    // Complete collars first, then partial, then bare stock — the ones needing
    // attention are the ones missing a leg.
    .filter(r => r.shares > 0 || r.call || r.put)
    .sort((a, b) => {
      const score = (r) => (r.call ? 1 : 0) + (r.put ? 1 : 0)
      return score(b) - score(a) || a.ticker.localeCompare(b.ticker)
    })

    res.json({ success: true, rows })
  } catch (e) {
    console.error('Collars error:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/decay?ticker=PLTR — premium earned over time on open short calls.
 *
 * The mark of a sold call falling IS money earned: you keep the difference
 * between what you sold it for and what it would now cost to buy back. When a
 * stock ranges, that gap widens every day on its own. Nothing in the app showed
 * it — the panels report a level, and this is the thing that has a shape.
 *
 * Series are per contract, in dollars kept, so they can be read against each
 * other and summed.
 */
app.get('/api/decay', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const ticker = String(req.query.ticker || '').toUpperCase()
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 90))
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const today = todayStrLocal()

    const open = databaseService.getOpenOptionPositions(userId, brokerFilter)
    const entries = databaseService.getShortCallEntries(userId, brokerFilter)
    const openShort = new Set(open.filter(p => p.net_short > 0).map(p => p.symbol))

    const wanted = entries.filter(e => {
      if (!openShort.has(e.symbol)) return false
      if (ticker && String(e.ticker || '').toUpperCase() !== ticker) return false
      const parsed = parseOptionDescription(e.symbol)
      if (!parsed) return false
      return `${parsed.year}-${parsed.month}-${parsed.day}` >= today
    })

    const series = wanted.map(e => {
      const history = databaseService.getOptionMarkHistory(userId, e.symbol, days)
      const contracts = Math.abs(e.contracts || 1)
      const premiumPerShare = contracts > 0 ? e.premium / (contracts * 100) : 0
      return {
        symbol: e.symbol,
        ticker: e.ticker,
        contracts,
        premiumPerShare: Math.round(premiumPerShare * 100) / 100,
        // Dollars kept if bought back at that day's mark. Rises as the contract
        // decays, which is the whole point of the picture.
        points: history.map(h => ({
          date: h.mark_date,
          mark: Math.round(h.close_mark * 100) / 100,
          underlying: h.underlying_close != null ? Math.round(h.underlying_close * 100) / 100 : null,
          kept: Math.round((premiumPerShare - h.close_mark) * 100 * contracts * 100) / 100,
        })),
      }
    }).filter(s => s.points.length > 0)

    res.json({
      success: true,
      ticker: ticker || null,
      days,
      series,
      // Said plainly, because an empty chart otherwise reads as "no decay".
      note: series.length === 0
        ? 'No mark history yet. Marks are captured once a day, so a few sessions are needed before there is a curve to see.'
        : null,
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Account P&L ─────────────────────────────────────────────────────────────
// What the account has actually made: cash in and out, plus what the open
// positions are worth right now.
//
// Deliberately not built from realized + unrealized. Those two split the same
// total differently depending on how cost basis is figured, which is what made
// every other figure here arguable. This one can't be: it moves only when money
// moves or a price does, so it should track the broker.
//
// The option side of the market value comes from the caller, which already
// holds the priced open positions — pricing them twice would double the Polygon
// calls for the same answer.
app.get('/api/account-pnl', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const round2 = n => Math.round(n * 100) / 100
    const { stockCash, optionCash } = databaseService.getCashFlows(userId, brokerFilter)
    // Reported but NOT added to any total — a financing cost isn't a trading
    // result, and folding it in would make both harder to read.
    const financing = databaseService.getFinancingCosts(userId, brokerFilter)

    // Only the share counts matter here, so the cost-basis method is irrelevant.
    const positions = databaseService.getStockPositionsWithCost(userId, null, brokerFilter)
    const symbols = Object.keys(positions)
    let prices = {}
    if (symbols.length > 0) {
      try { prices = await priceService.fetchPrices(symbols) } catch (e) { prices = {} }
    }
    let stockMarketValue = 0
    const unpriced = []
    symbols.forEach(s => {
      const p = prices[s]
      if (p > 0) stockMarketValue += positions[s].position * p
      else unpriced.push(s)
    })

    // Shares that arrived or left without being bought or sold. Valued at
    // today's price, which is not what they were worth when they moved — but it
    // is the size of the hole they leave in a single broker's figures, which is
    // the question being asked. Signed so that adding it closes that hole: an
    // outbound transfer credits the broker that no longer holds the shares, an
    // inbound one debits the broker that never paid for them.
    const transfers = databaseService.getShareTransfers(userId, brokerFilter)
    const transferSymbols = [...new Set(transfers.map(t => t.symbol))]
    let transferPrices = prices
    const needed = transferSymbols.filter(s => !(transferPrices[s] > 0))
    if (needed.length > 0) {
      try {
        const more = await priceService.fetchPrices(needed)
        transferPrices = { ...transferPrices, ...more }
      } catch (e) { /* leave unpriced */ }
    }
    let transferValue = 0
    const transferDetail = {}
    transfers.forEach(t => {
      const px = transferPrices[t.symbol]
      if (!(px > 0)) return
      const signed = (t.direction === 'out' ? 1 : -1) * t.quantity * px
      transferValue += signed
      transferDetail[t.symbol] = round2((transferDetail[t.symbol] || 0) + signed)
    })

    res.json({
      success: true,
      stockCashFlow: round2(stockCash),
      stockMarketValue: round2(stockMarketValue),
      stockTotal: round2(stockCash + stockMarketValue),
      optionCashFlow: round2(optionCash),
      financing,
      transferValue: round2(transferValue),
      transferCount: transfers.length,
      transferDetail,
      // Add the signed market value of open contracts to this for the account
      // total: long positions are worth what they'd sell for, short ones cost
      // that much to buy back.
      subtotalExcludingOpenOptions: round2(stockCash + stockMarketValue + optionCash + transferValue),
      positionCount: symbols.length,
      unpricedSymbols: unpriced,
    })
  } catch (e) {
    console.error('Error in /api/account-pnl:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/price-history-pnl/:ticker?price=153.45
 *
 * Previous visits to roughly this price, with the position recomputed from the
 * trades as it stood on each of those days.
 *
 * The stored snapshots supply only the DATE and the PRICE. Their P&L columns
 * were written by the calculator of the day — Buy-to-Cover as a sale, expiries
 * never booked, cost averaged over every buy ever made — so reading them back
 * compares today's corrected figure against yesterday's broken one. That put
 * MRVL at +$6,400 on a day it was nothing of the sort.
 *
 * Open option value is deliberately absent. A past option mark cannot be
 * recovered, and modelling one would turn a measurement into a guess, so the
 * figure is Net: realized options + realized stock + unrealized stock. The
 * response labels it so the UI can say what's in it.
 */
app.get('/api/price-history-pnl/:ticker', requireAuth, async (req, res) => {
  try {
    const ticker = String(req.params.ticker || '').toUpperCase()
    const price = Number(req.query.price)
    if (!(price > 0)) return res.status(400).json({ success: false, error: 'price is required' })
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    // Same window the panel is showing, or the two answer different questions —
    // its Options Total counts only closes since this date.
    const fromDate = req.query.startDate || null

    // Dates come from the stock's own price history, NOT from stored snapshots.
    //
    // Snapshots only exist on days a CSV was uploaded, so "no earlier snapshot
    // near $89" was really "you didn't upload on one of those days" — while
    // CRCL had in fact traded there on eleven sessions. Reading it as "the
    // stock was never here" is the natural interpretation and the wrong one.
    let band = Number(req.query.band) > 0 ? Number(req.query.band) : 2
    let history = []
    try {
      history = await priceService.fetchHistoricalPrices(ticker, '2y', '1d')
    } catch (e) {
      return res.json({ success: true, ticker, price, band, visits: [], reason: `No price history: ${e.message}` })
    }

    const todayStr = new Date().toISOString().slice(0, 10)
    const findNear = (pct) => {
      const hits = history
        .map(h => ({ date: String(h.date).slice(0, 10), close: h.close }))
        .filter(h => h.close > 0 && Math.abs(h.close - price) / price <= pct / 100)
        // Recent days are the visit being asked about, not a previous one.
        // today MINUS the date, so a past session is a positive number of days
        // ago. The other way round every date is negative and nothing survives.
        .filter(h => daysBetween(todayStr, h.date) >= 5)
        .sort((a, b) => b.date.localeCompare(a.date))

      // Consecutive sessions at the same level are ONE visit — Dec 9, 10 and 11
      // is a week at that price, not three separate occasions, and listing them
      // separately would fill the popover with a single fortnight.
      const visits = []
      for (const h of hits) {
        if (visits.length >= 4) break
        if (visits.some(v => Math.abs(daysBetween(h.date, v.date)) < 10)) continue
        visits.push({ date: h.date, price: Math.round(h.close * 100) / 100 })
      }
      return visits
    }

    let dates = findNear(band)
    if (dates.length === 0) { band = 5; dates = findNear(band) }

    const visits = dates.map(d => {
      const stock = databaseService.getStockStateAsOf(req.user.userId, ticker, d.date, brokerFilter)
      const optionsRealized = databaseService.getOptionRealizedAsOf(
        req.user.userId, ticker, d.date, brokerFilter, fromDate)
      const stockUnrealized = (stock.position > 0 && stock.avgCost > 0)
        ? Math.round(stock.position * (d.price - stock.avgCost) * 100) / 100
        : 0
      // The panel reports realized stock P&L only once a position is CLOSED —
      // an open one shows just its unrealized gain, so that active names aren't
      // inflated by years of booked profit. Matched here, or the comparison
      // carries a figure the column it sits next to never showed.
      const isOpen = stock.position > 0
      const stockRealized = isOpen ? 0 : stock.realized
      return {
        date: d.date,
        price: d.price,
        position: stock.position,
        avgCost: stock.avgCost,
        stockUnrealized,
        stockRealized,
        optionsRealized,
        net: Math.round((stockUnrealized + stockRealized + optionsRealized) * 100) / 100,
      }
    })

    res.json({
      success: true, ticker, price, band, visits,
      basis: 'netPlusOpen',
      fromDate,
      note: 'Same basis as the Net column: options realized in the selected period, plus stock. Open option value is excluded — past option marks are not recoverable.',
    })
  } catch (e) {
    console.error('price-history-pnl error:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

// Today as YYYY-MM-DD in LOCAL time. Not toISOString, which is UTC and gives
// yesterday's date for most of the evening in US timezones — that would treat a
// contract expiring today as already expired and stop pricing it a day early.
function todayStrLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Whole days between two YYYY-MM-DD dates. Built from the strings rather than
// Date arithmetic so it can't drift with a timezone.
function daysBetween(a, b) {
  const ms = Date.UTC(...a.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)))
           - Date.UTC(...b.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)))
  return Math.round(ms / 86400000)
}

// ─── Per-user view preferences ───────────────────────────────────────────────
// Settings that used to live in localStorage, which made them per device. The
// ones that change displayed P&L — the Cumulative P&L window, manual share and
// price overrides, hidden tickers — are why the same account read differently
// on a laptop, a phone browser and the iOS app.
app.get('/api/preferences', requireAuth, (req, res) => {
  try {
    res.json({ success: true, preferences: databaseService.getPreferences(req.user.userId) })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.put('/api/preferences/:key', requireAuth, (req, res) => {
  try {
    const key = String(req.params.key || '')
    if (!key || key.length > 120) {
      return res.status(400).json({ success: false, error: 'Bad preference key' })
    }
    if (!('value' in (req.body || {}))) {
      return res.status(400).json({ success: false, error: 'Missing value' })
    }
    // Bounded so a runaway client can't fill the volume with one row.
    if (JSON.stringify(req.body.value ?? null).length > 100000) {
      return res.status(413).json({ success: false, error: 'Preference too large' })
    }
    const ok = databaseService.setPreference(req.user.userId, key, req.body.value)
    res.json({ success: ok })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.delete('/api/preferences/:key', requireAuth, (req, res) => {
  try {
    res.json({ success: true, deleted: databaseService.deletePreference(req.user.userId, String(req.params.key || '')) })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Stock splits ────────────────────────────────────────────────────────────
// Detected from Yahoo rather than entered by hand. The chart endpoint reports
// them via events=split and, unlike quoteSummary, still works without a crumb.
app.post('/api/splits/refresh', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    // Anything already carrying a split goes first and is always checked. Both
    // position lists drop a symbol whose share count isn't above zero, so a bad
    // ratio that shrank a position to nothing would take that symbol out of the
    // sweep and strand the very row that caused it.
    const stored = Object.keys(databaseService.getSplitsRaw())
    const symbols = stored
      .concat(Object.keys(databaseService.getStockPositionsWithCost(userId)))
      .concat(Object.keys(databaseService.getAllPositions?.(userId) || {}))
    const unique = [...new Set(symbols)].filter(t => /^[A-Z.]{1,6}$/.test(t)).slice(0, 40)

    const found = []
    let removed = 0
    for (const sym of unique) {
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
                    `?range=10y&interval=1mo&events=split`
        const resp = await axios.get(url, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        })
        // A 200 that carries no result block is a bad answer, not an empty one.
        // Treat it as a failure so reconciliation can't act on it.
        const result = resp.data?.chart?.result?.[0]
        if (!result) throw new Error('no chart result')

        const splits = result.events?.splits || {}
        const confirmed = []
        Object.values(splits).forEach(sp => {
          const ratio = (sp.numerator || 0) / (sp.denominator || 1)
          if (!(ratio > 0) || ratio === 1) return
          // A real split is somewhere between a 1:20 reverse and a 100:1. A
          // ratio outside that is a malformed feed row, and applying it would
          // silently multiply or erase a position.
          if (ratio < 0.05 || ratio > 100) {
            console.warn(`Ignoring implausible ${sym} split ratio ${ratio}`)
            return
          }
          const date = new Date(sp.date * 1000).toISOString().slice(0, 10)
          databaseService.saveSplit(sym, date, ratio, 'yahoo')
          confirmed.push(date)
          found.push({ symbol: sym, date, ratio })
        })
        // Yahoo answered for this symbol, so its list is authoritative: anything
        // stored that it no longer reports was wrong and has to go.
        removed += databaseService.reconcileYahooSplits(sym, confirmed)
      } catch { /* one symbol failing shouldn't abort the sweep */ }
      await new Promise(r => setTimeout(r, 150))
    }
    await logActivity(req, 'refresh_splits',
      `Found ${found.length} splits across ${unique.length} symbols; removed ${removed} stale`)
    res.json({ success: true, checked: unique.length, found, removed })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.get('/api/splits', requireAuth, (req, res) => {
  try {
    // Reports the stored rows and whether they are actually being applied —
    // "the table has a row" and "that row is moving your share count" are
    // different questions, and confusing them wastes a debugging session.
    res.json({
      success: true,
      applied: databaseService.splitAdjustmentEnabled(),
      splits: databaseService.getSplitsRaw(),
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Remove splits by hand. A wrong ratio distorts share count and cost basis for
// every panel at once, so there has to be a way to undo one without waiting for
// the next refresh to disagree with it.
app.delete('/api/splits/:symbol', requireAuth, async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase()
    if (!/^[A-Z.]{1,6}$/.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Bad symbol' })
    }
    const deleted = databaseService.deleteSplitsForSymbol(symbol)
    await logActivity(req, 'delete_splits', `Deleted ${deleted} split(s) for ${symbol}`)
    res.json({ success: true, symbol, deleted })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.delete('/api/splits', requireAuth, async (req, res) => {
  try {
    const deleted = databaseService.deleteAllSplits()
    await logActivity(req, 'delete_splits', `Cleared all ${deleted} split(s)`)
    res.json({ success: true, deleted })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Upcoming earnings ───────────────────────────────────────────────────────
// The earnings_cache table existed but nothing ever wrote to it, and the vol
// scanner's earnings_date column is fed by a field nothing sets — so the app had
// no earnings data at all. This fills it.
//
// Source is Nasdaq, which returns a sentence rather than a date:
//   "Earnings announcement* for NVDA: Aug 26, 2026"
// Yahoo's quoteSummary would be tidier but now 401s without a crumb, same as the
// quote endpoint that broke price updates.
const EARNINGS_TTL_MS = 24 * 60 * 60 * 1000

function parseNasdaqEarnings(announcement) {
  if (!announcement) return null
  const m = String(announcement).match(/:\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})\s*$/)
  if (!m) return null            // no date scheduled — a normal, common answer
  const d = new Date(m[1])
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

async function fetchEarningsDate(ticker) {
  const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/earnings-date`
  const resp = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  })
  return parseNasdaqEarnings(resp.data?.data?.announcement)
}

app.get('/api/earnings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null

    // Holdings that matter: shares held, plus the underlyings of open options.
    const stock = databaseService.getStockPositionsWithCost(userId, null, brokerFilter)
    const optionUnderlyings = databaseService.getOpenOptionPositions(userId, brokerFilter)
      .map(p => parseOptionDescription(p.symbol)?.ticker)
      .filter(Boolean)
    const tickers = [...new Set([...Object.keys(stock), ...optionUnderlyings])]
      .filter(t => /^[A-Z.]{1,6}$/.test(t))
      .slice(0, 40)   // a hard bound on how many upstream calls one request can make

    const now = Date.now()
    const out = []
    const stale = []
    for (const t of tickers) {
      const hit = databaseService.getEarnings(t)
      if (hit && hit.updated_at && (now - hit.updated_at * 1000) < EARNINGS_TTL_MS) {
        out.push({ ticker: t, earningsDate: hit.earnings_date || null, cached: true })
      } else {
        stale.push(t)
      }
    }

    // Nasdaq is not a bulk API, so this is one call per stale ticker, spaced out.
    // Anything that fails keeps whatever was cached rather than blanking the row.
    for (const t of stale) {
      let date = null
      try { date = await fetchEarningsDate(t) } catch { date = databaseService.getEarnings(t)?.earnings_date ?? null }
      databaseService.setEarnings(t, date)
      out.push({ ticker: t, earningsDate: date, cached: false })
      await new Promise(r => setTimeout(r, 350))
    }

    const today = new Date().toISOString().slice(0, 10)
    const upcoming = out
      .filter(r => r.earningsDate && r.earningsDate >= today)
      .map(r => ({
        ...r,
        daysAway: Math.round((new Date(r.earningsDate).getTime() - new Date(today).getTime()) / 86400000),
        shares: stock[r.ticker]?.position ?? null,
        hasOptions: optionUnderlyings.includes(r.ticker),
      }))
      .sort((a, b) => a.earningsDate.localeCompare(b.earningsDate))

    res.json({
      success: true,
      upcoming,
      // Said out loud rather than implied by an empty list: a holding with no
      // scheduled date is normal, not a failure.
      noDate: out.filter(r => !r.earningsDate).map(r => r.ticker),
      checked: out.length,
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.get('/api/brokers', requireAuth, (req, res) => {
  try {
    const rows = databaseService.getBrokersForUser(req.user.userId)
    res.json({ success: true, brokers: rows, supported: SUPPORTED_BROKERS })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/extended-hours — pre/post market option marks.
//
// Robinhood moves the stock leg outside regular hours but leaves option marks
// frozen at the 4pm close, so a mixed portfolio reads inconsistently in the
// AM/PM. This reprices each open contract with Black-Scholes: the underlying
// comes from Yahoo's extended-hours feed, and the vol is the one calibrated to
// that contract's own closing mark (so skew is per-contract and the estimate is
// continuous with the close). Everything here is an ESTIMATE — the response
// labels it as such and flags the cases where it's least reliable.
app.get('/api/extended-hours', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const today = nowEt.toISOString().slice(0, 10)

    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    // IV marks are market data — the closing vol for a contract is the same
    // wherever it's held, so they carry no broker. Scoping happens below via
    // the open-position set, which IS broker-filtered.
    const ivMarks = databaseService.getLatestOptionIvMarks(userId)
    if (!ivMarks.length) {
      return res.json({
        success: true, session: 'unknown', positions: [],
        note: 'No closing implied vol captured yet. It records automatically after the 4pm ET close.',
      })
    }

    // Only price contracts that are still open and unexpired.
    // Direction and size matter, not just which contracts are open. A short
    // call's P&L is the OPPOSITE of the contract's value change — the mark going
    // up costs the seller money — so reporting the contract delta made every
    // covered call read backwards.
    const openBySymbol = new Map()
    databaseService.getOpenOptionPositions(userId, brokerFilter)
      .filter(p => (p.net_short > 0 || p.net_long > 0))
      .forEach(p => openBySymbol.set(p.symbol, {
        isShort: p.net_short > 0,
        contracts: p.net_short > 0 ? p.net_short : p.net_long,
      }))
    const openSymbols = new Set(openBySymbol.keys())
    const live = ivMarks.filter(m => openSymbols.has(m.symbol) && m.expiry > today)
    if (!live.length) {
      return res.json({ success: true, session: 'unknown', positions: [], note: 'No open unexpired option positions.' })
    }

    const tickers = [...new Set(live.map(m => m.ticker))]
    const ext = await priceService.fetchExtendedHours(tickers)

    // Earnings tonight is the big caveat: IV collapses after the print, and this
    // model holds vol constant, so those estimates can be well off.
    const earningsByTicker = {}
    for (const t of tickers) {
      try { earningsByTicker[t] = databaseService.getEarnings(t)?.earnings_date || null } catch { /* optional */ }
    }

    const positions = []
    for (const m of live) {
      const e = ext[m.ticker]
      if (!e || !(e.price > 0)) continue
      const yrs = ms => ms / (365.25 * 24 * 3600 * 1000)
      const expiryMs = new Date(m.expiry).getTime()
      const T1 = yrs(expiryMs - nowEt.getTime())                  // now → expiry
      const T0 = yrs(expiryMs - new Date(m.mark_date).getTime())  // calibration date → expiry
      if (!(T1 > 0) || !(T0 > 0)) continue

      // Anchor on the real closing mark and let Black-Scholes supply only the
      // change. See repriceFromClose for why the difference form is used.
      const estMark = repriceFromClose({
        type: m.opt_type, closeMark: m.close_mark,
        S0: m.underlying_close, S1: e.price,
        K: m.strike, T0, T1, sigma: m.sigma, r: RISK_FREE_RATE,
      })
      if (estMark == null) continue
      const contractDelta = estMark - m.close_mark
      const pos = openBySymbol.get(m.symbol) || { isShort: false, contracts: 1 }
      // +1 long, -1 short: what the holder actually makes or loses.
      const sign = pos.isShort ? -1 : 1
      const delta = contractDelta * sign
      const underlyingMove = e.price - m.underlying_close
      const movePct = m.underlying_close > 0 ? (underlyingMove / m.underlying_close) * 100 : 0

      positions.push({
        symbol: m.symbol,
        ticker: m.ticker,
        type: m.opt_type,
        strike: m.strike,
        expiry: m.expiry,
        closeMark: round2(m.close_mark),
        estMark: round2(estMark),
        isShort: pos.isShort,
        contracts: pos.contracts,
        // P&L from the holder's side, and for the whole position — not the
        // contract's value change, and not per single contract.
        changePerShare: round2(delta),
        changePerContract: round2(delta * 100),
        positionPnl: round2(delta * 100 * pos.contracts),
        contractMarkChange: round2(contractDelta),
        underlyingClose: round2(m.underlying_close),
        underlyingNow: round2(e.price),
        underlyingMovePct: Math.round(movePct * 100) / 100,
        sigma: Math.round(m.sigma * 1000) / 1000,
        ivDate: m.mark_date,
        session: e.session,
        // Reliability flags — surfaced so a confident-looking number isn't trusted blindly.
        noExtendedTrade: e.stale,
        staleIv: m.mark_date < today,
        earningsTonight: !!earningsByTicker[m.ticker] && earningsByTicker[m.ticker] === today,
        largeMove: Math.abs(movePct) > 3,
        estimated: true,
      })
    }

    const session = Object.values(ext).find(v => v?.session)?.session || 'unknown'
    res.json({
      success: true,
      session,
      asOf: Date.now(),
      positions,
      estimated: true,
      note: 'Model estimate: Black-Scholes repriced on the extended-hours underlying, holding each contract\'s closing implied vol constant.',
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Manual trigger for the closing-IV capture (the scheduled run is 4:05-4:30pm ET).
app.post('/api/extended-hours/capture-iv', requireAuth, async (req, res) => {
  try {
    const saved = await captureClosingIV(req.user.userId)
    res.json({ success: true, captured: saved })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/short-calls — short call positions with current prices
app.get('/api/short-calls', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    // Broker tab: 'all' (or absent) keeps every broker.
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const entries = databaseService.getShortCallEntries(userId, brokerFilter)

    // Get open short option positions for status determination
    const openPositions = databaseService.getOpenOptionPositions(userId, brokerFilter)
    const openShortSymbols = new Set(
      openPositions.filter(p => p.net_short > 0).map(p => p.symbol)
    )
    const netShortBySymbol = {}
    openPositions.forEach(p => { netShortBySymbol[p.symbol] = p.net_short })

    // ── Which ENTRIES are still open ─────────────────────────────────────
    //
    // Open-ness was decided per SYMBOL: if a contract had any short position
    // left, every entry for it showed as open. Buy one back and re-sell it and
    // you get a third entry — a new sale date — while the net is still two, so
    // the tracker listed three open calls for a two-call position. That's the
    // HOOD case: bought a call back, sold shares, then reversed both.
    //
    // net_short is now allocated across a symbol's entries, NEWEST SALE FIRST.
    // Newest-first because a re-sold contract is the position actually held
    // now; the older entry it replaced is the one that was closed. Entries past
    // the allocation are marked closed.
    const openContractsByEntry = allocateOpenShortContracts(
      entries, openShortSymbols, netShortBySymbol)

    // ── Covering long calls ──────────────────────────────────────────────
    // short_call_entries only ever holds STO calls, so the long leg of a
    // vertical was never a candidate here — it wasn't filtered out, it was
    // never looked for. Built before the price fetch because the long leg needs
    // a mark of its own: without one the P&L is the short leg alone, which
    // overstates the loss on a rally by exactly what the long leg gained.
    const availableLongs = openPositions
      .filter(p => p.net_long > 0)
      .map(p => {
        const parsed = parseOptionDescription(p.symbol)
        if (!parsed || parsed.type !== 'call') return null
        return {
          symbol: p.symbol,
          ticker: parsed.ticker,
          strike: parsed.strike,
          expiry: `${parsed.year}-${parsed.month}-${parsed.day}`,
          remaining: p.net_long,
          costPerContract: p.bto_contracts > 0 ? Math.abs(p.total_paid) / p.bto_contracts : 0,
        }
      })
      .filter(Boolean)

    // Fetch current option prices via Polygon for open positions
    const polygonKey = process.env.POLYGON_API_KEY || ''
    const optionPrices = {} // fresh marks (live quote / today's trade)
    const optionClose = {}  // stale fallback marks (daily close / old trade)
    const polygonStockPrices = {}
    if (polygonKey) {
      // Long legs are priced alongside the shorts. Same marks, same fallbacks —
      // a spread's P&L is only right if both sides are marked the same way.
      const toPrice = [
        ...entries.filter(e => openShortSymbols.has(e.symbol)).map(e => e.symbol),
        ...availableLongs.map(l => l.symbol),
      ]
      for (const symbol of [...new Set(toPrice)]) {
        const polygonTicker = toPolygonTicker(symbol)
        const parsed = parseOptionDescription(symbol)
        if (!polygonTicker || !parsed) continue
        // Real (delayed) bid/ask mid from the quotes endpoint — the actual market mark.
        const qMid = await fetchOptionQuoteMid(polygonTicker, polygonKey)
        if (qMid > 0) optionPrices[symbol] = qMid
        try {
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
          const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 5000 })
          const snap = resp.data?.results
          if (snap) {
            if (!(qMid > 0)) {
              const fresh = freshOptionMark(snap)   // snapshot last_quote (usually null on delayed)
              if (fresh > 0) optionPrices[symbol] = fresh
            }
            const stale = staleOptionMark(snap)   // daily close / old trade (fallback)
            if (stale > 0) optionClose[symbol] = stale
            const underlyingPrice = snap.underlying_asset?.price
            if (underlyingPrice > 0) polygonStockPrices[parsed.ticker] = underlyingPrice
          }
        } catch (e) { /* skip */ }
      }
    }

    // Fetch stock prices for all tickers not already obtained from Polygon
    const allTickers = [...new Set(entries.map(e => e.ticker))]
    const missingTickers = allTickers.filter(t => !polygonStockPrices[t])
    if (missingTickers.length > 0) {
      try {
        // Use priceService (Yahoo spark) — the old v7/finance/quote endpoint now 401s,
        // which is why Current Stock stopped updating here.
        const fetched = await priceService.fetchPrices(missingTickers)
        missingTickers.forEach(t => { if (fetched[t] > 0) polygonStockPrices[t] = fetched[t] })
        console.log(`Short-calls: fetched ${missingTickers.filter(t => polygonStockPrices[t] > 0).length}/${missingTickers.length} stock prices`)
      } catch (e) {
        console.warn('Short-calls price fetch failed:', e.message)
        // Last resort: in-memory cache
        const cached = priceService.getCurrentPrices()
        missingTickers.forEach(t => { if (cached[t] > 0) polygonStockPrices[t] = cached[t] })
      }
    }

    // A long call covers a short one when it's the same underlying, struck
    // higher, and expires no earlier. Nearest strike wins, and contracts are
    // consumed so one long can't be claimed by two shorts.
    const findCover = (entry, shortContracts) => {
      const parsed = parseOptionDescription(entry.symbol)
      if (!parsed) return null
      const candidates = availableLongs
        .filter(l => l.remaining > 0 && l.ticker === entry.ticker &&
                     l.strike > parsed.strike && l.expiry >= entry.expiry)
        .sort((a, b) => (a.strike - b.strike) || a.expiry.localeCompare(b.expiry))
      const cover = candidates[0]
      if (!cover) return null

      const covered = Math.min(cover.remaining, shortContracts)
      cover.remaining -= covered
      const width = Math.round((cover.strike - parsed.strike) * 100) / 100
      const longCost = cover.costPerContract * covered
      return {
        symbol: cover.symbol,
        strike: cover.strike,
        expiry: cover.expiry,
        contracts: covered,
        sameExpiry: cover.expiry === entry.expiry,
        width,
        longCost: Math.round(longCost * 100) / 100,
        // Fully covered only when every short contract has a long behind it.
        fullyCovered: covered >= shortContracts,
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    const result = entries.map(entry => {
      const currentStock = polygonStockPrices[entry.ticker] > 0 ? polygonStockPrices[entry.ticker] : null
      // Prefer a live quote / today's trade; else a Black–Scholes model mark that
      // moves with the underlying; else the stale daily close.
      let currentOptionPrice = optionPrices[entry.symbol] || null
      let priceSource = currentOptionPrice != null ? 'quote' : null
      if (currentOptionPrice == null) {
        const model = modelOptionMark(entry, parseOptionDescription(entry.symbol), currentStock)
        if (model > 0) { currentOptionPrice = model; priceSource = 'model' }
        else if (optionClose[entry.symbol] > 0) { currentOptionPrice = optionClose[entry.symbol]; priceSource = 'close' }
      }
      // Open only if this ENTRY still holds contracts, not merely because the
      // symbol does.
      const entryOpenContracts = openContractsByEntry[entry.id]
      const isOpen = entryOpenContracts != null ? entryOpenContracts > 0 : openShortSymbols.has(entry.symbol)
      const expiryMs = new Date(entry.expiry + 'T00:00:00Z').getTime()
      const todayMs = new Date(today + 'T00:00:00Z').getTime()
      const daysToExpiry = Math.round((expiryMs - todayMs) / (1000 * 60 * 60 * 24))
      const isExpired = daysToExpiry < 0
      // entry.premium is the TOTAL dollars received for the stored contracts. If the
      // entry undercounts (split-fill collapse) and it's the only open entry for the
      // symbol, scale to the actual open contract count from trades (net_short).
      const entryContracts = entry.contracts || 1
      // How many of this entry's contracts are actually still open. The
      // allocation above knows, so prefer it; the old rescale only worked when
      // a symbol had exactly one entry and guessed otherwise.
      const effContracts = isOpen && entryOpenContracts > 0 ? entryOpenContracts : entryContracts
      const shares = effContracts * 100
      const premiumPerShare = entryContracts > 0 ? entry.premium / (entryContracts * 100) : entry.premium
      const callGainPerShare = (currentOptionPrice != null) ? (premiumPerShare - currentOptionPrice) : null

      // Only an open short can still be covered by anything.
      const cover = isOpen ? findCover(entry, effContracts) : null
      let spread = null
      if (cover) {
        const premiumTotal = premiumPerShare * shares
        const netCredit = Math.round((premiumTotal - cover.longCost) * 100) / 100
        // A call credit spread's worst case is the strike width, less what was
        // taken in. Only meaningful when every short contract is covered — a
        // partly covered position still has an uncapped tail.
        const maxLoss = cover.fullyCovered
          ? Math.round((cover.width * 100 * cover.contracts - netCredit) * 100) / 100
          : null

        // The long leg's own P&L. Priced from the same marks as the short leg,
        // so the two are comparable; null when it has no mark at all, because
        // showing a spread P&L that silently omits one side is worse than
        // showing nothing.
        const longMark = optionPrices[cover.symbol] ?? optionClose[cover.symbol] ?? null
        const longPnl = longMark != null
          ? Math.round((longMark * 100 - cover.costPerContract) * cover.contracts * 100) / 100
          : null
        const shortPnl = callGainPerShare != null
          ? Math.round(callGainPerShare * shares * 100) / 100
          : null
        // What the position is actually worth. The short leg alone overstates a
        // rally: the long leg is gaining exactly while the short one loses.
        const netPnl = (longPnl != null && shortPnl != null)
          ? Math.round((shortPnl + longPnl) * 100) / 100
          : null

        spread = {
          ...cover,
          netCredit,
          maxLoss,
          maxProfit: netCredit,
          longMark,
          longMarkSource: optionPrices[cover.symbol] != null ? 'quote'
            : optionClose[cover.symbol] != null ? 'close' : null,
          longPnl,
          shortPnl,
          netPnl,
        }
      }

      return {
        ...entry,
        spread,
        contracts: effContracts,
        premium: Math.round(premiumPerShare * 100) / 100,
        premiumTotal: Math.round(premiumPerShare * shares * 100) / 100,
        currentStock,
        currentOptionPrice,
        priceSource,
        isOpen,
        isExpired,
        daysToExpiry,
        stockMove: (currentStock != null && entry.underlying_close != null) ? Math.round((currentStock - entry.underlying_close) * 100) / 100 : null,
        thetaGain: callGainPerShare != null ? Math.round(callGainPerShare * 100) / 100 : null,
        callGainTotal: callGainPerShare != null ? Math.round(callGainPerShare * shares * 100) / 100 : null
      }
    })

    // ── One row per CONTRACT ─────────────────────────────────────────────
    //
    // Rows were one per ENTRY, so selling the same contract on two dates listed
    // it twice — but that's one position of two contracts, not two positions.
    // Merged after pricing rather than before, so every per-entry mark and P&L
    // is computed exactly as it was and only the presentation changes.
    //
    // Dollar figures add; per-share figures are weighted by contracts, because
    // an average premium ignoring size would misreport a 1-and-5 split as if it
    // were 3 and 3.
    const merged = []
    const bySym = new Map()
    for (const r of result) {
      // Only open rows merge. Closed ones are history and each closed on its own
      // terms, so collapsing them would destroy the record.
      const key = r.isOpen ? `${r.broker || 'robinhood'}::${r.symbol}` : `closed::${r.id}`
      const prev = bySym.get(key)
      if (!prev) {
        bySym.set(key, { ...r, saleCount: 1, saleDates: [r.sale_date].filter(Boolean) })
        merged.push(key)
        continue
      }
      const a = prev.contracts || 0, b = r.contracts || 0
      const tot = a + b
      const wavg = (x, y) => (tot > 0 ? ((x || 0) * a + (y || 0) * b) / tot : (x ?? y))
      prev.premium = round2(wavg(prev.premium, r.premium))
      prev.underlying_close = (prev.underlying_close != null && r.underlying_close != null)
        ? round2(wavg(prev.underlying_close, r.underlying_close))
        : (prev.underlying_close ?? r.underlying_close)
      prev.thetaGain = (prev.thetaGain != null && r.thetaGain != null)
        ? round2(wavg(prev.thetaGain, r.thetaGain)) : (prev.thetaGain ?? r.thetaGain)
      prev.stockMove = prev.stockMove ?? r.stockMove
      prev.contracts = tot
      prev.premiumTotal = round2((prev.premiumTotal || 0) + (r.premiumTotal || 0))
      prev.callGainTotal = (prev.callGainTotal != null || r.callGainTotal != null)
        ? round2((prev.callGainTotal || 0) + (r.callGainTotal || 0)) : null
      prev.saleCount += 1
      if (r.sale_date) prev.saleDates.push(r.sale_date)
      // Keep the earliest sale as the row's date — it's when the position began.
      if (r.sale_date && (!prev.sale_date || r.sale_date < prev.sale_date)) prev.sale_date = r.sale_date
    }
    const mergedRows = merged.map(k => {
      const r = bySym.get(k)
      r.saleDates = [...new Set(r.saleDates)].sort()
      return r
    })

    res.json({ success: true, entries: mergedRows, polygonEnabled: !!polygonKey })
  } catch (e) {
    console.error('Error in /api/short-calls:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/short-calls/:id/trades — the individual sales behind one row.
 *
 * short_call_entries is keyed (user, symbol, sale_date) and the upsert
 * OVERWRITES premium and contracts, so two sales of the same contract on the
 * same day collapse into one row with only the later one's numbers. The tracker
 * papers over the count by rescaling to net_short, but the individual fills —
 * different times, different prices — exist nowhere in that table.
 *
 * The trades themselves are the real record, so this reads from there. Closing
 * trades are included too: a position built over several sales is usually
 * unwound the same way, and seeing only one side of that is misleading.
 */
app.get('/api/short-calls/:id/trades', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const id = parseInt(req.params.id)
    const entry = databaseService.getShortCallEntries(userId).find(e => e.id === id)
    if (!entry) return res.status(404).json({ success: false, error: 'Entry not found' })

    const rows = databaseService.getTradesForOptionSymbol(userId, entry.symbol, entry.broker || null)
    const fills = rows.map(t => {
      const contracts = Math.abs(t.contracts || 1)
      const amount = Math.abs(t.amount || 0)
      const code = String(t.trans_code || '').toUpperCase()
      const opening = code === 'STO'
      return {
        date: String(t.trans_date).slice(0, 10),
        transCode: code,
        opening,
        contracts,
        // Per contract and per share, because the tracker shows per share and
        // a broker statement shows per contract.
        totalAmount: Math.round(amount * 100) / 100,
        perContract: Math.round((amount / contracts) * 100) / 100,
        perShare: Math.round((amount / contracts / 100) * 100) / 100,
      }
    })

    const sold = fills.filter(f => f.opening)
    const closed = fills.filter(f => !f.opening)
    const soldContracts = sold.reduce((n, f) => n + f.contracts, 0)
    const soldTotal = sold.reduce((n, f) => n + f.totalAmount, 0)

    res.json({
      success: true,
      symbol: entry.symbol,
      fills,
      summary: {
        sales: sold.length,
        soldContracts,
        soldTotal: Math.round(soldTotal * 100) / 100,
        avgPerShare: soldContracts > 0
          ? Math.round((soldTotal / soldContracts / 100) * 100) / 100 : null,
        closes: closed.length,
        // The row's stored figures, so a disagreement with the trades is
        // visible rather than something to be discovered later.
        storedContracts: entry.contracts,
        storedPremium: entry.premium,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// PUT /api/short-calls/:id/underlying-close — manually set underlying close for a short call entry
app.put('/api/short-calls/:id/underlying-close', requireAuth, (req, res) => {
  try {
    const { id } = req.params
    const { underlyingClose } = req.body
    databaseService.updateShortCallUnderlyingClose(parseInt(id), parseFloat(underlyingClose))
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// POST /api/short-calls/rebuild — retroactively populate short_call_entries from existing trades
app.post('/api/short-calls/rebuild', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const stoCallTrades = databaseService.getStoCallTrades(userId)
    let populated = 0; let skipped = 0
    for (const trade of stoCallTrades) {
      const parsed = parseOptionDescription(trade.symbol)
      if (!parsed) { skipped++; continue }
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      let underlyingClose = null
      try {
        underlyingClose = await priceService.getPriceForDate(parsed.ticker, trade.trans_date)
      } catch (e) { /* leave null */ }
      databaseService.upsertShortCallEntry(userId, {
        symbol: trade.symbol,
        ticker: parsed.ticker,
        strike: parsed.strike,
        expiry,
        contracts: trade.contracts || 1,
        premium: Math.abs(trade.price),
        saleDate: trade.trans_date,
        underlyingClose,
        broker: trade.broker || 'robinhood'
      })
      populated++
    }
    res.json({ success: true, populated, skipped })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/short-calls/:id/history — time series of the underlying stock price
// and the MODELED short-call price since the sale date, for charting. There are
// no historical option quotes on the data plan, so the call line is a
// Black–Scholes reconstruction. Implied vol is anchored at BOTH ends — to the
// premium sold for on the sale date, and to the contract's live quote today —
// and walked between them, so the reconstruction lands on what the position is
// actually worth now instead of drifting off a vol that describes only the day
// it was sold. Falls back to the single sale-date anchor when no quote is
// available. It's an estimate, labeled as such in the UI.
app.get('/api/short-calls/:id/history', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const id = parseInt(req.params.id)
    const entry = databaseService.getShortCallEntries(userId).find(e => e.id === id)
    if (!entry) return res.status(404).json({ success: false, error: 'Entry not found' })

    const parsed = parseOptionDescription(entry.symbol)
    if (!parsed) return res.status(400).json({ success: false, error: 'Could not parse option contract' })

    const K = parsed.strike
    const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
    const saleDate = String(entry.sale_date).slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    const endDate = expiry < today ? expiry : today

    // Smallest Yahoo range that reaches back to the sale date.
    const daysSinceSale = Math.max(1, Math.round((Date.now() - new Date(saleDate + 'T00:00:00Z').getTime()) / 86400000))
    const range = daysSinceSale < 25 ? '1mo' : daysSinceSale < 80 ? '3mo' : daysSinceSale < 175 ? '6mo'
      : daysSinceSale < 360 ? '1y' : daysSinceSale < 720 ? '2y' : '5y'

    let hist
    try {
      hist = await priceService.fetchHistoricalPrices(parsed.ticker, range, '1d')
    } catch (e) {
      return res.status(502).json({ success: false, error: 'Could not fetch stock history: ' + e.message })
    }

    // Anchor implied vol to what the call was sold for on the sale date.
    const r = 0.045
    const contracts = entry.contracts || 1
    const premiumPerShare = entry.premium / (contracts * 100)
    const Sat = Number(entry.underlying_close)
    const yrs = (a, b) => (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / (365.25 * 24 * 3600 * 1000)
    const Tsale = yrs(saleDate, expiry)
    let sigma = 0
    if (premiumPerShare > 0 && Sat > 0 && Tsale > 0) sigma = impliedVolCall(premiumPerShare, Sat, K, Tsale, r)
    const optionModeled = sigma > 0

    // Second anchor: the vol implied by what the contract is worth NOW.
    //
    // One vol held from the sale date describes the world on the sale date. The
    // panel already learned this — "MRVL was sold near $150 and now trades near
    // $236, so a vol anchored to that sale is describing a different world" —
    // and moved to a real quote. This endpoint kept repricing off the frozen
    // sale-date vol, so a call sold far out of the money on a stock that then
    // rallied is marked far above what anyone would pay: MRVL's 380 read a
    // $2,200 loss where the panel, on a market mark, read -$230.
    //
    // Solving a second vol from today's quote and walking between the two
    // leaves both ends exact and the middle a smooth transition, rather than a
    // curve that is only honest on its first day.
    let sigmaNow = 0, markNow = 0, markNowBasis = null
    const lastDate = (() => {
      for (let i = hist.length - 1; i >= 0; i--) {
        const d = (hist[i].date || '').slice(0, 10)
        if (d && d >= saleDate && d <= endDate && hist[i].close > 0) return d
      }
      return null
    })()
    if (optionModeled && lastDate) {
      try {
        const polygonKey = process.env.POLYGON_API_KEY || ''
        const polyTicker = toPolygonTicker(entry.symbol)
        if (polygonKey && polyTicker) {
          // The same ladder the panel walks: live quote, then a fresh print,
          // then the last market print. A single quote lookup is not enough —
          // a call sold far out of the money often has no two-sided quote at
          // all, which is exactly when the frozen-vol model is worst, so the
          // chart would fall back to the model precisely where it is wrong.
          markNow = await fetchOptionQuoteMid(polyTicker, polygonKey)
          if (markNow > 0) markNowBasis = 'quote'
          if (!(markNow > 0)) {
            const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polyTicker}`
            const snap = (await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })).data?.results
            if (snap) {
              const fresh = freshOptionMark(snap)
              const stale = staleOptionMark(snap)
              if (fresh > 0) { markNow = fresh; markNowBasis = 'fresh' }
              else if (stale > 0) { markNow = stale; markNowBasis = 'close' }
            }
          }
          const Snow = hist.find(h => (h.date || '').slice(0, 10) === lastDate)?.close
          const Tnow = yrs(lastDate, expiry)
          if (markNow > 0 && Snow > 0 && Tnow > 0) {
            const s = impliedVolCall(markNow, Snow, K, Tnow, r)
            if (s > 0) sigmaNow = s
          }
        }
      } catch { /* no quote — one anchor is still better than none */ }
    }

    // Fraction of the way from the sale date to the last plotted day.
    const spanDays = lastDate ? Math.max(1, (new Date(lastDate) - new Date(saleDate)) / 86400000) : 1

    const series = []
    for (const h of hist) {
      const d = (h.date || '').slice(0, 10)
      if (!d || d < saleDate || d > endDate) continue
      const close = h.close
      if (!(close > 0)) continue
      let callPrice = null, callNoDecay = null
      if (optionModeled) {
        const T = yrs(d, expiry)
        const w = sigmaNow > 0
          ? Math.min(1, Math.max(0, (new Date(d) - new Date(saleDate)) / 86400000 / spanDays))
          : 0
        const sig = sigma + (sigmaNow - sigma) * w
        const raw = T > 0 ? bsCall(close, K, T, r, sig) : Math.max(0, close - K)
        callPrice = Math.round(raw * 100) / 100
        // Counterfactual: the same contract at the same stock price, but with
        // time frozen at the sale date. The gap to callPrice is what decay has
        // absorbed — the point of the strategy, and invisible on a single line.
        // CRWV reads -$417 today against -$294 on 7/30 with the stock ~$10
        // higher: nearly the same loss while the underlying ran, which is decay
        // doing the work and nothing on the chart said so.
        const rawNoDecay = Tsale > 0 ? bsCall(close, K, Tsale, r, sig) : Math.max(0, close - K)
        callNoDecay = Math.round(rawNoDecay * 100) / 100
      }
      series.push({ date: d, stock: Math.round(close * 100) / 100, callPrice, callNoDecay })
    }

    res.json({
      success: true,
      ticker: parsed.ticker,
      strike: K,
      expiry,
      saleDate,
      premiumPerShare: Math.round(premiumPerShare * 100) / 100,
      underlyingAtSale: Sat > 0 ? Sat : null,
      sigma: optionModeled ? Math.round(sigma * 1000) / 1000 : null,
      optionModeled,
      // The second anchor, reported so a chart that still looks wrong can be
      // told apart from one that simply found no mark to anchor to.
      sigmaNow: sigmaNow > 0 ? Math.round(sigmaNow * 1000) / 1000 : null,
      markNow: markNow > 0 ? Math.round(markNow * 100) / 100 : null,
      markNowBasis,
      twoAnchor: sigmaNow > 0,
      series
    })
  } catch (e) {
    console.error('Error in /api/short-calls/:id/history:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

// Get daily EOD price snapshot for a specific date (default: most recent trading day)
app.get('/api/daily-snapshot', requireAuth, async (req, res) => {
  try {
    const { date, force } = req.query
    // Resolve date: use provided date, or infer last trading day (Mon-Fri; on Mon use Friday)
    let targetDate = date
    if (!targetDate) {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
      const day = et.getDay()
      const offset = day === 0 ? 2 : day === 1 ? 3 : 1  // Sun→Fri, Mon→Fri, else yesterday
      et.setDate(et.getDate() - offset)
      targetDate = et.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    }

    // If force=true, re-run snapshot for today (manual trigger)
    if (force === 'true') {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      if (targetDate === today) {
        await takeEODSnapshot(req.user.userId, true)
      }
    }

    const snapshot = databaseService.getDailyPriceSnapshot(req.user.userId, targetDate)
    const dates = databaseService.getDailySnapshotDates(req.user.userId, 10)
    res.json({ success: true, date: targetDate, snapshot, availableDates: dates })
  } catch (e) {
    console.error('Error in /api/daily-snapshot:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

// Debug endpoint to check option trades in database
app.get('/api/debug/option-trades', requireAuth, (req, res) => {
  try {
    const all = databaseService.getOptionTrades(req.user.userId)
    const byWeek = {}
    all.forEach(t => {
      const week = t.trans_date.slice(0, 7)
      byWeek[week] = (byWeek[week] || 0) + 1
    })
    res.json({ total: all.length, byMonth: byWeek, sample: all.slice(-5) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Debug endpoint to see what snapshot dates exist
app.get('/api/debug/snapshot-dates', requireAuth, (req, res) => {
  try {
    const dates = databaseService.getSnapshotDates(req.user.userId)
    res.json({
      success: true,
      dates: dates,
      count: dates.length,
      latest: dates[dates.length - 1]
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Debug endpoint to check daily P&L data
app.get('/api/debug/daily-pnl', requireAuth, (req, res) => {
  try {
    const dailyPnL = databaseService.getDailyPnLHistory(req.user.userId)
    res.json({
      success: true,
      data: dailyPnL,
      count: dailyPnL.length,
      sample: dailyPnL.slice(0, 5)
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Debug endpoint to list all users (for debugging login issues)
app.get('/api/debug/users', (req, res) => {
  try {
    const users = authService.getAllUsers()
    res.json({
      success: true,
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        created_at: u.created_at,
        last_login: u.last_login
      })),
      count: users.length
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Admin password reset — gated by a secret ADMIN_RESET_KEY that only the app
// owner sets in the environment (Railway). Disabled entirely if the env var is
// unset, so it can't be used for account takeover. Intended for recovering a
// forgotten password (e.g. the original jkosarin account).
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { username, newPassword, resetKey } = req.body

    const adminKey = process.env.ADMIN_RESET_KEY
    if (!adminKey) {
      return res.status(403).json({ success: false, error: 'Password reset is disabled (no ADMIN_RESET_KEY configured).' })
    }
    if (!resetKey || resetKey !== adminKey) {
      return res.status(403).json({ success: false, error: 'Invalid reset key.' })
    }

    if (!username || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Username and new password required'
      })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' })
    }

    const bcrypt = await import('bcryptjs')
    const passwordHash = await bcrypt.hash(newPassword, 10)

    const db = await import('./services/database.js').then(m => m.getDatabase())
    const result = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(passwordHash, username)

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      })
    }

    res.json({
      success: true,
      message: 'Password reset successfully'
    })
  } catch (error) {
    console.error('Error resetting password:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Debug endpoint to check pnl_snapshots table directly
app.get('/api/debug/snapshots-raw', requireAuth, (req, res) => {
  try {
    const debugInfo = databaseService.getSnapshotsDebugInfo(req.user.userId)
    res.json(debugInfo)
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Get list of tracked symbols
app.get('/api/tracked-symbols', (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        symbols: Array.from(trackedSymbols).sort(),
        count: trackedSymbols.size
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Stock positions with avg cost and live prices — used by YTD Positions panel
app.get('/api/stock-positions-with-prices', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    // getStockPositionsWithCost lives in database.js where db is in scope
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const stockData = databaseService.getStockPositionsWithCost(
      userId, null, brokerFilter, req.query.basis === 'corrected' ? 'fifo' : 'average')
    const symbols = Object.keys(stockData)
    console.log(`/api/stock-positions-with-prices: getStockPositionsWithCost returned ${symbols.length} symbols: ${symbols.join(', ')}`)

    if (symbols.length === 0) {
      // Fallback: try raw getAllPositions to diagnose
      const rawPos = databaseService.getAllPositions(userId)
      const rawSymbols = Object.keys(rawPos)
      console.log(`  getAllPositions fallback: ${rawSymbols.length} symbols: ${rawSymbols.join(', ')}`)
      return res.json({ success: true, holdings: [], debug: { stockDataEmpty: true, rawPositions: rawPos } })
    }

    // Use priceService.fetchPrices — handles Polygon grouped (if key set) or Yahoo Finance
    const prices = await priceService.fetchPrices(symbols)
    console.log(`  prices: ${Object.values(prices).filter(p => p > 0).length}/${symbols.length} non-zero`)

    const holdings = symbols.map(sym => {
      const d = stockData[sym]
      const currentPrice = prices[sym] || null
      const unrealizedPnL = (d.position > 0 && d.avgCost > 0 && currentPrice)
        ? Math.round(d.position * (currentPrice - d.avgCost) * 100) / 100
        : null
      return { symbol: sym, position: d.position, avgCost: d.avgCost, currentPrice, unrealizedPnL }
    })
    console.log(`  prices fetched: ${Object.keys(prices).length}/${symbols.length}`)
    res.json({ success: true, holdings })
  } catch (error) {
    console.error('Error in /api/stock-positions-with-prices:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Debug: raw option trades for a ticker — diagnose open premium / P&L issues
app.get('/api/debug-option-trades', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const ticker = (req.query.ticker || '').toUpperCase()
    const rows = databaseService.getRawOptionTradesForTicker(userId, ticker)
    res.json({ success: true, ticker, count: rows.length, rows })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Health/diagnostic: reports which DB file this process is using, its short-call row
// count, and a per-process instance id. Hitting it repeatedly should always return the
// SAME instanceId + count — if they flip, more than one replica is serving (volume bug).
const INSTANCE_ID = Math.random().toString(36).slice(2, 10)
const PROCESS_STARTED = Date.now()
app.get('/api/health', (req, res) => {
  // Included so an options key that has quietly lost its quotes entitlement is
  // visible here rather than only as marks that look a bit stale.
  const oq = {
    ...optionQuoteHealth,
    verdict: optionQuoteHealth.attempts === 0 ? 'not tried yet'
      : optionQuoteHealth.withQuote > 0 ? 'quotes working'
      : optionQuoteHealth.errors > 0 ? 'every quote call errored — check the key and its entitlement'
      : 'every quote call returned no results — key is probably not entitled to option quotes',
  }
  let shortCalls = null
  try { shortCalls = databaseService.getShortCallEntries(1).length } catch (e) { shortCalls = `err:${e.message}` }
  // Report where data actually lives so we can confirm it's on the persistent volume.
  const volumeDirs = {}
  for (const dir of VOLUME_CANDIDATES) {
    let exists = false, writable = false
    try { exists = fs.existsSync(dir) } catch { /* ignore */ }
    if (exists) {
      try { const p = `${dir}/.write-probe`; fs.writeFileSync(p, String(Date.now())); fs.unlinkSync(p); writable = true } catch { /* ro */ }
    }
    volumeDirs[dir] = { exists, writable }
  }
  // Surface real (non-virtual) mounts so we can locate the Railway volume wherever it's
  // actually mounted, and whether it already contains a trading_data.db (recoverable data).
  const VIRTUAL_FS = ['proc','sysfs','tmpfs','devtmpfs','devpts','cgroup','cgroup2','mqueue','overlay','shm','securityfs','pstore','bpf','tracefs','debugfs','fusectl','configfs','autofs','hugetlbfs','ramfs','nsfs','binfmt_misc']
  let mounts = []
  try {
    mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(Boolean)
      .map(l => l.split(' '))
      .filter(p => p[1] && !VIRTUAL_FS.includes(p[2]) && p[1] !== '/')
      .map(p => {
        const mnt = p[1]
        let hasDb = false, files = []
        try { files = fs.readdirSync(mnt).slice(0, 20) } catch { /* ignore */ }
        try { hasDb = fs.existsSync(`${mnt}/trading_data.db`) } catch { /* ignore */ }
        return { mount: mnt, type: p[2], hasTradingDb: hasDb, files }
      })
  } catch { /* ignore */ }
  res.json({
    optionQuotes: oq,
    ok: true,
    instanceId: INSTANCE_ID,
    dbPath,
    onVolume: VOLUME_CANDIDATES.some(d => dbPath.startsWith(d)),
    databasePathEnvSet: !!process.env.DATABASE_PATH,
    volumeDirs,
    mounts,
    shortCallEntries: shortCalls,
    uptimeSec: Math.round((Date.now() - PROCESS_STARTED) / 1000)
  })
})

// Debug: show the raw Polygon snapshot + computed mark for open short calls,
// so we can see exactly why an option price is/ isn't updating (e.g. MRVL/CRWV).
// Usage: /api/debug-option-mark?symbol=MRVL  (substring match; omit for all)
app.get('/api/debug-option-mark', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const polygonKey = process.env.POLYGON_API_KEY || ''
    if (!polygonKey) return res.json({ error: 'No POLYGON_API_KEY set on server' })
    const wanted = (req.query.symbol || '').toLowerCase()
    const contract = (req.query.contract || '').trim() // exact option description, bypasses the DB
    const allEntries = databaseService.getShortCallEntries(userId)
    // ?contract=... tests one exact contract directly (no dependence on short_call_entries)
    let entries
    if (contract) {
      entries = [{ symbol: contract }]
    } else {
      // Match on symbol OR ticker (the MRVL row may carry the ticker in either column)
      entries = wanted
        ? allEntries.filter(e => (e.symbol || '').toLowerCase().includes(wanted) || (e.ticker || '').toLowerCase().includes(wanted))
        : allEntries
    }
    // Always surface what's actually stored so we can see column contents
    const stored = allEntries.map(e => ({ symbol: e.symbol, ticker: e.ticker, contracts: e.contracts, premium: e.premium }))
    const out = []
    for (const entry of entries) {
      const polygonTicker = toPolygonTicker(entry.symbol)
      const parsed = parseOptionDescription(entry.symbol)
      const row = { symbol: entry.symbol, polygonTicker, undTicker: parsed?.ticker || null }
      if (!polygonTicker || !parsed) { row.error = 'could not parse / build polygon ticker'; out.push(row); continue }
      try {
        const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
        const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })
        const snap = resp.data?.results
        if (!snap) { row.error = 'no results'; row.rawStatus = resp.data?.status || null; out.push(row); continue }
        // The /v3/quotes call the Close Now column depends on. Reported raw so a
        // blank column can be attributed: no entitlement, no quote for this
        // contract, or a quote with only one side.
        const q = await fetchOptionQuote(polygonTicker, polygonKey)
        row.quote = { bid: q.bid, ask: q.ask, mid: q.mid }
        row.quoteUsable = q.bid > 0 && q.ask > 0
        row.spread = (q.bid > 0 && q.ask > 0) ? Math.round((q.ask - q.bid) * 100) / 100 : null
        row.markIsToday = marketMarkIsToday(snap)

        const lt = snap.last_trade || {}
        const rawTs = lt.sip_timestamp ?? lt.t ?? 0
        const ltMs = rawTs ? (rawTs > 1e15 ? rawTs / 1e6 : rawTs) : 0
        row.last_quote = snap.last_quote
          ? { bid: snap.last_quote.bid, ask: snap.last_quote.ask, midpoint: snap.last_quote.midpoint }
          : null
        row.last_trade = { price: lt.price ?? null, sip_timestamp: rawTs, date: ltMs ? new Date(ltMs).toISOString() : null }
        row.day = snap.day ? { close: snap.day.close, volume: snap.day.volume, previous_close: snap.day.previous_close ?? null } : null
        row.computedMark = optionMarkFromSnapshot(snap)
        row.serverToday = new Date().toISOString().slice(0, 10)
        // Probe the dedicated previous-close aggregate — a reliable option EOD prior close
        // even when the snapshot's day.previous_close is absent on the delayed plan.
        try {
          const purl = `https://api.polygon.io/v2/aggs/ticker/${polygonTicker}/prev`
          const presp = await axios.get(purl, { params: { apiKey: polygonKey, adjusted: true }, timeout: 6000 })
          row.prevAgg = presp.data?.results?.[0] ? { close: presp.data.results[0].c, date: presp.data.results[0].t } : { status: presp.data?.status, count: presp.data?.resultsCount }
        } catch (e) { row.prevAgg = { error: e.response?.status ? `HTTP ${e.response.status}` : e.message } }
      } catch (e) {
        row.error = e.response?.status ? `HTTP ${e.response.status}` : e.message
        row.errorBody = e.response?.data || null
      }
      // Directly probe the dedicated options QUOTES endpoint — this tells us whether
      // the key is entitled to option quotes (the real bid/ask mid) at all, even if
      // the snapshot doesn't surface last_quote.
      try {
        const qurl = `https://api.polygon.io/v3/quotes/${polygonTicker}`
        const qresp = await axios.get(qurl, { params: { apiKey: polygonKey, limit: 1, order: 'desc', sort: 'timestamp' }, timeout: 6000 })
        const q0 = qresp.data?.results?.[0]
        row.quotesProbe = {
          status: qresp.data?.status || null,
          count: qresp.data?.results?.length || 0,
          sample: q0 ? { bid: q0.bid_price, ask: q0.ask_price, mid: (q0.bid_price && q0.ask_price) ? (q0.bid_price + q0.ask_price) / 2 : null, t: q0.sip_timestamp } : null
        }
      } catch (e) {
        row.quotesProbe = { error: e.response?.status ? `HTTP ${e.response.status}` : e.message, body: e.response?.data || null }
      }
      out.push(row)
    }
    res.json({ count: out.length, totalEntries: allEntries.length, stored, entries: out })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Debug: per-entry breakdown of the YTD panel's open short-call P&L for a ticker,
// so we can see exactly which entries/prices sum to the "Open P&L" number.
// Usage: /api/debug-open-pnl?ticker=MRVL
app.get('/api/debug-open-pnl', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const polygonKey = process.env.POLYGON_API_KEY || ''
    const ticker = (req.query.ticker || '').toUpperCase()
    const shortEntries = databaseService.getShortCallEntries(userId)
    const openPositions = databaseService.getOpenOptionPositions(userId)
    const netShortBySymbol = {}
    openPositions.forEach(p => { netShortBySymbol[p.symbol] = p.net_short })
    const openShortSymbols = new Set(openPositions.filter(p => p.net_short > 0).map(p => p.symbol))
    let openEntries = shortEntries.filter(e => openShortSymbols.has(e.symbol))
    // Allocated before the ticker filter, so narrowing to one underlying can't
    // change the sizing — this endpoint exists to explain the real number.
    const openContractsByEntry = allocateOpenShortContracts(
      openEntries, openShortSymbols, netShortBySymbol)
    if (ticker) openEntries = openEntries.filter(e => (e.ticker || '').toUpperCase() === ticker)
    const rows = []
    let total = 0
    for (const entry of openEntries) {
      const polyTicker = toPolygonTicker(entry.symbol)
      const parsed = parseOptionDescription(entry.symbol)
      const entryContracts = entry.contracts || 1
      const alloc = openContractsByEntry[entry.id]
      const effContracts = alloc != null ? alloc : entryContracts
      const shares = effContracts * 100
      const premiumPerShare = entryContracts > 0 ? entry.premium / (entryContracts * 100) : entry.premium
      let price = null, source = null
      if (polyTicker && parsed && polygonKey) {
        const qMid = await fetchOptionQuoteMid(polyTicker, polygonKey)
        if (qMid > 0) { price = qMid; source = 'quote' }
        else {
          let underlying = 0, close = 0
          try {
            const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polyTicker}`
            const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 6000 })
            const snap = resp.data?.results
            if (snap) { underlying = snap.underlying_asset?.price || 0; close = staleOptionMark(snap) }
          } catch { /* ignore */ }
          if (!(underlying > 0)) {
            try { const f = await priceService.fetchPrices([parsed.ticker]); if (f[parsed.ticker] > 0) underlying = f[parsed.ticker] } catch { /* leave */ }
          }
          const model = modelOptionMark(entry, parsed, underlying)
          if (model > 0) { price = model; source = 'model' }
          else if (close > 0) { price = close; source = 'close' }
        }
      }
      const contribution = price != null ? (premiumPerShare - price) * shares : null
      if (contribution != null) total += contribution
      rows.push({
        symbol: entry.symbol,
        entryContracts: entry.contracts,
        actualOpenContracts: netShortBySymbol[entry.symbol] ?? null, // from trades (net STO-BTC)
        saleDate: String(entry.sale_date || '').slice(0, 10),
        premiumTotal: Math.round((entry.premium || 0) * 100) / 100,
        premiumPerShare: Math.round(premiumPerShare * 100) / 100,
        currentPrice: price != null ? Math.round(price * 100) / 100 : null,
        source,
        openPnL: contribution != null ? Math.round(contribution * 100) / 100 : null
      })
    }
    res.json({ ticker, openCount: rows.length, totalOpenPnL: Math.round(total * 100) / 100, rows })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Debug: show raw stock trades from DB so we can diagnose position query issues
app.get('/api/debug-stock-trades', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const rows = databaseService.getRawStockTrades(userId)
    res.json({ success: true, userId, rows })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Stock avg cost overrides — permanent per-user storage for manual cost basis corrections
app.get('/api/stock-cost-overrides', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const broker = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    res.json({ success: true, overrides: databaseService.getCostOverrides(userId, broker) })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.put('/api/stock-cost-overrides/:symbol', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const symbol = req.params.symbol.toUpperCase()
    const avgCost = parseFloat(req.body.avgCost)
    if (!avgCost || avgCost <= 0) return res.status(400).json({ success: false, error: 'Invalid avgCost' })
    // An override belongs to one broker's lot. Editing from the merged view has
    // no single target, so refuse rather than guess and corrupt a basis.
    const broker = req.body.broker || req.query.broker
    if (!broker || broker === 'all') {
      return res.status(400).json({
        success: false,
        error: 'Pick a broker tab before editing cost. An override applies to a single broker position.',
      })
    }
    databaseService.setCostOverride(userId, symbol, avgCost, broker)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.delete('/api/stock-cost-overrides/:symbol', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const broker = req.body?.broker || req.query.broker
    if (!broker || broker === 'all') {
      return res.status(400).json({
        success: false,
        error: 'Pick a broker tab before clearing cost. An override applies to a single broker position.',
      })
    }
    databaseService.deleteCostOverride(userId, req.params.symbol, broker)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Get fresh current prices for multiple symbols (bypasses cache)
app.get('/api/current-prices', requireAuth, async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    if (symbols.length === 0) return res.json({ success: true, prices: {} })

    // Force fresh fetch from Yahoo Finance bulk quote endpoint (bypasses 4-min cache)
    const prices = await priceService.fetchPrices(symbols)
    const previousClose = priceService.getPreviousClose(symbols)
    const nonZero = Object.values(prices).filter(p => p > 0).length
    console.log(`/api/current-prices: fetched ${nonZero}/${symbols.length} prices`)
    res.json({ success: true, prices, previousClose })
  } catch (error) {
    console.error('Error in /api/current-prices:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get technical indicators + intraday data for a symbol
app.get('/api/stock-indicators/:symbol', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.params.toUpperCase ? req : { symbol: req.params.symbol.toUpperCase() }
    const sym = req.params.symbol.toUpperCase()

    const [hist, intraday] = await Promise.all([
      priceService.fetchHistoricalPrices(sym, '3mo', '1d'),
      priceService.fetchIntradayData(sym)
    ])

    const closes = hist.map(d => d.close).filter(Boolean)
    const dailyHighs = hist.map(d => d.high).filter(Boolean)
    const dailyLows = hist.map(d => d.low).filter(Boolean)
    const rsi = closes.length >= 15 ? Math.round(calculateRSI(closes) * 10) / 10 : null
    const ema9 = closes.length >= 9 ? Math.round(calculateEMA(closes, 9) * 100) / 100 : null
    const ema21 = closes.length >= 21 ? Math.round(calculateEMA(closes, 21) * 100) / 100 : null
    const stoch = calculateStochastic(dailyHighs, dailyLows, closes)
    const currentPrice = closes[closes.length - 1] || null

    const highs = intraday.map(b => b.high).filter(Boolean)
    const lows = intraday.map(b => b.low).filter(Boolean)
    const dayHigh = highs.length ? Math.max(...highs) : null
    const dayLow = lows.length ? Math.min(...lows) : null
    const currentVwap = intraday.length ? intraday[intraday.length - 1].vwap : null

    res.json({ success: true, symbol: sym, rsi, ema9, ema21, stoch, currentPrice, intraday, dayHigh, dayLow, currentVwap })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Net volume: aggregated OHLCV candles with buy/sell pressure proxy
// Uses sign(close - open) × volume as a per-candle net-volume approximation.
app.get('/api/net-volume/:symbol', requireAuth, async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase()
    const tfHours = Math.max(1, Math.min(24, parseInt(req.query.tf) || 4))
    const candleCount = Math.max(3, Math.min(50, parseInt(req.query.candles) || 12))

    // Daily TF uses daily bars; sub-day TF uses 1H bars then aggregates
    const interval = tfHours >= 24 ? '1d' : '1h'
    // Each trading day yields ~6.5h / tfHours blocks. Fetch 2× needed days as buffer.
    const blocksPerDay = tfHours >= 24 ? 1 : Math.max(1, 6.5 / tfHours)
    const daysNeeded = Math.ceil((candleCount / blocksPerDay) * 2) + 5
    const range = tfHours >= 24
      ? `${Math.min(daysNeeded * 2, 200)}d`
      : `${Math.min(daysNeeded, 59)}d`   // Yahoo Finance caps hourly at 60d

    const bars = await priceService.fetchHistoricalPrices(sym, range, interval)
    if (!bars || bars.length === 0) {
      return res.json({ success: true, candles: [], symbol: sym, tfHours, candleCount, totalNetVolume: 0 })
    }

    // Aggregate 1H bars into tfHours-size blocks keyed by floor(ts / blockMs)
    const blockMs = tfHours * 3600 * 1000
    const blockMap = new Map()
    const blockOrder = []

    bars.forEach(bar => {
      if (bar.close == null) return
      const key = Math.floor(bar.timestamp / blockMs)
      if (!blockMap.has(key)) {
        blockMap.set(key, {
          time: bar.timestamp,
          open: bar.open ?? bar.close,
          high: bar.high ?? bar.close,
          low: bar.low ?? bar.close,
          close: bar.close,
          volume: bar.volume || 0
        })
        blockOrder.push(key)
      } else {
        const b = blockMap.get(key)
        if (bar.high != null) b.high = Math.max(b.high, bar.high)
        if (bar.low != null) b.low = Math.min(b.low, bar.low)
        b.close = bar.close
        b.volume += bar.volume || 0
      }
    })

    const candles = blockOrder.map(key => {
      const b = blockMap.get(key)
      const dir = b.close > b.open ? 1 : b.close < b.open ? -1 : 0
      const netVolume = dir * b.volume
      const dt = new Date(b.time)
      const label = tfHours >= 24
        ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
        : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) + ' ' +
          dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' })
      return { ...b, netVolume, label }
    })

    const result = candles.slice(-candleCount)
    const totalNetVolume = result.reduce((s, c) => s + c.netVolume, 0)

    res.json({ success: true, symbol: sym, tfHours, candleCount, candles: result, totalNetVolume })
  } catch (error) {
    console.error('net-volume error:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Pre-move volume analysis: detect significant moves and characterize volume in the preceding N bars
app.get('/api/pre-move-volume/:symbol', requireAuth, async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase()
    const tf = req.query.tf || '1d'              // '4h' | '1d'
    const period = req.query.period || '1y'      // '1y' | '2y' | '5y'
    const singleThreshold = Math.abs(parseFloat(req.query.single) || 3)
    const multiThreshold = Math.abs(parseFloat(req.query.multi) || 5)
    const lookAhead = Math.min(20, Math.max(1, parseInt(req.query.ahead) || 5))
    const lookBack = Math.min(20, Math.max(3, parseInt(req.query.back) || 10))
    const volMultiple = parseFloat(req.query.volX) || 1.5
    const direction = req.query.dir || 'both'    // 'both' | 'up' | 'down'
    const singleOn = req.query.single_on !== 'false'
    const multiOn = req.query.multi_on !== 'false'

    let rawBars
    if (tf === '4h') {
      const range = period === '2y' ? '730d' : '365d'
      const hourBars = await priceService.fetchHistoricalPrices(sym, range, '1h')
      const blockMs = 4 * 3600 * 1000
      const blockMap = new Map()
      const blockOrder = []
      ;(hourBars || []).forEach(bar => {
        if (bar.close == null) return
        const key = Math.floor(bar.timestamp / blockMs)
        if (!blockMap.has(key)) {
          blockMap.set(key, { timestamp: key * blockMs, open: bar.open ?? bar.close, high: bar.high ?? bar.close, low: bar.low ?? bar.close, close: bar.close, volume: bar.volume || 0 })
          blockOrder.push(key)
        } else {
          const b = blockMap.get(key)
          if (bar.high != null) b.high = Math.max(b.high, bar.high)
          if (bar.low != null) b.low = Math.min(b.low, bar.low)
          b.close = bar.close
          b.volume += bar.volume || 0
        }
      })
      rawBars = blockOrder.map(k => blockMap.get(k))
    } else {
      const rangeMap = { '1y': '1y', '2y': '2y', '5y': '5y' }
      rawBars = await priceService.fetchHistoricalPrices(sym, rangeMap[period] || '1y', '1d')
    }

    if (!rawBars || rawBars.length < lookBack + lookAhead + 10) {
      return res.json({ success: false, error: 'Insufficient data for the requested period' })
    }

    // Rolling 20-bar average volume centered before each bar
    const rollingAvgVol = (i) => {
      const start = Math.max(0, i - 20)
      const slice = rawBars.slice(start, i)
      if (slice.length === 0) return rawBars[i].volume || 1
      return slice.reduce((s, b) => s + (b.volume || 0), 0) / slice.length
    }

    // Pre-compute moving average arrays (each entry is the MA ending at that bar index)
    const buildMA = (period) => {
      const out = new Array(rawBars.length).fill(null)
      let sum = 0
      for (let k = 0; k < rawBars.length; k++) {
        sum += rawBars[k].close || 0
        if (k >= period) sum -= rawBars[k - period].close || 0
        if (k >= period - 1) out[k] = sum / period
      }
      return out
    }
    const ma20 = buildMA(20)
    const ma50 = buildMA(50)
    const ma200 = buildMA(200)

    const getTrend = (i) => {
      const p = rawBars[i].close
      const m50 = ma50[i]
      const m200 = ma200[i]
      if (!m50) return { trend: 'unknown', ma50: null, ma200: null, ma50Slope: null }

      // 10-bar slope of MA50 (percentage)
      const m50_prev = i >= 10 ? ma50[i - 10] : null
      const slope = m50_prev ? parseFloat(((m50 - m50_prev) / m50_prev * 100).toFixed(3)) : null

      let trend
      if (m200) {
        if (p > m50 && m50 > m200 && slope > 0)       trend = 'uptrend'
        else if (p < m50 && m50 < m200 && slope < 0)  trend = 'downtrend'
        else if (p > m50 && m50 > m200)                trend = 'up_mixed'
        else if (p < m50 && m50 < m200)                trend = 'down_mixed'
        else                                            trend = 'neutral'
      } else {
        // Not enough data for MA200 (less than 200 bars in history)
        if (p > m50 && slope > 0)       trend = 'uptrend'
        else if (p < m50 && slope < 0)  trend = 'downtrend'
        else                            trend = 'neutral'
      }

      return {
        trend,
        ma50: parseFloat(m50.toFixed(2)),
        ma200: m200 ? parseFloat(m200.toFixed(2)) : null,
        ma50Slope: slope,
      }
    }

    const events = []
    const blockedUntil = new Set()

    for (let i = lookBack; i < rawBars.length - lookAhead; i++) {
      if (blockedUntil.has(i)) continue
      const bar = rawBars[i]
      if (!bar.open || !bar.close) continue
      const barPct = (bar.close - bar.open) / bar.open * 100
      const triggers = []

      if (singleOn && Math.abs(barPct) >= singleThreshold) {
        const dir = barPct < 0 ? 'down' : 'up'
        if (direction === 'both' || direction === dir) {
          triggers.push({ type: 'single', dir, pct: parseFloat(barPct.toFixed(2)) })
        }
      }

      if (multiOn) {
        let maxDown = 0, maxUp = 0
        for (let j = i + 1; j <= i + lookAhead; j++) {
          if (!rawBars[j]?.close) continue
          const pct = (rawBars[j].close - bar.close) / bar.close * 100
          if (pct < maxDown) maxDown = pct
          if (pct > maxUp) maxUp = pct
        }
        if ((direction === 'both' || direction === 'down') && Math.abs(maxDown) >= multiThreshold) {
          triggers.push({ type: 'multi', dir: 'down', pct: parseFloat(maxDown.toFixed(2)) })
        }
        if ((direction === 'both' || direction === 'up') && maxUp >= multiThreshold) {
          triggers.push({ type: 'multi', dir: 'up', pct: parseFloat(maxUp.toFixed(2)) })
        }
      }

      if (triggers.length === 0) continue

      // Block nearby indices to avoid overlapping events from the same move
      for (let j = i + 1; j <= i + Math.ceil(lookAhead / 2); j++) blockedUntil.add(j)

      const avgVol = rollingAvgVol(i)
      const preBars = rawBars.slice(i - lookBack, i).map(b => {
        const vm = avgVol > 0 ? (b.volume || 0) / avgVol : 1
        const bearish = b.close < b.open
        return {
          date: new Date(b.timestamp).toISOString().split('T')[0],
          open: parseFloat((b.open || 0).toFixed(2)),
          close: parseFloat((b.close || 0).toFixed(2)),
          volume: b.volume || 0,
          volMultiple: parseFloat(vm.toFixed(2)),
          pct: parseFloat(((b.close - b.open) / (b.open || 1) * 100).toFixed(2)),
          isLargeSell: bearish && vm >= volMultiple,
          isLargeBuy: !bearish && vm >= volMultiple,
        }
      })

      const trendData = getTrend(i)

      events.push({
        date: new Date(bar.timestamp).toISOString().split('T')[0],
        timestamp: bar.timestamp,
        open: parseFloat((bar.open || 0).toFixed(2)),
        close: parseFloat((bar.close || 0).toFixed(2)),
        triggers,
        preBars,
        largeSellCount: preBars.filter(b => b.isLargeSell).length,
        largeBuyCount: preBars.filter(b => b.isLargeBuy).length,
        avgPreVol: parseFloat((preBars.reduce((s, b) => s + b.volMultiple, 0) / preBars.length).toFixed(2)),
        ...trendData,
      })
    }

    events.sort((a, b) => b.timestamp - a.timestamp)

    res.json({
      success: true, symbol: sym, tf, period,
      eventCount: events.length,
      events: events.slice(0, 200),
    })
  } catch (err) {
    console.error('pre-move-volume error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// DCA schedule endpoints
app.get('/api/dca-schedule', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const schedule = databaseService.getDCASchedule(userId)
    const positions = databaseService.getAllPositions(userId)
    const stockOnlySymbols = databaseService.getStockOnlySymbols(userId)
    const today = new Date().toISOString().split('T')[0]
    const result = schedule.map(s => ({
      id: s.id,
      symbol: s.symbol,
      nextAlertDate: s.next_alert_date,
      sharesHeld: Math.round((positions[s.symbol] || 0) * 100) / 100,
      isDue: s.next_alert_date <= today,
      daysUntil: Math.round((new Date(s.next_alert_date) - new Date(today)) / 86400000),
    }))
    res.json({ success: true, schedule: result, suggestions: stockOnlySymbols })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/dca-schedule', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId
    const { symbol } = req.body
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' })
    const nextDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
    databaseService.addDCASymbol(userId, symbol.toUpperCase().trim(), nextDate)
    res.json({ success: true, nextAlertDate: nextDate })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.put('/api/dca-schedule/:id/bought', requireAuth, (req, res) => {
  try {
    const nextDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
    databaseService.markDCABought(req.params.id, nextDate)
    res.json({ success: true, nextAlertDate: nextDate })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.delete('/api/dca-schedule/:id', requireAuth, (req, res) => {
  try {
    databaseService.removeDCASymbol(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// Market-wide sentiment: VIX + CBOE SKEW (replaces ^PCCE which Yahoo retired)
app.get('/api/market-pulse', requireAuth, async (req, res) => {
  const YF_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  }
  const fetchIndex = async (sym) => {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`
      const r = await axios.get(url, { timeout: 8000, headers: YF_HEADERS })
      const meta = r.data?.chart?.result?.[0]?.meta
      if (!meta) return null
      const price = meta.regularMarketPrice
      const prev  = meta.chartPreviousClose
      const changePct = prev ? Math.round((price - prev) / prev * 10000) / 100 : 0
      return { price: Math.round(price * 100) / 100, changePct, prevClose: Math.round(prev * 100) / 100 }
    } catch { return null }
  }

  try {
    const [vix, skew] = await Promise.all([fetchIndex('^VIX'), fetchIndex('^SKEW')])
    // Keep pcr key for frontend compatibility, but now carries SKEW data
    const pcr = skew ? { ratio: skew.price, changePct: skew.changePct, prevClose: skew.prevClose } : null
    res.json({ success: true, vix, pcr, skewMode: true })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get support/resistance levels for a symbol
app.get('/api/support-resistance/:symbol', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.params
    const { hoursBack } = req.query

    // Get from database
    const dbLevels = databaseService.getSupportResistanceLevels(symbol, hoursBack ? parseInt(hoursBack) : 24)

    res.json({
      success: true,
      symbol,
      levels: dbLevels,
      source: 'database'
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get all active support/resistance levels
app.get('/api/support-resistance', requireAuth, (req, res) => {
  try {
    const levels = databaseService.getAllActiveLevels()
    res.json({
      success: true,
      levels,
      count: levels.length
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Check for EMA crossovers across symbols
app.post('/api/ema-crossovers', requireAuth, async (req, res) => {
  try {
    const { symbols } = req.body

    if (!symbols || !Array.isArray(symbols)) {
      return res.status(400).json({ success: false, error: 'symbols array required' })
    }

    const alerts = await emaAlertService.checkEMACrossovers(symbols)

    res.json({
      success: true,
      alerts,
      count: alerts.length
    })
  } catch (error) {
    console.error('Error checking EMA crossovers:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get support/resistance configuration
app.get('/api/level2/config', requireAuth, (req, res) => {
  try {
    res.json({
      success: true,
      config: supportResistanceService.config
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Update support/resistance configuration
app.post('/api/level2/config', requireAuth, (req, res) => {
  try {
    const { config } = req.body
    supportResistanceService.updateConfig(config)
    res.json({
      success: true,
      config: supportResistanceService.config
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Signal accuracy endpoints
app.get('/api/signal-accuracy', (req, res) => {
  try {
    const { symbol, hours } = req.query
    const timeRange = hours ? parseInt(hours) : 168 // Default 7 days
    const accuracy = databaseService.getSignalAccuracy(symbol, timeRange)
    res.json({ success: true, data: accuracy })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.get('/api/signals/:symbol', (req, res) => {
  try {
    const { symbol } = req.params
    const { limit } = req.query
    const signals = databaseService.getRecentSignals(symbol, limit ? parseInt(limit) : 50)
    res.json({ success: true, data: signals })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.get('/api/prices/:symbol', (req, res) => {
  try {
    const { symbol } = req.params
    const { limit } = req.query
    const prices = databaseService.getRecentPrices(symbol, limit ? parseInt(limit) : 288)
    res.json({ success: true, data: prices })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Delete snapshot for a specific date
app.delete('/api/snapshot/:date', requireAuth, (req, res) => {
  try {
    const { date } = req.params
    const deletedCount = databaseService.deletePnLSnapshot(date, req.user.userId)
    res.json({ success: true, deletedCount, message: `Deleted ${deletedCount} records for ${date}` })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.get('/prices', async (req, res) => {
  const { symbols } = req.query
  const symbolArray = symbols ? symbols.split(',') : []

  if (symbolArray.length === 0) {
    return res.json(priceService.getCurrentPrices())
  }

  const prices = await priceService.getPrices(symbolArray)
  res.json(prices)
})

// Robinhood automated download endpoint
app.post('/api/robinhood/download', requireAuth, async (req, res) => {
  try {
    console.log(`🤖 Received request to download from Robinhood (user: ${req.user.userId})`)

    // Check if downloader is available (only works locally, not on Railway)
    if (!downloadRobinhoodReport) {
      return res.status(503).json({
        success: false,
        error: 'Robinhood download is only available when running locally. Please use the CSV upload feature instead.'
      })
    }

    // Start the download process
    const result = await downloadRobinhoodReport()

    if (result.success) {
      // Read the downloaded file
      const csvContent = fs.readFileSync(result.filePath, 'utf-8')

      // Parse trades, dividends/interest, and deposits
      const { trades, dividendsAndInterest } = await parseTrades(csvContent)
      const { deposits, totalPrincipal } = await parseDeposits(csvContent)

      // Store in database
      const uploadDate = new Date().toISOString().split('T')[0]
      const latestTradeDate = trades.length > 0
        ? trades.reduce((latest, t) => t.transDate > latest ? t.transDate : latest, trades[0].transDate)
        : uploadDate

      databaseService.storeTrades(uploadDate, trades)
      databaseService.storeDeposits(uploadDate, deposits)
      databaseService.upsertCsvUpload(uploadDate, latestTradeDate, trades.length, totalPrincipal)

      console.log(`✅ Imported ${trades.length} trades from Robinhood download`)

      // Clean up downloaded file
      fs.unlinkSync(result.filePath)

      res.json({
        success: true,
        message: 'Successfully downloaded and imported from Robinhood',
        trades: trades.length,
        uploadDate: uploadDate,
        manualDownload: result.manualDownload || false
      })
    } else {
      throw new Error('Download failed')
    }
  } catch (error) {
    console.error('❌ Error downloading from Robinhood:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// GET /api/options-pnl/history — weekly and date-range options P&L
app.get('/api/options-pnl/history', requireAuth, async (req, res) => {
  try {
    const brokerFilter = req.query.broker && req.query.broker !== 'all' ? req.query.broker : null
    const trades = databaseService.getOptionTrades(req.user.userId, brokerFilter)

    // Cash-flow P&L per trade:
    //   sell (STO/STC/OEXP) = +amount (premium received or position closed)
    //   buy  (BTO/BTC)      = -amount (premium paid)
    const getWeekStart = (dateStr) => {
      const d = new Date(dateStr + 'T12:00:00')
      const dow = d.getDay()
      const mon = new Date(d)
      mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
      return mon.toISOString().slice(0, 10)
    }

    const now = new Date()
    const todayDefault = now.toISOString().slice(0, 10)
    // asOf lets the caller view any past week as if it were "this week"
    const asOf = req.query.asOf && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : todayDefault
    const mondayStr = getWeekStart(asOf)
    const fridayStr = (() => { const d = new Date(mondayStr + 'T12:00:00'); d.setDate(d.getDate() + 4); return d.toISOString().slice(0, 10) })()

    // Global LIFO pass: compute realized P&L per closing trade across all time
    // Writes _realizedPnl directly onto each trade object so contractGroups pass can read it
    const lifoStacks = {} // symbol → { long: [], short: [] }
    const isOpening = tc => ['BTO', 'STO'].includes((tc || '').toUpperCase())
    const sortedTrades = [...trades].sort((a, b) =>
      a.trans_date.localeCompare(b.trans_date) ||
      ((a.id || 0) - (b.id || 0)) ||
      (isOpening(a.trans_code) ? 0 : 1) - (isOpening(b.trans_code) ? 0 : 1)  // openings before closings on same date
    )
    sortedTrades.forEach(t => {
      const tc = (t.trans_code || '').toUpperCase()
      // Normalize symbol to handle month/day padding differences (e.g. "3/27" vs "03/27")
      const _p = parseOptionDescription(t.symbol || '')
      const sym = _p
        ? `${_p.ticker}|${_p.year}${_p.month}${_p.day}|${_p.type}|${_p.strike}`
        : (t.symbol || '')
      const contracts = Math.abs(t.contracts || 1)
      const amount = Math.abs(t.amount)
      const pricePerContract = contracts > 0 ? amount / contracts : amount
      if (!lifoStacks[sym]) lifoStacks[sym] = { long: [], short: [] }
      const stacks = lifoStacks[sym]

      if (tc === 'BTO') {
        stacks.long.push({ pricePerContract, remainingContracts: contracts, date: t.trans_date })
      } else if (tc === 'STO') {
        stacks.short.push({ pricePerContract, remainingContracts: contracts, date: t.trans_date })
      } else if (['STC', 'BTC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)) {
        // BTC closes a short (STO'd) position; STC/OEXC closes a long (BTO'd) position.
        // OEXP/OASGN can close either: check which stack holds the contract.
        // Covered calls and short puts (STO) live in stacks.short; long options (BTO) in stacks.long.
        let closingShort
        let stack
        if (tc === 'BTC') {
          stack = stacks.short; closingShort = true
        } else if (tc === 'STC' || tc === 'OEXC') {
          stack = stacks.long; closingShort = false
        } else {
          // OEXP / OASGN: the expiring/assigned side is whichever stack has the open position
          closingShort = stacks.short.length > 0
          stack = closingShort ? stacks.short : stacks.long
        }
        let contractsLeft = contracts
        let costBasis = 0
        const matchedLegs = []
        while (contractsLeft > 0 && stack.length > 0) {
          const top = stack[stack.length - 1]
          const matched = Math.min(contractsLeft, top.remainingContracts)
          costBasis += matched * top.pricePerContract
          matchedLegs.push({ contracts: matched, pricePerContract: Math.round(top.pricePerContract * 100) / 100, date: top.date })
          contractsLeft -= matched
          top.remainingContracts -= matched
          if (top.remainingContracts === 0) stack.pop()
        }
        // If contractsLeft > 0, we couldn't find the opening trade — skip P&L for this leg
        if (contractsLeft === 0) {
          const proceeds = ['OEXP', 'OASGN'].includes(tc) ? 0 : amount
          // Short positions: profit = opening credit (costBasis) − closing cost (proceeds)
          // Long positions: profit = closing proceeds − opening cost (costBasis)
          t._realizedPnl = Math.round((closingShort ? costBasis - proceeds : proceeds - costBasis) * 100) / 100
          t._realizedPnlDetail = { costBasis: Math.round(costBasis * 100) / 100, proceeds: Math.round(proceeds * 100) / 100, matchedLegs }
        }
      }
    })

    // First pass: group by contract (full description = unique contract identifier).
    // "Realized" = net flow for contracts that have a closing trade (both legs counted).
    // "Open" = net flow for contracts with only opening trades (premium still at risk).
    const contractGroups = {}
    trades.forEach(t => {
      const cashFlow = t.is_buy ? -t.amount : t.amount
      const parsed = parseOptionDescription(t.symbol || '')
      const underlying = parsed?.ticker || (t.symbol || '').split(' ')[0].toUpperCase()
      // Skip trades where the symbol doesn't look like a real ticker (e.g. "Option Exercise")
      if (!underlying || underlying.length > 6 || !/^[A-Z]+$/.test(underlying)) return
      const tc = (t.trans_code || '').toUpperCase()
      const isClosing = ['STC', 'BTC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)
      const expiryDateStr = parsed ? `${parsed.year}-${parsed.month}-${parsed.day}` : t.trans_date
      const weekKey = getWeekStart(expiryDateStr)

      const optionType = parsed?.type || null // 'call' or 'put'
      const contractKey = (t.symbol || '') + '|' + weekKey
      if (!contractGroups[contractKey]) {
        contractGroups[contractKey] = { underlying, weekKey, netFlow: 0, hasClosing: false, tradeDetails: [], optionType }
      }
      const cg = contractGroups[contractKey]
      cg.netFlow += cashFlow
      if (isClosing) cg.hasClosing = true
      cg.tradeDetails.push({
        date: t.trans_date, description: t.symbol,
        transCode: t.trans_code, cashFlow: Math.round(cashFlow * 100) / 100, isClosing,
        realizedPnl: isClosing ? (t._realizedPnl ?? null) : null,
        realizedPnlDetail: isClosing ? (t._realizedPnlDetail ?? null) : null
      })
    })

    // Second pass: roll contracts into byWeek buckets
    const byWeek = {}
    Object.values(contractGroups).forEach(({ underlying, weekKey, netFlow, hasClosing, tradeDetails, optionType }) => {
      if (!byWeek[weekKey]) {
        byWeek[weekKey] = { weekStart: weekKey, totalDelta: 0, realizedDelta: 0, tradeCount: 0, byUnderlying: {}, realizedByUnderlying: {}, realizedCallsByUnderlying: {}, realizedPutsByUnderlying: {}, tradesByUnderlying: {} }
      }
      const wk = byWeek[weekKey]
      wk.totalDelta += netFlow
      wk.tradeCount += tradeDetails.length

      if (!wk.byUnderlying[underlying]) {
        wk.byUnderlying[underlying] = 0
        wk.realizedByUnderlying[underlying] = 0
        wk.tradesByUnderlying[underlying] = []
      }
      wk.byUnderlying[underlying] += netFlow
      // Use LIFO-matched realizedPnl per closing trade (matches what the expanded trade rows show)
      // Falls back to netFlow only for closing trades with no LIFO match
      if (hasClosing) {
        const lifoSum = tradeDetails
          .filter(t => t.isClosing && t.realizedPnl != null)
          .reduce((s, t) => s + t.realizedPnl, 0)
        const unmatchedNetFlow = tradeDetails
          .filter(t => t.isClosing && t.realizedPnl == null)
          .reduce((s, t) => s + t.cashFlow, 0)
        const realizedAmount = lifoSum + unmatchedNetFlow
        wk.realizedByUnderlying[underlying] += realizedAmount
        wk.realizedDelta += realizedAmount
        if (optionType === 'call') wk.realizedCallsByUnderlying[underlying] = (wk.realizedCallsByUnderlying[underlying] || 0) + realizedAmount
        else if (optionType === 'put') wk.realizedPutsByUnderlying[underlying] = (wk.realizedPutsByUnderlying[underlying] || 0) + realizedAmount
      }
      wk.tradesByUnderlying[underlying].push(...tradeDetails)
      if (underlying === 'TQQQ') console.log(`[TQQQ opt] week=${weekKey} type=${optionType} netFlow=${Math.round(netFlow*100)/100} hasClosing=${hasClosing} byUnderlying=${Math.round(wk.byUnderlying['TQQQ']*100)/100} realizedByUnderlying=${Math.round(wk.realizedByUnderlying['TQQQ']*100)/100}`, tradeDetails.map(t => `${t.transCode} flow=${t.cashFlow} realized=${t.realizedPnl}`))
    })

    const weeks = Object.values(byWeek)
      .map(w => ({
        weekStart: w.weekStart,
        totalDelta: Math.round(w.totalDelta * 100) / 100,
        realizedDelta: Math.round(w.realizedDelta * 100) / 100,
        tradeCount: w.tradeCount,
        byUnderlying: Object.fromEntries(
          Object.entries(w.byUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        ),
        realizedByUnderlying: Object.fromEntries(
          Object.entries(w.realizedByUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100])
        ),
        realizedCallsByUnderlying: Object.fromEntries(
          Object.entries(w.realizedCallsByUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100])
        ),
        realizedPutsByUnderlying: Object.fromEntries(
          Object.entries(w.realizedPutsByUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100])
        ),
        tradesByUnderlying: w.tradesByUnderlying
      }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))

    // Ensure the current week is always in the weeks array so multi-week tabs (2W, NW, etc.)
    // anchor the cumulative stock fromPrice correctly even when there's no options activity yet.
    if (!weeks.find(w => w.weekStart === mondayStr)) {
      weeks.push({
        weekStart: mondayStr,
        totalDelta: 0, realizedDelta: 0, tradeCount: 0,
        byUnderlying: {}, realizedByUnderlying: {}, realizedCallsByUnderlying: {},
        realizedPutsByUnderlying: {}, tradesByUnderlying: {}
      })
      weeks.sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    }

    // Hero card: current expiry week only
    const cw = byWeek[mondayStr] || { totalDelta: 0, realizedDelta: 0, byUnderlying: {}, realizedByUnderlying: {}, realizedCallsByUnderlying: {}, realizedPutsByUnderlying: {}, tradesByUnderlying: {} }
    const currentWeekPnL = Math.round(cw.totalDelta * 100) / 100
    const currentWeekRealizedTotal = Math.round(cw.realizedDelta * 100) / 100
    const currentWeekByUnderlying = Object.fromEntries(
      Object.entries(cw.byUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    )
    const currentWeekRealizedByUnderlying = Object.fromEntries(
      Object.entries(cw.realizedByUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100])
    )
    const currentWeekRealizedCallsByUnderlying = Object.fromEntries(
      Object.entries(cw.realizedCallsByUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100])
    )
    const currentWeekRealizedPutsByUnderlying = Object.fromEntries(
      Object.entries(cw.realizedPutsByUnderlying).map(([k, v]) => [k, Math.round(v * 100) / 100])
    )
    const currentWeekTradesByUnderlying = cw.tradesByUnderlying

    // Fetch weekly stock P&L: (currentPrice - lastFridayClose) × position
    const thisWeekSymbols = Object.keys(currentWeekByUnderlying)
    const lastFridayStr = (() => {
      const d = new Date(mondayStr + 'T12:00:00')
      d.setDate(d.getDate() - 3)
      return d.toISOString().slice(0, 10)
    })()
    const todayStr = asOf

    let weeklyStockPnL = {}
    let otherStockPnL = 0
    let otherStockPnLBySymbol = {}

    // All positions — used for both options-linked and other stocks
    // Broker-scoped like the option side. Without this the stock half of
     // Cumulative P&L showed every broker regardless of the selected tab.
     const allPositions = databaseService.getAllPositions(req.user.userId, brokerFilter)
    const otherSymbols = Object.keys(allPositions).filter(s => !thisWeekSymbols.includes(s))
    // Also include option-only underlyings (user holds options but not the stock)
    const allOptionTrades = databaseService.getOptionTrades(req.user.userId, brokerFilter)
    const optionOnlyTickers = [...new Set(allOptionTrades.map(t => parseOptionDescription(t.symbol)?.ticker).filter(Boolean))]
      .filter(t => !allPositions[t])
    const allSymbols = [...new Set([...thisWeekSymbols, ...otherSymbols, ...optionOnlyTickers])]

    const optionUnderlyingPrices = {}
    if (allSymbols.length > 0) {
      const [lastFridayPrices, currentPrices] = await Promise.all([
        priceService.getPricesForDate(allSymbols, lastFridayStr),
        priceService.getPricesForDate(allSymbols, todayStr)
      ])
      optionOnlyTickers.forEach(sym => {
        if (currentPrices[sym] > 0) optionUnderlyingPrices[sym] = currentPrices[sym]
      })

      const thisWeekSells = databaseService.getThisWeekStockSells(req.user.userId, mondayStr, thisWeekSymbols, brokerFilter)
      const thisWeekBuys = databaseService.getStockBuysInPeriod(req.user.userId, lastFridayStr, todayStr, thisWeekSymbols, brokerFilter)
      // Must be scoped to match allPositions above. Comparing a broker-scoped
      // position today against an unscoped one last Friday produced nonsense
      // deltas — that's what turned Other Stocks from +1800 into -368.
      const lastFriPositions = databaseService.getPositionsAsOf(req.user.userId, lastFridayStr, brokerFilter)
      const tqqqAllPos = allPositions['TQQQ'], tqqqLastFriPos = lastFriPositions['TQQQ']
      console.log(`[TQQQ stock] allPositions=${tqqqAllPos} lastFriPos=${tqqqLastFriPos} lastFri=${lastFridayStr} lastFriPrice=${lastFridayPrices['TQQQ']} curPrice=${currentPrices['TQQQ']} buys=${JSON.stringify(thisWeekBuys['TQQQ'])} sells=${JSON.stringify(thisWeekSells['TQQQ'])}`)
      thisWeekSymbols.forEach(sym => {
        const pos = allPositions[sym]
        const lastClose = lastFridayPrices[sym]
        const curPrice = currentPrices[sym]
        if (pos && curPrice) {
          const hadSharesLastFriday = (lastFriPositions[sym] || 0) > 0
          const buys = thisWeekBuys[sym]
          if (!hadSharesLastFriday && buys && buys.netChange >= 100) {
            // Position started this week — use avg buy price as baseline, not last Friday close
            weeklyStockPnL[sym] = { pnl: Math.round((curPrice - buys.avgPrice) * pos * 100) / 100, fromPrice: buys.avgPrice, toPrice: curPrice, fromDate: mondayStr, toDate: todayStr, shares: pos }
          } else if (lastClose) {
            weeklyStockPnL[sym] = { pnl: Math.round((curPrice - lastClose) * pos * 100) / 100, fromPrice: lastClose, toPrice: curPrice, fromDate: lastFridayStr, toDate: todayStr, shares: pos }
          }
        } else if (!pos && thisWeekSells[sym] && lastClose) {
          // Position closed this week — use actual sale price vs last Friday close
          const { sharesSold, avgPrice } = thisWeekSells[sym]
          if (sharesSold > 0) {
            weeklyStockPnL[sym] = { pnl: Math.round((avgPrice - lastClose) * sharesSold * 100) / 100, fromPrice: lastClose, toPrice: avgPrice, fromDate: lastFridayStr, toDate: todayStr, shares: sharesSold }
          }
        }
      })

      otherSymbols.forEach(sym => {
        const pos = allPositions[sym]
        const lastClose = lastFridayPrices[sym]
        const curPrice = currentPrices[sym]
        if (pos && lastClose && curPrice) {
          const pnl = Math.round((curPrice - lastClose) * pos * 100) / 100
          otherStockPnLBySymbol[sym] = { pnl, fromPrice: lastClose, toPrice: curPrice, fromDate: lastFridayStr, toDate: todayStr, shares: pos }
          otherStockPnL += pnl
        }
      })
      otherStockPnL = Math.round(otherStockPnL * 100) / 100
    }

    // Weekly stock deltas for option-underlying tickers — include all, even closed positions,
    // so historical weeks show correct stock P&L while the shares were held
    const stockHoldingOptionTickers = [...new Set(
      Object.values(byWeek).flatMap(w => Object.keys(w.byUnderlying))
    )]

    const allHistoryTickers = [...new Set([...stockHoldingOptionTickers, ...otherSymbols])]
    if (allHistoryTickers.length > 0) {
      // Fetch 2 years of daily history per ticker — one call each, cached in DB
      const tickerDateMap = {}
      await Promise.all(allHistoryTickers.map(async ticker => {
        try {
          const hist = await priceService.fetchHistoricalPrices(ticker, '2y', '1d')
          const m = {}
          hist.forEach(item => { m[item.date.slice(0, 10)] = item.close })
          tickerDateMap[ticker] = m
        } catch (e) { console.warn(`Weekly stock history failed for ${ticker}:`, e.message) }
      }))

      const findClose = (dateMap, targetStr) => {
        if (!dateMap) return 0
        if (dateMap[targetStr]) return dateMap[targetStr]
        // Find closest trading day within ±3 days
        const target = new Date(targetStr).getTime()
        let best = 0, bestDiff = Infinity
        Object.entries(dateMap).forEach(([d, c]) => {
          const diff = Math.abs(new Date(d).getTime() - target)
          if (diff < bestDiff && diff <= 3 * 86400000) { bestDiff = diff; best = c }
        })
        return best
      }

      weeks.forEach(week => {
        const monday = new Date(week.weekStart + 'T12:00:00')
        const prevFriStr = new Date(monday.getTime() - 3 * 86400000).toISOString().slice(0, 10)
        const thisFriStr = new Date(monday.getTime() + 4 * 86400000).toISOString().slice(0, 10)
        const prevPrevFriStr = new Date(monday.getTime() - 10 * 86400000).toISOString().slice(0, 10)

        const weekPositions = databaseService.getPositionsAsOf(req.user.userId, prevFriStr, brokerFilter)
        const weekComplete = thisFriStr <= todayStr

        // Check stock for ALL tickers ever seen, not just those with options expiring this week.
        // Options are grouped by expiry week, so a ticker may hold stock in a week where its
        // options expire a different week — allHistoryTickers catches those cases.
        const allWeekTickers = [...new Set([...Object.keys(week.byUnderlying), ...allHistoryTickers])]
        const weekBuys = weekComplete
          ? databaseService.getStockBuysInPeriod(req.user.userId, prevFriStr, thisFriStr, allWeekTickers, brokerFilter)
          : {}

        // Buys during the PREVIOUS week (prevPrevFri exclusive → prevFri inclusive).
        // getPositionsAsOf(prevFriStr) is inclusive, so shares bought ON prevFriStr are already
        // in pos — but weekBuys uses prevFriStr as exclusive lower bound and misses them.
        // We need prevWeekBuys to detect and correctly price those shares.
        const prevWeekBuys = databaseService.getStockBuysInPeriod(req.user.userId, prevPrevFriStr, prevFriStr, allWeekTickers, brokerFilter)

        const stockDelta = {}
        allWeekTickers.forEach(ticker => {
          const pos = weekPositions[ticker]
          const DEBUG = ticker === 'TQQQ'
          if (DEBUG) console.log(`[TQQQ hist] week=${week.weekStart} pos=${pos} prevFri=${prevFriStr} thisFri=${thisFriStr} complete=${weekComplete} rawPrevClose=${findClose(tickerDateMap[ticker] || {}, prevFriStr)} thisClose=${findClose(tickerDateMap[ticker] || {}, thisFriStr)} weekBuys=${JSON.stringify(weekBuys[ticker])} prevWeekBuys=${JSON.stringify(prevWeekBuys[ticker])}`)
          if (!tickerDateMap[ticker]) return

          if (pos && pos >= 100) {
            // Normal: had 100+ shares at start of week
            const rawPrevClose = findClose(tickerDateMap[ticker], prevFriStr)
            const thisClose = weekComplete ? findClose(tickerDateMap[ticker], thisFriStr) : 0

            // If large buys happened during the PREVIOUS week they're already included in pos
            // (getPositionsAsOf is inclusive) but not in weekBuys (exclusive lower bound).
            // Blend prevClose: old shares use rawPrevClose, recently-bought shares use buy price.
            // This prevents a price spike on the buy date from inflating the "from" price.
            const prevBuy = prevWeekBuys[ticker]
            let prevClose = rawPrevClose
            if (prevBuy && prevBuy.netChange > 0) {
              const oldPos = Math.max(0, pos - prevBuy.netChange)
              // Only blend if old position was already >= 100 shares (normal-path week).
              // If oldPos < 100, the previous week used the case-3 path which already charged
              // the buy price as cost basis — blending here would double-count it.
              if (oldPos >= 100) {
                prevClose = oldPos > 0
                  ? (rawPrevClose * oldPos + prevBuy.avgPrice * prevBuy.netChange) / pos
                  : prevBuy.avgPrice
              }
            }

            if (prevClose > 0) {
              if (!week.stockPrices) week.stockPrices = {}
              week.stockPrices[ticker] = { fromPrice: prevClose, toPrice: thisClose || prevClose, shares: pos }
            }
            if (weekComplete && prevClose > 0 && thisClose > 0) {
              stockDelta[ticker] = Math.round((thisClose - prevClose) * pos * 100) / 100
              // Ticker held stock this week but had no options expiring — inject with 0 optPnl
              if (week.byUnderlying[ticker] === undefined) {
                week.byUnderlying[ticker] = 0
                week.realizedByUnderlying[ticker] = 0
              }
            }
          } else {
            // Check if position was started MID-WEEK and held through EOW.
            // Use netChange (buys - sells) so quick buy-and-sell same week (e.g. assigned put
            // immediately sold) doesn't produce phantom stock P&L.
            const buys = weekBuys[ticker]
            const totalShares = (pos || 0) + (buys?.netChange || 0)
            if (buys && buys.netChange >= 100) {
              const shares = buys.netChange
              const thisClose = weekComplete ? findClose(tickerDateMap[ticker], thisFriStr) : 0
              if (!week.stockPrices) week.stockPrices = {}
              week.stockPrices[ticker] = { fromPrice: buys.avgPrice, toPrice: thisClose || buys.avgPrice, shares }
              if (weekComplete && thisClose > 0) {
                stockDelta[ticker] = Math.round((thisClose - buys.avgPrice) * shares * 100) / 100
                if (week.byUnderlying[ticker] === undefined) {
                  week.byUnderlying[ticker] = 0
                  week.realizedByUnderlying[ticker] = 0
                }
              }
            } else if (pos > 0 && buys && totalShares >= 100) {
              // Pre-existing small position + mid-week buy together reach 100 shares
              const prevClose = findClose(tickerDateMap[ticker], prevFriStr)
              const thisClose = weekComplete ? findClose(tickerDateMap[ticker], thisFriStr) : 0
              if (!week.stockPrices) week.stockPrices = {}
              week.stockPrices[ticker] = { fromPrice: prevClose || buys.avgPrice, toPrice: thisClose || prevClose || buys.avgPrice, shares: totalShares }
              if (weekComplete && thisClose > 0 && prevClose > 0) {
                stockDelta[ticker] = Math.round(((thisClose - prevClose) * pos + (thisClose - buys.avgPrice) * buys.netChange) * 100) / 100
                if (week.byUnderlying[ticker] === undefined) {
                  week.byUnderlying[ticker] = 0
                  week.realizedByUnderlying[ticker] = 0
                }
              }
            }
          }
        })
        if (Object.keys(stockDelta).length > 0) week.stockDelta = stockDelta

        // Other stocks delta (non-option holdings) — use historical share count, completed weeks only
        const otherDelta = {}
        otherSymbols.forEach(ticker => {
          const pos = weekPositions[ticker] || 0
          if (!pos || !tickerDateMap[ticker] || !weekComplete) return
          const prevClose = findClose(tickerDateMap[ticker], prevFriStr)
          const thisClose = findClose(tickerDateMap[ticker], thisFriStr)
          if (prevClose > 0 && thisClose > 0) {
            otherDelta[ticker] = Math.round((thisClose - prevClose) * pos * 100) / 100
          }
        })
        if (Object.keys(otherDelta).length > 0) week.otherStockDelta = otherDelta
      })
    }

    // Open option positions — delegate to the dedicated endpoint logic (lightweight, no Polygon here)
    let openOptionPositions = []
    try {
      const today = new Date().toISOString().slice(0, 10)
      const openOpts = databaseService.getOpenOptionPositions(req.user.userId, brokerFilter)
      // Filter out expired options
      const activeOpts = openOpts.filter(pos => {
        const parsed = parseOptionDescription(pos.symbol)
        if (!parsed) return false
        const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
        return expiry >= today
      })

      activeOpts.forEach(pos => {
        const parsed = parseOptionDescription(pos.symbol)
        if (!parsed) return
        const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
        const isLong = pos.net_long > 0
        const openContracts = isLong ? pos.net_long : pos.net_short
        const totalCostBasis = isLong ? pos.total_paid : pos.total_received
        const avgCostPerContract = openContracts > 0 ? Math.abs(totalCostBasis) / (isLong ? pos.bto_contracts : pos.sto_contracts) : 0

        openOptionPositions.push({
          symbol: pos.symbol,
          ticker: parsed.ticker,
          expiry,
          strike: parsed.strike,
          optionType: parsed.type,
          openContracts,
          isLong,
          avgCostPerContract: Math.round(avgCostPerContract * 100) / 100,
          markPrice: 0,
          currentValue: 0,
          unrealizedPnl: null
        })
      })

      openOptionPositions.sort((a, b) => a.expiry.localeCompare(b.expiry))
    } catch (e) {
      console.error('Error fetching open option positions:', e.message)
    }

    // Gather pre-market prices for all tracked stock symbols
    const allStockSymbols = [...new Set([
      ...Object.keys(weeklyStockPnL),
      ...Object.keys(otherStockPnLBySymbol),
    ])]
    const preMarketPrices = priceService.getPreMarketPrices(allStockSymbols)

    res.json({ success: true, weeks, currentWeekPnL, currentWeekRealizedTotal, currentWeekByUnderlying, currentWeekRealizedByUnderlying, currentWeekRealizedCallsByUnderlying, currentWeekRealizedPutsByUnderlying, currentWeekTradesByUnderlying, weeklyStockPnL, otherStockPnL, otherStockPnLBySymbol, otherStockCount: otherSymbols.length, weekStart: mondayStr, openOptionPositions, optionUnderlyingPrices, preMarketPrices })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/strategy-split — daily P&L split: stocks with options vs pure stocks
app.get('/api/strategy-split', requireAuth, (req, res) => {
  try {
    // Get today's and yesterday's snapshots
    const today = new Date().toISOString().slice(0, 10)
    const todaySnap = databaseService.getPnLSnapshot(today, req.user.userId)

    // Get symbols that have options (options_pnl != 0 in any snapshot)
    const symbolsWithOptions = new Set(
      todaySnap.filter(r => Math.abs(r.options_pnl || 0) > 0).map(r => r.symbol)
    )

    const withOptions = todaySnap.filter(r => symbolsWithOptions.has(r.symbol))
    const pureStocks = todaySnap.filter(r => !symbolsWithOptions.has(r.symbol))

    const sum = (arr, field) => arr.reduce((s, r) => s + (r[field] || 0), 0)

    res.json({
      success: true,
      withOptions: {
        count: withOptions.length,
        dailyPnL: sum(withOptions, 'daily_pnl'),
        optionsPnL: sum(withOptions, 'options_pnl'),
        totalPnL: sum(withOptions, 'total_pnl'),
        symbols: withOptions.map(r => r.symbol)
      },
      pureStocks: {
        count: pureStocks.length,
        dailyPnL: sum(pureStocks, 'daily_pnl'),
        totalPnL: sum(pureStocks, 'total_pnl'),
        symbols: pureStocks.map(r => r.symbol)
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/option-quotes — fetch live option prices from Polygon and calculate premium left
app.get('/api/option-quotes', requireAuth, async (req, res) => {
  const { symbols } = req.query
  if (!symbols) return res.json({ success: true, quotes: {} })

  const symbolList = symbols.split(',').filter(Boolean)
  const quotes = {}
  const currentPricesMap = priceService.getCurrentPrices()

  for (const desc of symbolList) {
    try {
      const polygonTicker = toPolygonTicker(desc)
      const parsed = parseOptionDescription(desc)
      if (!polygonTicker || !parsed) {
        quotes[desc] = { error: 'Could not parse option description' }
        continue
      }

      const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
      const response = await axios.get(url, {
        params: { apiKey: process.env.POLYGON_API_KEY || 'YOUR_API_KEY_HERE' },
        timeout: 8000
      })

      const snap = response.data?.results
      if (!snap) {
        quotes[desc] = { error: 'No data from Polygon', polygonTicker }
        continue
      }

      // Option price: prefer mid of bid/ask, fall back to last trade or day close
      const bid = snap.last_quote?.bid || 0
      const ask = snap.last_quote?.ask || 0
      const mid = bid && ask ? (bid + ask) / 2 : (snap.day?.close || snap.last_trade?.price || 0)
      const optionPrice = mid

      const stockPrice = currentPricesMap[parsed.ticker] || 0
      const premium = calcPremiumLeft(optionPrice, stockPrice, parsed.strike, parsed.type)

      quotes[desc] = {
        polygonTicker,
        ticker: parsed.ticker,
        strike: parsed.strike,
        type: parsed.type,
        optionPrice,
        bid,
        ask,
        ...premium,
        greeks: snap.greeks || null,
        impliedVolatility: snap.implied_volatility || null,
        openInterest: snap.open_interest || null,
        stockPrice
      }
    } catch (e) {
      quotes[desc] = { error: e.response?.status === 403 ? 'API key does not have options access' : e.message }
    }
  }

  res.json({ success: true, quotes })
})

// Catch-all route to serve index.html for client-side routing
// This must be AFTER all API routes
app.get('*', (req, res) => {
  // Set no-cache headers for HTML to prevent stale content
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

const PORT = process.env.PORT || 3001
const HOST = '0.0.0.0' // Listen on all interfaces for Railway

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
})

// ─── Daily EOD price snapshot ────────────────────────────────────────────────

async function takeEODSnapshot(userId, force = false) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  if (!force && databaseService.hasDailyPriceSnapshot(userId, today)) return  // already done today

  console.log(`📸 Taking EOD price snapshot for user ${userId} on ${today}`)
  const entries = []

  // Stock prices: all held positions + option underlyings
  const allPositions = databaseService.getAllPositions(userId)
  const allOptionTrades = databaseService.getOptionTrades(userId)
  const optionTickers = [...new Set(allOptionTrades.map(t => parseOptionDescription(t.symbol)?.ticker).filter(Boolean))]
  const stockSymbols = [...new Set([...Object.keys(allPositions), ...optionTickers])]

  if (stockSymbols.length > 0) {
    const prices = await priceService.fetchPrices(stockSymbols)
    stockSymbols.forEach(sym => { if (prices[sym] > 0) entries.push({ symbol: sym, closePrice: prices[sym], isOption: false, contracts: null }) })
  }

  // Option prices: open contracts via Polygon snapshot
  const polygonKey = process.env.POLYGON_API_KEY || ''
  if (polygonKey) {
    const openOpts = databaseService.getOpenOptionPositions(userId)
    const activeOpts = openOpts.filter(pos => {
      const parsed = parseOptionDescription(pos.symbol)
      if (!parsed) return false
      return `${parsed.year}-${parsed.month}-${parsed.day}` >= today
    })
    for (const pos of activeOpts) {
      const polygonTicker = toPolygonTicker(pos.symbol)
      const parsed = parseOptionDescription(pos.symbol)
      if (!polygonTicker || !parsed) continue
      try {
        const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
        const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 8000 })
        const snap = resp.data?.results
        if (snap) {
          const mid = snap.last_quote?.midpoint || (snap.last_quote?.bid && snap.last_quote?.ask ? (snap.last_quote.bid + snap.last_quote.ask) / 2 : 0)
          const fallback = snap.day?.close || snap.last_trade?.price || 0
          const best = Math.max(mid || 0, fallback || 0) || mid || fallback || 0
          if (best > 0) {
            const contracts = pos.net_long > 0 ? pos.net_long : -pos.net_short
            entries.push({ symbol: pos.symbol, closePrice: best, isOption: true, contracts })
          }
        }
      } catch (e) {
        console.warn(`  Polygon snapshot failed for ${pos.symbol}:`, e.message)
      }
    }
  }

  if (entries.length > 0) {
    databaseService.saveDailyPriceSnapshot(userId, today, entries)
    console.log(`✓ EOD snapshot saved: ${entries.length} prices for ${today} (user ${userId})`)
  }
}

// ── Closing implied vol capture ───────────────────────────────────────────────
// For each open contract, take the day's actual closing mark and solve for the
// vol that reproduces it against the underlying's close. Storing sigma (rather
// than repricing off the original sale premium) is what makes the extended-hours
// estimate continuous with the close: BS(underlying_close, sigma) == close_mark
// by construction, so there's no jump at 4pm.
async function captureClosingIV(userId) {
  const polygonKey = process.env.POLYGON_API_KEY || ''
  if (!polygonKey) return 0
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10)

  const openOpts = databaseService.getOpenOptionPositions(userId).filter(pos => {
    const parsed = parseOptionDescription(pos.symbol)
    if (!parsed) return false
    return `${parsed.year}-${parsed.month}-${parsed.day}` > today   // still has time value
  })
  if (!openOpts.length) return 0

  // One underlying close per ticker, shared across that ticker's contracts.
  const tickers = [...new Set(openOpts.map(p => parseOptionDescription(p.symbol).ticker))]
  const stockCloses = await priceService.fetchPrices(tickers)

  let saved = 0
  for (const pos of openOpts) {
    const parsed = parseOptionDescription(pos.symbol)
    const polygonTicker = toPolygonTicker(pos.symbol)
    if (!parsed || !polygonTicker) continue
    const S = stockCloses[parsed.ticker] || 0
    if (!(S > 0)) continue

    // Prefer the real bid/ask mid; fall back to the day's close / last trade.
    let closeMark = 0, source = 'quote-mid'
    try {
      closeMark = await fetchOptionQuoteMid(polygonTicker, polygonKey)
      if (!(closeMark > 0)) {
        const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
        const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 8000 })
        closeMark = staleOptionMark(resp.data?.results)
        source = 'day-close'
      }
    } catch { /* leave 0 */ }
    if (!(closeMark > 0)) continue

    const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
    const T = (new Date(expiry).getTime() - new Date(today).getTime()) / (365.25 * 24 * 3600 * 1000)
    if (!(T > 0)) continue

    let sigma = impliedVol(closeMark, S, parsed.strike, T, RISK_FREE_RATE, parsed.type)
    // A high pin means the mark is above anything any vol can produce — a stale
    // or crossed quote. Storing it would poison the estimate, so drop it.
    if (sigma >= 4.999) continue
    // A low pin is not an error: a deep ITM contract is nearly all intrinsic, so
    // its price genuinely carries no vol information. repriceFromClose handles
    // that correctly (the change becomes the change in intrinsic, delta ~ 1),
    // but it needs a positive sigma to work with.
    if (!(sigma > 0)) sigma = 0.001

    databaseService.saveOptionIvMark(userId, {
      symbol: pos.symbol, ticker: parsed.ticker, opt_type: parsed.type,
      strike: parsed.strike, expiry, mark_date: today,
      close_mark: closeMark, underlying_close: S, sigma, source,
    })
    saved++
  }
  if (saved > 0) console.log(`✓ Closing IV captured for ${saved} contracts on ${today} (user ${userId})`)
  return saved
}

// Check every 5 minutes; trigger snapshot Mon-Fri between 4:05-4:30pm ET
setInterval(async () => {
  try {
    const etDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etDate.getDay()
    const hour = etDate.getHours()
    const minute = etDate.getMinutes()
    if (day < 1 || day > 5) return              // weekend
    if (hour !== 16 || minute < 5 || minute > 30) return  // outside 4:05-4:30pm ET
    const users = databaseService.getAllUsers()
    for (const user of users) {
      await takeEODSnapshot(user.id)
      // Same window: the marks we just read are the closing marks.
      try { await captureClosingIV(user.id) } catch (e) { console.error('Closing IV capture error:', e.message) }
    }
  } catch (e) {
    console.error('EOD snapshot job error:', e.message)
  }
}, 5 * 60 * 1000)

// ─────────────────────────────────────────────────────────────────────────────

console.log('🔧 Starting HTTP server...')
console.log(`   PORT: ${PORT}`)
console.log(`   HOST: ${HOST}`)
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'not set'}`)
console.log(`   POLYGON_API_KEY: ${process.env.POLYGON_API_KEY ? 'set' : 'not set'}`)

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ Server successfully started!`)
  console.log(`🚀 Server running on ${HOST}:${PORT}`)
  console.log(`📊 WebSocket server ready for connections`)
  console.log(`💰 Price updates: DISABLED (investigating crashes)`)
  console.log(`📈 Signal updates: on-demand`)
  console.log(`🎯 Support/Resistance scan: DISABLED (manual refresh only)`)
  console.log(`🧹 Session cleanup: every 5 minutes`)
  console.log(`📅 Database cleanup: scheduled for 3 AM`)
  console.log('')
  console.log('Server is ready to accept connections!')
}).on('error', (error) => {
  console.error('❌ FATAL: Server failed to start:', error.message)
  console.error('Stack:', error.stack)
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please choose a different port.`)
  }
  process.exit(1)
})

// Handle graceful shutdown (Railway sends SIGTERM before killing)
process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM signal received - Railway is stopping the container')
  console.log('   Reason: This typically happens due to:')
  console.log('     1. Manual restart in Railway dashboard')
  console.log('     2. New deployment')
  console.log('     3. Memory limit exceeded')
  console.log('     4. Health check failures')
  console.log('     5. Inactivity timeout')
  console.log('   Uptime:', Math.round(process.uptime()), 'seconds')
  console.log('   Memory:', {
    heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
    rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'
  })
  console.log('   Active sessions:', clientSessions.size)
  console.log('   Tracked symbols:', trackedSymbols.size)

  // Give existing requests time to finish
  console.log('   Closing server gracefully...')
  httpServer.close(() => {
    console.log('✅ Server closed gracefully')
    process.exit(0)
  })

  // Force close after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('❌ Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
})

process.on('SIGINT', () => {
  console.log('⚠️  SIGINT signal received (Ctrl+C)')
  console.log('   Closing server gracefully...')
  httpServer.close(() => {
    console.log('✅ Server closed gracefully')
    process.exit(0)
  })
})
