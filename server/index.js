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
import cookieParser from 'cookie-parser'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import path from 'path'

// Global error handlers to prevent server crashes
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error)
  console.error('Stack:', error.stack)
  // Don't exit - keep server running
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Promise Rejection at:', promise)
  console.error('Reason:', reason)
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
  allowEIO3: true
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
app.use(cors(corsOptions))
app.use(express.json())
app.use(cookieParser())

// Serve static files from the React app (after building with vite build)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
app.use(express.static(path.join(__dirname, '../dist')))

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
  const now = Date.now()
  for (const [sessionId, session] of clientSessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log(`Cleaning up inactive session: ${sessionId}`)
      clientSessions.delete(sessionId)
    }
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
io.use((socket, next) => {
  // Get cookies from handshake
  const cookies = socket.handshake.headers.cookie
  if (!cookies) {
    return next(new Error('Authentication required'))
  }

  // Parse cookies manually (socket.io doesn't use cookie-parser)
  const cookieObj = {}
  cookies.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=')
    cookieObj[key] = value
  })

  const sessionToken = cookieObj.session_token
  if (!sessionToken) {
    return next(new Error('Authentication required'))
  }

  // Verify session
  const user = authService.verifySession(sessionToken)
  if (!user) {
    return next(new Error('Invalid or expired session'))
  }

  // Store user info in socket for later use
  socket.data.user = user
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

      // Get historical prices for the asof_date (closing prices from that day)
      console.log(`📅 Fetching historical prices for ${asofDate}...`)
      const historicalPrices = await priceService.getPricesForDate(stockSymbols, asofDate)
      console.log(`✓ Fetched historical prices for ${Object.keys(historicalPrices).length} symbols`)

      // Calculate P&L using historical prices from the asof_date
      const pnlData = calculatePnL(trades, historicalPrices, true, null, asofDate, [])

      // Save P&L snapshot to database with historical prices
      try {
        databaseService.savePnLSnapshot(asofDate, pnlData, user.userId)
        console.log(`💾 Saved P&L snapshot for ${asofDate} with historical prices (user: ${user.userId})`)
      } catch (error) {
        console.error('Error saving P&L snapshot:', error)
      }

      // Save trades and deposits to database
      try {
        databaseService.saveTrades(trades, asofDate, deposits, totalPrincipal, user.userId)
        console.log(`💾 Saved ${trades.length} trades and ${deposits.length} deposits to database for ${asofDate} (user: ${user.userId})`)
      } catch (error) {
        console.error('Error saving trades:', error)
      }

      // Save price benchmarks for P&L comparison
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
      } catch (error) {
        console.error('Error saving price benchmarks:', error)
      }

      // Get price benchmarks for each position
      let pnlDataWithBenchmarks = pnlData.map(position => {
        const benchmarks = databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
        return {
          ...position,
          benchmarks
        }
      })

      // Enrich with Made Up Ground
      const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
      if (weekAgoSnapshot.length > 0) {
        pnlDataWithBenchmarks = enrichWithMadeUpGround(pnlDataWithBenchmarks, weekAgoSnapshot)
      }

      // Send initial data with historical prices (not current prices)
      // This ensures the uploaded file shows prices from the upload date
      socket.emit('csv-processed', {
        success: true,
        data: {
          trades,
          pnlData: pnlDataWithBenchmarks,  // Use historical P&L data with benchmarks
          totalPrincipal,
          deposits,
          currentPrices: historicalPrices,  // Use historical prices
          asofDate,
          uploadDate: asofDate,  // Add uploadDate to indicate viewing historical data
          madeUpGroundDate: weekAgoDate
        }
      })

      console.log(`CSV processed for client ${socket.id}: ${trades.length} trades, ${stockSymbols.length} symbols`)
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
  const now = new Date()
  const next3AM = new Date(now)
  next3AM.setHours(3, 0, 0, 0)

  if (next3AM <= now) {
    next3AM.setDate(next3AM.getDate() + 1)
  }

  const timeUntilCleanup = next3AM.getTime() - now.getTime()

  setTimeout(() => {
    console.log('🧹 Running daily database cleanup...')
    databaseService.cleanup()
    scheduleCleanup() // Schedule next cleanup
  }, timeUntilCleanup)

  console.log(`Next database cleanup scheduled for ${next3AM.toLocaleString()}`)
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
  res.json({
    status: 'healthy',
    clients: clientSessions.size,
    trackedSymbols: priceService.getTrackedSymbols().length,
    recordingSymbols: trackedSymbols.size,
    uptime: process.uptime()
  })
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
const requireAuth = (req, res, next) => {
  const sessionToken = req.cookies.session_token
  const user = authService.verifySession(sessionToken)

  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required' })
  }

  req.user = user
  next()
}

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

// Catch-all route to serve index.html for client-side routing
// This must be AFTER all API routes
app.get('*', (req, res) => {
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

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`)
  console.log(`📊 WebSocket server ready for connections`)
  console.log(`💰 Price updates every 1 minute`)
  console.log(`📈 Signal updates on-demand`)
}).on('error', (error) => {
  console.error('❌ Server error:', error)
  process.exit(1)
})
