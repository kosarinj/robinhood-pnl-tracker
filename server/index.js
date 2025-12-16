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

      // Parse trades and deposits
      const trades = await parseTrades(csvContent)
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

      // Format as YYYY-MM-DD
      const asofDate = latestTradeDate.toISOString().split('T')[0]

      // Get historical prices for the asof_date (closing prices from that day)
      console.log(`📅 Fetching historical prices for ${asofDate}...`)
      const historicalPrices = await priceService.getPricesForDate(stockSymbols, asofDate)
      console.log(`✓ Fetched historical prices for ${Object.keys(historicalPrices).length} symbols`)

      // Calculate P&L using historical prices from the asof_date
      const pnlData = calculatePnL(trades, historicalPrices)

      // Save P&L snapshot to database with historical prices
      try {
        databaseService.savePnLSnapshot(asofDate, pnlData)
        console.log(`💾 Saved P&L snapshot for ${asofDate} with historical prices`)
      } catch (error) {
        console.error('Error saving P&L snapshot:', error)
      }

      // Save trades to database
      try {
        databaseService.saveTrades(trades, asofDate)
        console.log(`💾 Saved ${trades.length} trades to database for ${asofDate}`)
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
      const pnlDataWithBenchmarks = pnlData.map(position => {
        const benchmarks = databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
        return {
          ...position,
          benchmarks
        }
      })

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
          uploadDate: asofDate  // Add uploadDate to indicate viewing historical data
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
    const pnlData = calculatePnL(adjustedTrades, prices)

    socket.emit('pnl-update', { pnlData, currentPrices: prices })
  })

  // Handle split adjustments
  socket.on('update-split', async ({ symbol, ratio }) => {
    const session = clientSessions.get(socket.id)
    if (!session) return

    session.splitAdjustments[symbol] = parseFloat(ratio)

    // Recalculate P&L with splits
    const prices = { ...priceService.getCurrentPrices(), ...session.manualPrices }
    const adjustedTrades = applysplits(session.trades, session.splitAdjustments)
    const pnlData = calculatePnL(adjustedTrades, prices)

    socket.emit('pnl-update', { pnlData, currentPrices: prices })
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
        const pnlData = calculatePnL(trades, historicalPrices)

        // Get price benchmarks for each position
        const pnlDataWithBenchmarks = pnlData.map(position => {
          const benchmarks = databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
          return {
            ...position,
            benchmarks
          }
        })

        socket.emit('latest-trades-result', {
          success: true,
          trades,
          uploadDate,
          deposits: [],
          totalPrincipal: 0,
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
      const pnlData = calculatePnL(trades, historicalPrices)

      // Get price benchmarks for each position
      const pnlDataWithBenchmarks = pnlData.map(position => {
        const benchmarks = databaseService.getPriceBenchmarks(position.symbol, position.currentPrice, 0.05)
        return {
          ...position,
          benchmarks
        }
      })

      socket.emit('trades-loaded', {
        success: true,
        uploadDate,
        trades,
        deposits: [],
        totalPrincipal: 0,
        currentPrices: historicalPrices,
        pnlData: pnlDataWithBenchmarks
      })
    } catch (error) {
      console.error(`❌ Error loading trades:`, error)
      socket.emit('trades-loaded', { success: false, error: error.message })
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
    for (const [socketId, session] of clientSessions.entries()) {
      const socket = io.sockets.sockets.get(socketId)
      if (!socket) continue

      // Merge with manual prices
      const prices = { ...updatedPrices, ...session.manualPrices }

      // Recalculate P&L with new prices
      const adjustedTrades = applysplits(session.trades, session.splitAdjustments)
      const pnlData = calculatePnL(adjustedTrades, prices)

      socket.emit('price-update', {
        currentPrices: prices,
        pnlData,
        timestamp: new Date()
      })
    }

    console.log(`Price update broadcast to ${clientSessions.size} clients`)
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

app.get('/prices', async (req, res) => {
  const { symbols } = req.query
  const symbolArray = symbols ? symbols.split(',') : []

  if (symbolArray.length === 0) {
    return res.json(priceService.getCurrentPrices())
  }

  const prices = await priceService.getPrices(symbolArray)
  res.json(prices)
})

const PORT = process.env.PORT || 3001
const HOST = '0.0.0.0' // Listen on all interfaces for Railway

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`)
  console.log(`📊 WebSocket server ready for connections`)
  console.log(`💰 Price updates every 1 minute`)
  console.log(`📈 Signal updates on-demand`)
})
