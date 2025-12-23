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
import fs from 'fs'

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

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() })

// Services
const priceService = new PriceService()

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

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

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
        databaseService.savePnLSnapshot(asofDate, pnlData)
        console.log(`💾 Saved P&L snapshot for ${asofDate} with historical prices`)
      } catch (error) {
        console.error('Error saving P&L snapshot:', error)
      }

      // Save trades and deposits to database
      try {
        databaseService.saveTrades(trades, asofDate, deposits, totalPrincipal)
        console.log(`💾 Saved ${trades.length} trades and ${deposits.length} deposits to database for ${asofDate}`)
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
    console.log('🔍 Checking for Made Up Ground enrichment')
    const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
    console.log(`   Week ago: ${weekAgoSnapshot.length} records from ${weekAgoDate || 'null'}`)
    if (weekAgoSnapshot.length > 0) {
      pnlData = enrichWithMadeUpGround(pnlData, weekAgoSnapshot)
    }

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
    console.log('🔍 Checking for Made Up Ground enrichment')
    const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)
    console.log(`   Week ago: ${weekAgoSnapshot.length} records from ${weekAgoDate || 'null'}`)
    if (weekAgoSnapshot.length > 0) {
      pnlData = enrichWithMadeUpGround(pnlData, weekAgoSnapshot)
    }

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
    console.log(`📅 Received get-snapshot-dates request`)
    try {
      const dates = databaseService.getSnapshotDates()
      socket.emit('snapshot-dates-result', { dates })
    } catch (error) {
      console.error(`❌ Error getting snapshot dates:`, error)
      socket.emit('snapshot-dates-error', { error: error.message })
    }
  })

  // Load P&L snapshot for a specific date
  socket.on('load-pnl-snapshot', async ({ asofDate }) => {
    console.log(`📂 Received load-pnl-snapshot request for: ${asofDate}`)
    try {
      const snapshot = databaseService.getPnLSnapshot(asofDate)
      socket.emit('pnl-snapshot-loaded', { success: true, asofDate, data: snapshot })
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
    console.log(`📥 Received get-latest-trades request`)
    try {
      const { trades, uploadDate } = databaseService.getLatestTrades()

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

        const deposits = databaseService.getDeposits(uploadDate)
        const totalPrincipal = databaseService.getTotalPrincipal(uploadDate)

        socket.emit('latest-trades-result', {
          success: true,
          trades,
          uploadDate,
          deposits,
          totalPrincipal,
          currentPrices: historicalPrices,
          pnlData: pnlDataWithBenchmarks
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
    console.log(`📅 Received get-upload-dates request`)
    try {
      const dates = databaseService.getUploadDates()
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
    console.log(`📂 Received load-trades request for: ${uploadDate}`)
    try {
      const trades = databaseService.getTrades(uploadDate)

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

      const deposits = databaseService.getDeposits(uploadDate)
      const totalPrincipal = databaseService.getTotalPrincipal(uploadDate)

      // Store session data so client receives auto-updates
      clientSessions.set(socket.id, {
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
    console.log(`🗑️ Received delete-snapshot request for ${date}`)
    try {
      const deletedCount = databaseService.deletePnLSnapshot(date)
      console.log(`✅ Deleted ${deletedCount} snapshot records for ${date}`)
      socket.emit('snapshot-deleted', { success: true, date, deletedCount })
    } catch (error) {
      console.error(`❌ Error deleting snapshot:`, error)
      socket.emit('snapshot-deleted', { success: false, error: error.message })
    }
  })

  // Clear all P&L snapshots (admin function)
  socket.on('clear-all-snapshots', () => {
    console.log(`🗑️ Received clear-all-snapshots request`)
    try {
      const deletedCount = databaseService.clearAllSnapshots()
      console.log(`✅ Cleared all snapshots (${deletedCount} records)`)
      socket.emit('snapshots-cleared', { success: true, deletedCount })
    } catch (error) {
      console.error(`❌ Error clearing snapshots:`, error)
      socket.emit('snapshots-cleared', { success: false, error: error.message })
    }
  })

  // Get daily P&L history for charting
  socket.on('get-daily-pnl', () => {
    console.log(`📊 Received get-daily-pnl request`)
    try {
      const dailyPnL = databaseService.getDailyPnLHistory()
      console.log(`✅ Sending ${dailyPnL.length} days of P&L history`)

      // Debug: Show what dates we have snapshots for
      const dates = databaseService.getSnapshotDates()
      console.log(`📅 Available snapshot dates: ${dates.join(', ')}`)

      socket.emit('daily-pnl-result', { success: true, data: dailyPnL })
    } catch (error) {
      console.error(`❌ Error getting daily P&L:`, error)
      socket.emit('daily-pnl-error', { error: error.message })
    }
  })

  // Get symbol-specific daily P&L with price
  socket.on('get-symbol-pnl', ({ symbol }) => {
    console.log(`📊 Received get-symbol-pnl request for ${symbol}`)
    try {
      const symbolPnL = databaseService.getSymbolDailyPnL(symbol)
      console.log(`✅ Sending ${symbolPnL.length} days of P&L for ${symbol}`)
      socket.emit('symbol-pnl-result', { success: true, symbol, data: symbolPnL })
    } catch (error) {
      console.error(`❌ Error getting symbol P&L:`, error)
      socket.emit('symbol-pnl-error', { error: error.message })
    }
  })

  // Get list of symbols with snapshot data
  socket.on('get-symbols-list', () => {
    console.log(`📋 Received get-symbols-list request`)
    try {
      const symbols = databaseService.getSymbolsWithSnapshots()
      console.log(`✅ Sending ${symbols.length} symbols`)
      socket.emit('symbols-list-result', { success: true, data: symbols })
    } catch (error) {
      console.error(`❌ Error getting symbols list:`, error)
      socket.emit('symbols-list-error', { error: error.message })
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
let recordingCounter = 0
setInterval(async () => {
  try {
    const updatedPrices = await priceService.refreshPrices()
    recordingCounter++

    // Every 5 minutes, record prices and signals to database
    const shouldRecord = recordingCounter % 5 === 0
    if (shouldRecord && trackedSymbols.size > 0) {
      console.log(`📊 Recording prices and signals for ${trackedSymbols.size} symbols...`)

      // Record prices
      databaseService.recordPrices(updatedPrices)

      // Fetch and record signals for all tracked symbols
      const signalsToRecord = []
      for (const symbol of trackedSymbols) {
        try {
          const signal = await signalService.getSignal(symbol)
          if (signal) {
            signalsToRecord.push(signal)
          }
        } catch (err) {
          console.error(`Error fetching signal for ${symbol}:`, err)
        }
      }

      if (signalsToRecord.length > 0) {
        databaseService.recordSignals(signalsToRecord)
        console.log(`✅ Recorded ${signalsToRecord.length} signals`)
      }

      // Analyze signal performance (every 5 minutes)
      databaseService.analyzeSignalPerformance()
    }

    // Broadcast price updates to all clients
    console.log(`🔄 Starting price update broadcast to ${clientSessions.size} client(s)...`)

    let successCount = 0
    let skipCount = 0

    // Fetch 1-week-ago snapshot for Made Up Ground calculation (once for all clients)
    const { date: weekAgoDate, data: weekAgoSnapshot } = databaseService.getPnLSnapshotFromDaysAgo(7)

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
        if (weekAgoSnapshot.length > 0) {
          pnlData = enrichWithMadeUpGround(pnlData, weekAgoSnapshot)
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
      const firstSession = Array.from(clientSessions.values()).find(s => s.trades && s.trades.length > 0)

      if (firstSession) {
        // Only save snapshots when someone is actively viewing their portfolio
        const todayDate = new Date().toISOString().split('T')[0]
        console.log(`📊 Active session detected, updating snapshot for ${todayDate}`)
        const prices = { ...updatedPrices, ...firstSession.manualPrices }
        const adjustedTrades = applysplits(firstSession.trades, firstSession.splitAdjustments)
        const pnlData = calculatePnL(adjustedTrades, prices, true, null, null, firstSession.dividendsAndInterest || [])

        databaseService.savePnLSnapshot(todayDate, pnlData)
      }
      // No active sessions - don't create snapshots for dates without CSV uploads
    } catch (error) {
      console.error('Error saving snapshot:', error)
    }
  } catch (error) {
    console.error('Error updating prices:', error)
  }
}, 60000) // Every 1 minute

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

// Debug endpoint to see what snapshot dates exist
app.get('/api/debug/snapshot-dates', (req, res) => {
  try {
    const dates = databaseService.getSnapshotDates()
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
app.get('/api/debug/daily-pnl', (req, res) => {
  try {
    const dailyPnL = databaseService.getDailyPnLHistory()
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

// Debug endpoint to check pnl_snapshots table directly
app.get('/api/debug/snapshots-raw', (req, res) => {
  try {
    const debugInfo = databaseService.getSnapshotsDebugInfo()
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
app.delete('/api/snapshot/:date', (req, res) => {
  try {
    const { date } = req.params
    const deletedCount = databaseService.deletePnLSnapshot(date)
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
app.post('/api/robinhood/download', async (req, res) => {
  try {
    console.log('🤖 Received request to download from Robinhood')

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

const PORT = process.env.PORT || 3001
const HOST = '0.0.0.0' // Listen on all interfaces for Railway

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`)
  console.log(`📊 WebSocket server ready for connections`)
  console.log(`💰 Price updates every 1 minute`)
  console.log(`📈 Signal updates on-demand`)
})
