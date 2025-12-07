import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import multer from 'multer'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { parseTrades, parseDeposits } from './server/services/csvParser.js'
import { calculatePnL } from './server/services/pnlCalculator.js'
import { PriceService } from './server/services/priceService.js'
import { SignalService } from './server/services/signalService.js'
import { databaseService } from './server/services/database.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

// Serve static files from dist (frontend)
const distPath = join(__dirname, 'dist')
app.use(express.static(distPath))

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

  socket.on('upload-csv', async (csvContent, callback) => {
    try {
      console.log(`Processing CSV upload from ${socket.id}...`)

      // Parse trades and deposits
      const trades = await parseTrades(csvContent)
      const { deposits, totalPrincipal } = await parseDeposits(csvContent)

      // Extract unique stock symbols (exclude options)
      const allSymbols = [...new Set(trades.map(t => t.symbol))]
      const stockSymbols = allSymbols.filter(s => {
        return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
      })

      console.log(`Fetching prices for ${stockSymbols.length} symbols...`)

      // Fetch current prices
      const currentPrices = await priceService.getPrices(stockSymbols)

      // Set price to 0 for options
      allSymbols.forEach(symbol => {
        if (!currentPrices[symbol]) {
          currentPrices[symbol] = 0
        }
      })

      // Calculate P&L
      const pnlData = calculatePnL(trades, currentPrices)

      // Track these symbols for automatic updates
      stockSymbols.forEach(s => trackedSymbols.add(s))

      // Store session data
      clientSessions.set(socket.id, {
        trades,
        deposits,
        totalPrincipal,
        symbols: stockSymbols,
        manualPrices: {},
        splitAdjustments: {},
        lastActivity: Date.now()
      })

      console.log(`CSV processed successfully for ${socket.id}`)

      callback({
        success: true,
        trades,
        deposits,
        totalPrincipal,
        currentPrices,
        pnlData,
        failedSymbols: stockSymbols.filter(s => currentPrices[s] === 0),
        timestamp: new Date().toISOString()
      })
    } catch (error) {
      console.error('CSV upload error:', error)
      callback({
        success: false,
        error: error.message
      })
    }
  })

  socket.on('update-manual-price', ({ symbol, price }, callback) => {
    try {
      const session = clientSessions.get(socket.id)
      if (!session) {
        return callback({ success: false, error: 'No active session' })
      }

      session.manualPrices[symbol] = price
      session.lastActivity = Date.now()

      // Recalculate P&L with updated prices
      const currentPrices = { ...priceService.getCurrentPrices(), ...session.manualPrices }
      const pnlData = calculatePnL(session.trades, currentPrices)

      callback({ success: true, pnlData })
    } catch (error) {
      callback({ success: false, error: error.message })
    }
  })

  socket.on('update-split', ({ symbol, ratio }, callback) => {
    try {
      const session = clientSessions.get(socket.id)
      if (!session) {
        return callback({ success: false, error: 'No active session' })
      }

      session.splitAdjustments[symbol] = ratio
      session.lastActivity = Date.now()

      // Apply split adjustments
      const adjustedTrades = session.trades.map(trade => {
        if (session.splitAdjustments[trade.symbol]) {
          return {
            ...trade,
            price: trade.price / session.splitAdjustments[trade.symbol]
          }
        }
        return trade
      })

      // Recalculate P&L
      const currentPrices = { ...priceService.getCurrentPrices(), ...session.manualPrices }
      const pnlData = calculatePnL(adjustedTrades, currentPrices)

      callback({ success: true, pnlData })
    } catch (error) {
      callback({ success: false, error: error.message })
    }
  })

  socket.on('fetch-signals', async (symbols, callback) => {
    try {
      console.log(`Fetching signals for ${symbols.length} symbols...`)
      const signals = await signalService.getSignalsForSymbols(symbols)
      callback({ success: true, signals })
    } catch (error) {
      console.error('Signal fetch error:', error)
      callback({ success: false, error: error.message })
    }
  })

  socket.on('lookup-signal', async (symbol, callback) => {
    try {
      console.log(`Looking up signal for ${symbol}...`)
      const signal = await signalService.getSignal(symbol)
      callback({ success: true, signal })
    } catch (error) {
      console.error('Signal lookup error:', error)
      callback({ success: false, error: error.message })
    }
  })

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
  })
})

// Auto-refresh prices every 1 minute
setInterval(async () => {
  if (trackedSymbols.size === 0) return

  try {
    const symbols = Array.from(trackedSymbols)
    console.log(`Refreshing prices for ${symbols.length} symbols...`)

    const newPrices = await priceService.getPrices(symbols)

    // Broadcast to all connected clients
    for (const [socketId, session] of clientSessions.entries()) {
      const mergedPrices = { ...newPrices, ...session.manualPrices }

      // Apply split adjustments
      const adjustedTrades = session.trades.map(trade => {
        if (session.splitAdjustments[trade.symbol]) {
          return {
            ...trade,
            price: trade.price / session.splitAdjustments[trade.symbol]
          }
        }
        return trade
      })

      const pnlData = calculatePnL(adjustedTrades, mergedPrices)

      io.to(socketId).emit('price-update', {
        currentPrices: newPrices,
        pnlData,
        timestamp: new Date().toISOString()
      })

      session.lastActivity = Date.now()
    }
  } catch (error) {
    console.error('Price refresh error:', error)
  }
}, 60000) // 1 minute

// REST API endpoints
app.post('/api/upload-csv', upload.single('file'), async (req, res) => {
  try {
    const csvContent = req.file.buffer.toString('utf-8')
    const trades = await parseTrades(csvContent)
    const { deposits, totalPrincipal } = await parseDeposits(csvContent)

    const allSymbols = [...new Set(trades.map(t => t.symbol))]
    const stockSymbols = allSymbols.filter(s => {
      return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
    })

    const currentPrices = await priceService.getPrices(stockSymbols)

    allSymbols.forEach(symbol => {
      if (!currentPrices[symbol]) {
        currentPrices[symbol] = 0
      }
    })

    const pnlData = calculatePnL(trades, currentPrices)

    stockSymbols.forEach(s => trackedSymbols.add(s))

    res.json({
      trades,
      deposits,
      totalPrincipal,
      currentPrices,
      pnlData,
      failedSymbols: stockSymbols.filter(s => currentPrices[s] === 0),
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('Upload error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    mode: 'fullstack-production',
    clients: io.sockets.sockets.size,
    trackedSymbols: trackedSymbols.size,
    uptime: process.uptime()
  })
})

app.get('/api/symbols', (req, res) => {
  res.json({
    trackedSymbols: Array.from(trackedSymbols),
    count: trackedSymbols.size
  })
})

app.get('/api/prices', async (req, res) => {
  const { symbols } = req.query
  const symbolArray = symbols ? symbols.split(',') : []

  if (symbolArray.length === 0) {
    return res.json(priceService.getCurrentPrices())
  }

  const prices = await priceService.getPrices(symbolArray)
  res.json(prices)
})

// SPA fallback - serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'))
})

const PORT = process.env.PORT || 3001
const HOST = '0.0.0.0'

httpServer.listen(PORT, HOST, () => {
  console.log(`
🚀 Full-Stack Production Server Running
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 Frontend:  http://${HOST}:${PORT}
🔌 Backend:   WebSocket Active
🏥 Health:    http://${HOST}:${PORT}/api/health
💰 Price Updates: Every 1 minute
📈 Signals:   On-demand
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `)
})
