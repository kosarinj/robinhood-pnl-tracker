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
import { databaseService } from './services/database.js'
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

// Socket.IO authentication middleware
// AUTH DISABLED - defaulting to jkosarin user
io.use((socket, next) => {
  // Skip authentication - default to jkosarin user (ID 1)
  socket.data.user = {
    userId: 1,
    username: 'jkosarin',
    email: 'jkosarin@example.com'
  }
  next()
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
      const { csvContent } = data

      console.log(`Processing CSV for client ${socket.id}`)

      // Parse trades, dividends/interest, and deposits
      const { trades, dividendsAndInterest } = await parseTrades(csvContent)
      const { deposits, totalPrincipal } = await parseDeposits(csvContent)

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
        databaseService.saveTrades(trades, asofDate, deposits, totalPrincipal, user.userId)
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
              underlyingClose
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
          currentPrices: initialPrices,
          asofDate,
          uploadDate: asofDate,
          madeUpGroundDate: weekAgoDate,
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

  // Clear all saved data (admin function)
  socket.on('clear-database', () => {
    console.log(`🗑️  Received clear-database request`)
    try {
      databaseService.clearAllData()
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

    // Set session cookie (httpOnly for security)
    res.cookie('session_token', result.sessionToken, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax'
    })

    res.json({ success: true, user: result.user })
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

// Middleware to require authentication for protected routes
// AUTH DISABLED - defaulting to jkosarin user
const requireAuth = (req, res, next) => {
  // Skip authentication - default to jkosarin user (ID 1)
  req.user = {
    userId: 1,
    username: 'jkosarin',
    email: 'jkosarin@example.com'
  }
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
    const openOpts = databaseService.getOpenOptionPositions(req.user.userId)

    // Filter out positions where option has already expired
    const activeOpts = openOpts.filter(pos => {
      const parsed = parseOptionDescription(pos.symbol)
      if (!parsed) return false
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      return expiry >= today
    })

    console.log(`Open option positions: ${openOpts.length} total, ${activeOpts.length} non-expired`)

    // Collect all unique underlying tickers (active + historical) for stock price fetch
    const allOptionTrades = databaseService.getOptionTrades(req.user.userId)
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

    const positions = []
    activeOpts.forEach(pos => {
      const quotes = markPrices[pos.symbol] || null
      const parsed = parseOptionDescription(pos.symbol)
      if (!parsed) return
      const expiry = `${parsed.year}-${parsed.month}-${parsed.day}`
      const isLong = pos.net_long > 0
      const mark = quotes?.mid || 0
      const openContracts = isLong ? pos.net_long : pos.net_short
      const totalCostBasis = isLong ? pos.total_paid : pos.total_received
      const avgCostPerContract = openContracts > 0 ? Math.abs(totalCostBasis) / (isLong ? pos.bto_contracts : pos.sto_contracts) : 0
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
        currentValue: Math.round(currentValue * 100) / 100,
        unrealizedPnl: mark > 0 ? Math.round(unrealizedPnl * 100) / 100 : null,
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
  try {
    const userId = req.user.userId
    const globalStart = req.query.startDate || '2000-01-01'
    const perSymbolDates = req.query.symbolDates ? JSON.parse(req.query.symbolDates) : {}

    const allTrades = databaseService.getOptionTradesForYTD(userId)

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
      const sym = parsed
        ? `${parsed.ticker}|${parsed.year}${parsed.month}${parsed.day}|${parsed.type}|${parsed.strike}`
        : (t.symbol || '')
      const contracts = Math.abs(t.contracts || 1)
      const amount = Math.abs(t.amount)
      const ppc = contracts > 0 ? amount / contracts : amount
      if (!lifoStacks[sym]) lifoStacks[sym] = { long: [], short: [] }
      const stacks = lifoStacks[sym]
      if (tc === 'BTO') {
        stacks.long.push({ ppc, remaining: contracts })
      } else if (tc === 'STO') {
        stacks.short.push({ ppc, remaining: contracts })
      } else if (['STC', 'BTC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)) {
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

    // Open premium from LIFO stack residuals — only what's genuinely still open.
    // Using stack residuals is correct because OEXP (expired short) reduces the short stack,
    // so anything remaining is truly unclosed.
    const openPremiumByTicker = {}
    Object.entries(lifoStacks).forEach(([sym, stacks]) => {
      const ticker = sym.split('|')[0]
      if (!ticker || ticker.length > 6 || !/^[A-Z]+$/.test(ticker)) return
      if (!openPremiumByTicker[ticker]) openPremiumByTicker[ticker] = 0
      stacks.short.forEach(lot => { if (lot.remaining > 0) openPremiumByTicker[ticker] += lot.remaining * lot.ppc })
      stacks.long.forEach(lot => { if (lot.remaining > 0) openPremiumByTicker[ticker] -= lot.remaining * lot.ppc })
    })

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

    // Include tickers with only open positions (no realized trades in date range)
    Object.keys(openPremiumByTicker).forEach(ticker => {
      if (!byUnderlying[ticker]) {
        byUnderlying[ticker] = {
          ticker, startDate: perSymbolDates[ticker] || globalStart,
          realizedShortCalls: 0, realizedLongCalls: 0,
          realizedShortPuts: 0, realizedLongPuts: 0,
          totalRealized: 0, tradeCount: 0
        }
      }
    })

    // Stock positions + live prices — fetched server-side so frontend doesn't need pnlData
    const stockPositions = databaseService.getStockPositionsWithCost(userId)
    const allTickers = [...new Set([...Object.keys(byUnderlying), ...Object.keys(stockPositions)])]
    const stockPrices = {}
    if (allTickers.length > 0) {
      try {
        const yfUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${allTickers.join(',')}&fields=regularMarketPrice,preMarketPrice,postMarketPrice,marketState`
        const yfResp = await axios.get(yfUrl, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' }
        })
        ;(yfResp.data?.quoteResponse?.result || []).forEach(q => {
          let price = q.regularMarketPrice
          if (q.marketState === 'PRE' && q.preMarketPrice) price = q.preMarketPrice
          else if ((q.marketState === 'POST' || q.marketState === 'CLOSED') && q.postMarketPrice) price = q.postMarketPrice
          if (price > 0) stockPrices[q.symbol] = price
        })
      } catch (e) {
        console.warn('YTD YF price fetch failed:', e.message)
        const cached = priceService.getCurrentPrices()
        allTickers.forEach(t => { if (cached[t] > 0) stockPrices[t] = cached[t] })
      }
    }

    // Also fill any missing prices from the in-memory cache (populated by dashboard refresh)
    const cachedPrices = priceService.getCurrentPrices()
    allTickers.forEach(t => { if (!stockPrices[t] && cachedPrices[t] > 0) stockPrices[t] = cachedPrices[t] })
    const pricesFetched = Object.keys(stockPrices).filter(t => stockPrices[t] > 0).length
    console.log(`YTD: ${Object.keys(stockPositions).length} stock positions, ${allTickers.length} tickers, ${pricesFetched} prices fetched`)

    const r2 = n => Math.round(n * 100) / 100
    const result = Object.values(byUnderlying)
      .map(e => {
        const sp = stockPositions[e.ticker]
        const cp = stockPrices[e.ticker] || null
        return {
          ...e,
          realizedShortCalls: r2(e.realizedShortCalls),
          realizedLongCalls: r2(e.realizedLongCalls),
          realizedShortPuts: r2(e.realizedShortPuts),
          realizedLongPuts: r2(e.realizedLongPuts),
          totalRealized: r2(e.totalRealized),
          openPremium: r2(openPremiumByTicker[e.ticker] || 0),
          stockPosition: sp?.position ?? null,
          stockAvgCost: sp?.avgCost ?? null,
          stockCurrentPrice: cp,
          stockUnrealizedPnL: sp && cp ? r2(sp.position * (cp - sp.avgCost)) : null
        }
      })
      .sort((a, b) => b.totalRealized - a.totalRealized)

    res.json({ success: true, byUnderlying: result, globalStart, perSymbolDates })
  } catch (e) {
    console.error('Error in /api/options-pnl/ytd:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

// GET /api/short-calls — short call positions with current prices
app.get('/api/short-calls', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId
    const entries = databaseService.getShortCallEntries(userId)

    // Get open short option positions for status determination
    const openPositions = databaseService.getOpenOptionPositions(userId)
    const openShortSymbols = new Set(
      openPositions.filter(p => p.net_short > 0).map(p => p.symbol)
    )

    // Fetch current option prices via Polygon for open positions
    const polygonKey = process.env.POLYGON_API_KEY || ''
    const optionPrices = {}
    const polygonStockPrices = {}
    if (polygonKey) {
      for (const entry of entries) {
        if (!openShortSymbols.has(entry.symbol)) continue
        const polygonTicker = toPolygonTicker(entry.symbol)
        const parsed = parseOptionDescription(entry.symbol)
        if (!polygonTicker || !parsed) continue
        try {
          const url = `https://api.polygon.io/v3/snapshot/options/${parsed.ticker}/${polygonTicker}`
          const resp = await axios.get(url, { params: { apiKey: polygonKey }, timeout: 5000 })
          const snap = resp.data?.results
          if (snap) {
            const mid = snap.last_quote?.midpoint || (snap.last_quote?.bid && snap.last_quote?.ask ? (snap.last_quote.bid + snap.last_quote.ask) / 2 : 0)
            const fallback = snap.day?.close || snap.last_trade?.price || 0
            optionPrices[entry.symbol] = Math.max(mid || 0, fallback || 0)
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
        const yfUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${missingTickers.join(',')}&fields=regularMarketPrice,preMarketPrice,postMarketPrice,marketState`
        const yfResp = await axios.get(yfUrl, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' }
        })
        const quotes = yfResp.data?.quoteResponse?.result || []
        quotes.forEach(q => {
          let price = q.regularMarketPrice
          if (q.marketState === 'PRE' && q.preMarketPrice) price = q.preMarketPrice
          else if ((q.marketState === 'POST' || q.marketState === 'CLOSED') && q.postMarketPrice) price = q.postMarketPrice
          if (price > 0) polygonStockPrices[q.symbol] = price
        })
        console.log(`Short-calls: fetched ${quotes.filter(q => q.regularMarketPrice > 0).length}/${missingTickers.length} stock prices from YF`)
      } catch (e) {
        console.warn('Short-calls YF price fetch failed:', e.message)
        // Last resort: in-memory cache
        const cached = priceService.getCurrentPrices()
        missingTickers.forEach(t => { if (cached[t] > 0) polygonStockPrices[t] = cached[t] })
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    const result = entries.map(entry => {
      const currentStock = polygonStockPrices[entry.ticker] > 0 ? polygonStockPrices[entry.ticker] : null
      const currentOptionPrice = optionPrices[entry.symbol] || null
      const isOpen = openShortSymbols.has(entry.symbol)
      const expiryMs = new Date(entry.expiry + 'T00:00:00Z').getTime()
      const todayMs = new Date(today + 'T00:00:00Z').getTime()
      const daysToExpiry = Math.round((expiryMs - todayMs) / (1000 * 60 * 60 * 24))
      const isExpired = daysToExpiry < 0
      return {
        ...entry,
        currentStock,
        currentOptionPrice,
        isOpen,
        isExpired,
        daysToExpiry,
        stockMove: (currentStock != null && entry.underlying_close != null) ? Math.round((currentStock - entry.underlying_close) * 100) / 100 : null,
        thetaGain: (currentOptionPrice != null) ? Math.round((entry.premium - currentOptionPrice) * 100) / 100 : null
      }
    })

    res.json({ success: true, entries: result, polygonEnabled: !!polygonKey })
  } catch (e) {
    console.error('Error in /api/short-calls:', e.message)
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
        underlyingClose
      })
      populated++
    }
    res.json({ success: true, populated, skipped })
  } catch (e) {
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

// Password reset endpoint (for debugging - should require email verification in production)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { username, newPassword } = req.body

    if (!username || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Username and new password required'
      })
    }

    // For now, allow password reset without verification (debug mode)
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
    const userId = req.session?.userId || 1
    // getStockPositionsWithCost lives in database.js where db is in scope
    const stockData = databaseService.getStockPositionsWithCost(userId)
    const symbols = Object.keys(stockData)
    console.log(`/api/stock-positions-with-prices: getStockPositionsWithCost returned ${symbols.length} symbols: ${symbols.join(', ')}`)

    if (symbols.length === 0) {
      // Fallback: try raw getAllPositions to diagnose
      const rawPos = databaseService.getAllPositions(userId)
      const rawSymbols = Object.keys(rawPos)
      console.log(`  getAllPositions fallback: ${rawSymbols.length} symbols: ${rawSymbols.join(', ')}`)
      return res.json({ success: true, holdings: [], debug: { stockDataEmpty: true, rawPositions: rawPos } })
    }

    // Fetch live prices — Polygon if key set, otherwise Yahoo Finance
    let prices = {}
    try {
      const resp = await axios.get(
        process.env.POLYGON_API_KEY
          ? `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.join(',')}&apiKey=${process.env.POLYGON_API_KEY}`
          : `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,preMarketPrice,postMarketPrice,marketState`,
        { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } }
      )
      if (process.env.POLYGON_API_KEY) {
        ;(resp.data?.tickers || []).forEach(t => {
          const price = t.lastTrade?.p || t.day?.c || t.prevDay?.c || 0
          if (price > 0) prices[t.ticker] = price
        })
      } else {
        ;(resp.data?.quoteResponse?.result || []).forEach(q => {
          let price = q.regularMarketPrice
          if (q.marketState === 'PRE' && q.preMarketPrice) price = q.preMarketPrice
          else if ((q.marketState === 'POST' || q.marketState === 'CLOSED') && q.postMarketPrice) price = q.postMarketPrice
          if (price > 0) prices[q.symbol] = price
        })
      }
    } catch (e) {
      console.warn('stock-positions price fetch failed:', e.message)
      const cached = priceService.getCurrentPrices()
      symbols.forEach(s => { if (cached[s] > 0) prices[s] = cached[s] })
    }

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

// Debug: show raw stock trades from DB so we can diagnose position query issues
app.get('/api/debug-stock-trades', requireAuth, (req, res) => {
  try {
    const userId = req.session?.userId || 1
    const rows = databaseService.getRawStockTrades(userId)
    res.json({ success: true, userId, rows })
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
    const userId = req.session?.userId || 1
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
    const userId = req.session?.userId || 1
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
    const trades = databaseService.getOptionTrades(req.user.userId)

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
    const allPositions = databaseService.getAllPositions(req.user.userId)
    const otherSymbols = Object.keys(allPositions).filter(s => !thisWeekSymbols.includes(s))
    // Also include option-only underlyings (user holds options but not the stock)
    const allOptionTrades = databaseService.getOptionTrades(req.user.userId)
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

      const thisWeekSells = databaseService.getThisWeekStockSells(req.user.userId, mondayStr, thisWeekSymbols)
      const thisWeekBuys = databaseService.getStockBuysInPeriod(req.user.userId, lastFridayStr, todayStr, thisWeekSymbols)
      const lastFriPositions = databaseService.getPositionsAsOf(req.user.userId, lastFridayStr)
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

        const weekPositions = databaseService.getPositionsAsOf(req.user.userId, prevFriStr)
        const weekComplete = thisFriStr <= todayStr

        // Check stock for ALL tickers ever seen, not just those with options expiring this week.
        // Options are grouped by expiry week, so a ticker may hold stock in a week where its
        // options expire a different week — allHistoryTickers catches those cases.
        const allWeekTickers = [...new Set([...Object.keys(week.byUnderlying), ...allHistoryTickers])]
        const weekBuys = weekComplete
          ? databaseService.getStockBuysInPeriod(req.user.userId, prevFriStr, thisFriStr, allWeekTickers)
          : {}

        // Buys during the PREVIOUS week (prevPrevFri exclusive → prevFri inclusive).
        // getPositionsAsOf(prevFriStr) is inclusive, so shares bought ON prevFriStr are already
        // in pos — but weekBuys uses prevFriStr as exclusive lower bound and misses them.
        // We need prevWeekBuys to detect and correctly price those shares.
        const prevWeekBuys = databaseService.getStockBuysInPeriod(req.user.userId, prevPrevFriStr, prevFriStr, allWeekTickers)

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
      const openOpts = databaseService.getOpenOptionPositions(req.user.userId)
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
    for (const user of users) await takeEODSnapshot(user.id)
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
