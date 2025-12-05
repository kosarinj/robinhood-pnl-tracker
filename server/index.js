import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import multer from 'multer'
import { parseTrades, parseDeposits } from './services/csvParser.js'
import { calculatePnL } from './services/pnlCalculator.js'
import { PriceService } from './services/priceService.js'
import { SignalService } from './services/signalService.js'

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

// Store client sessions (in-memory, stateless)
const clientSessions = new Map()

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
        manualPrices: {}
      })

      // Register symbols for price tracking
      priceService.addSymbols(stockSymbols)

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
setInterval(async () => {
  try {
    const updatedPrices = await priceService.refreshPrices()

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

// REST API endpoints (optional, for HTTP access)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    clients: clientSessions.size,
    trackedSymbols: priceService.getTrackedSymbols().length,
    uptime: process.uptime()
  })
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

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📊 WebSocket server ready for connections`)
  console.log(`💰 Price updates every 1 minute`)
  console.log(`📈 Signal updates on-demand`)
})
