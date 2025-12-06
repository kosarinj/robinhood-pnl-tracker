import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import multer from 'multer'
import { parseTrades, parseDeposits } from './services/csvParser.js'
import { calculatePnL } from './services/pnlCalculator.js'
import { PriceService } from './services/priceService.js'
import { SignalService } from './services/signalService.js'
import { databaseService } from './services/database.js'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

// Middleware
app.use(cors())
app.use(express.json())

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() })

// Services
const priceService = new PriceService()
const signalService = new SignalService()

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

      // Get initial prices
      const prices = await priceService.getPrices(stockSymbols)

      // Calculate initial P&L
      const pnlData = calculatePnL(trades, prices)

      // Send initial data
      socket.emit('csv-processed', {
        success: true,
        data: {
          trades,
          pnlData,
          totalPrincipal,
          deposits,
          currentPrices: prices
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
    version: '1.0.0',
    endpoints: {
      health: '/health',
      prices: '/prices?symbols=AAPL,GOOGL'
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
