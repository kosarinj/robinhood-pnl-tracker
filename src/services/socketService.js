import { io } from 'socket.io-client'

class SocketService {
  constructor() {
    this.socket = null
    this.connected = false
    // Use environment variable if set, otherwise use production URL if not localhost, otherwise localhost
    const envUrl = import.meta.env.VITE_SERVER_URL
    const isProduction = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
    this.serverUrl = envUrl || (isProduction ? 'https://robinhood-pnl-tracker-production-805d.up.railway.app' : 'http://localhost:3001')
    console.log('🔧 Socket Service Config:', {
      envUrl,
      hostname: window.location.hostname,
      isProduction,
      serverUrl: this.serverUrl
    })
  }

  // Connect to server
  connect() {
    if (this.socket && this.connected) {
      console.log('Already connected to server')
      return this.socket
    }

    console.log(`Connecting to server at ${this.serverUrl}...`)
    this.socket = io(this.serverUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    })

    this.socket.on('connect', () => {
      this.connected = true
      console.log('✅ Connected to server:', this.socket.id)
    })

    this.socket.on('disconnect', () => {
      this.connected = false
      console.log('❌ Disconnected from server')
    })

    this.socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error.message)
      console.error('Error details:', error)
    })

    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`🔄 Reconnection attempt ${attemptNumber}...`)
    })

    this.socket.on('reconnect_failed', () => {
      console.error('❌ Reconnection failed after all attempts')
    })

    return this.socket
  }

  // Disconnect from server
  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
      this.connected = false
    }
  }

  // Check if connected
  isConnected() {
    return this.connected
  }

  // Upload CSV
  uploadCSV(csvContent) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      this.socket.emit('upload-csv', { csvContent })

      this.socket.once('csv-processed', (response) => {
        if (response.success) {
          resolve(response.data)
        } else {
          reject(new Error(response.error))
        }
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        reject(new Error('CSV upload timeout'))
      }, 30000)
    })
  }

  // Update manual price
  updateManualPrice(symbol, price) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to server')
    }
    this.socket.emit('update-manual-price', { symbol, price })
  }

  // Update split adjustment
  updateSplit(symbol, ratio) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to server')
    }
    this.socket.emit('update-split', { symbol, ratio })
  }

  // Request trading signals
  requestSignals(symbols) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to server')
    }
    this.socket.emit('request-signals', { symbols })
  }

  // Lookup single symbol signal
  lookupSignal(symbol) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('lookup-signal-result', resultHandler)
        this.socket.off('lookup-signal-error', errorHandler)
        clearTimeout(timeoutId)
        resolve(response.signal)
      }

      const errorHandler = (response) => {
        this.socket.off('lookup-signal-result', resultHandler)
        this.socket.off('lookup-signal-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('lookup-signal-result', resultHandler)
      this.socket.on('lookup-signal-error', errorHandler)

      this.socket.emit('lookup-signal', { symbol })

      // Timeout after 15 seconds
      const timeoutId = setTimeout(() => {
        this.socket.off('lookup-signal-result', resultHandler)
        this.socket.off('lookup-signal-error', errorHandler)
        reject(new Error('Signal lookup timeout'))
      }, 15000)
    })
  }

  // Get available snapshot dates
  getSnapshotDates() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('snapshot-dates-result', resultHandler)
        this.socket.off('snapshot-dates-error', errorHandler)
        resolve(response.dates)
      }

      const errorHandler = (response) => {
        this.socket.off('snapshot-dates-result', resultHandler)
        this.socket.off('snapshot-dates-error', errorHandler)
        reject(new Error(response.error))
      }

      this.socket.on('snapshot-dates-result', resultHandler)
      this.socket.on('snapshot-dates-error', errorHandler)
      this.socket.emit('get-snapshot-dates')

      setTimeout(() => {
        this.socket.off('snapshot-dates-result', resultHandler)
        this.socket.off('snapshot-dates-error', errorHandler)
        reject(new Error('Get snapshot dates timeout'))
      }, 10000)
    })
  }

  // Debug: Query pnl_snapshots table directly
  debugSnapshotsRaw() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('debug-snapshots-result', resultHandler)
        clearTimeout(timeoutId)
        if (response.success) {
          resolve(response)
        } else {
          reject(new Error(response.error || 'Unknown error'))
        }
      }

      this.socket.on('debug-snapshots-result', resultHandler)
      this.socket.emit('debug-snapshots-raw')

      const timeoutId = setTimeout(() => {
        this.socket.off('debug-snapshots-result', resultHandler)
        reject(new Error('Debug snapshots timeout'))
      }, 10000)
    })
  }

  // Load P&L snapshot
  loadPnLSnapshot(asofDate) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      console.log(`Loading P&L snapshot for ${asofDate}...`)

      const resultHandler = (response) => {
        this.socket.off('pnl-snapshot-loaded', resultHandler)
        if (response.success) {
          console.log(`✅ Loaded P&L snapshot for ${asofDate}`)
          resolve(response.data)
        } else {
          reject(new Error(response.error))
        }
      }

      this.socket.on('pnl-snapshot-loaded', resultHandler)
      this.socket.emit('load-pnl-snapshot', { asofDate })

      setTimeout(() => {
        this.socket.off('pnl-snapshot-loaded', resultHandler)
        reject(new Error('Load snapshot timeout'))
      }, 10000)
    })
  }

  // Get latest saved trades
  getLatestTrades() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('latest-trades-result', resultHandler)
        this.socket.off('latest-trades-error', errorHandler)
        clearTimeout(timeoutId)
        resolve(response)
      }

      const errorHandler = (response) => {
        this.socket.off('latest-trades-result', resultHandler)
        this.socket.off('latest-trades-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('latest-trades-result', resultHandler)
      this.socket.on('latest-trades-error', errorHandler)
      this.socket.emit('get-latest-trades')

      const timeoutId = setTimeout(() => {
        this.socket.off('latest-trades-result', resultHandler)
        this.socket.off('latest-trades-error', errorHandler)
        reject(new Error('Get latest trades timeout'))
      }, 10000)
    })
  }

  // Get all upload dates
  getUploadDates() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('upload-dates-result', resultHandler)
        this.socket.off('upload-dates-error', errorHandler)
        clearTimeout(timeoutId)
        resolve(response.dates)
      }

      const errorHandler = (response) => {
        this.socket.off('upload-dates-result', resultHandler)
        this.socket.off('upload-dates-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('upload-dates-result', resultHandler)
      this.socket.on('upload-dates-error', errorHandler)
      this.socket.emit('get-upload-dates')

      const timeoutId = setTimeout(() => {
        this.socket.off('upload-dates-result', resultHandler)
        this.socket.off('upload-dates-error', errorHandler)
        reject(new Error('Get upload dates timeout'))
      }, 10000)
    })
  }

  // Load trades for a specific date
  loadTrades(uploadDate) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('trades-loaded', resultHandler)
        clearTimeout(timeoutId)
        if (response.success) {
          resolve(response)
        } else {
          reject(new Error(response.error))
        }
      }

      this.socket.on('trades-loaded', resultHandler)
      this.socket.emit('load-trades', { uploadDate })

      const timeoutId = setTimeout(() => {
        this.socket.off('trades-loaded', resultHandler)
        reject(new Error('Load trades timeout'))
      }, 10000)
    })
  }

  // Analyze signal performance manually
  analyzeSignalPerformance() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('signal-performance-result', resultHandler)
        this.socket.off('signal-performance-error', errorHandler)
        clearTimeout(timeoutId)
        resolve(response)
      }

      const errorHandler = (response) => {
        this.socket.off('signal-performance-result', resultHandler)
        this.socket.off('signal-performance-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('signal-performance-result', resultHandler)
      this.socket.on('signal-performance-error', errorHandler)
      this.socket.emit('analyze-signal-performance')

      const timeoutId = setTimeout(() => {
        this.socket.off('signal-performance-result', resultHandler)
        this.socket.off('signal-performance-error', errorHandler)
        reject(new Error('Analyze signal performance timeout'))
      }, 30000)
    })
  }

  // Fetch historical price data
  fetchHistoricalData(symbol, range = '6mo', interval = '1d') {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      console.log(`Requesting historical data from server for ${symbol}...`)

      let resolved = false

      const resultHandler = (response) => {
        if (response.symbol === symbol && !resolved) {
          resolved = true
          console.log(`✅ Received ${response.data.length} data points from server for ${symbol}`)
          this.socket.off('historical-data-result', resultHandler)
          this.socket.off('historical-data-error', errorHandler)
          clearTimeout(timeoutId)
          resolve(response.data)
        }
      }

      const errorHandler = (response) => {
        if (response.symbol === symbol && !resolved) {
          resolved = true
          console.error(`❌ Error from server for ${symbol}:`, response.error)
          this.socket.off('historical-data-result', resultHandler)
          this.socket.off('historical-data-error', errorHandler)
          clearTimeout(timeoutId)
          reject(new Error(response.error))
        }
      }

      this.socket.on('historical-data-result', resultHandler)
      this.socket.on('historical-data-error', errorHandler)

      this.socket.emit('fetch-historical-data', { symbol, range, interval })

      // Timeout after 15 seconds
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          console.error(`⏱️ Historical data fetch timeout for ${symbol}`)
          this.socket.off('historical-data-result', resultHandler)
          this.socket.off('historical-data-error', errorHandler)
          reject(new Error('Historical data fetch timeout - server may be slow or unavailable'))
        }
      }, 15000)
    })
  }

  // Listen for price updates
  onPriceUpdate(callback) {
    if (this.socket) {
      this.socket.on('price-update', callback)
    }
  }

  // Listen for P&L updates
  onPnLUpdate(callback) {
    if (this.socket) {
      this.socket.on('pnl-update', callback)
    }
  }

  // Listen for signals update
  onSignalsUpdate(callback) {
    if (this.socket) {
      this.socket.on('signals-update', callback)
    }
  }

  // Clear all saved data from database
  clearDatabase() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('database-cleared', resultHandler)
        clearTimeout(timeoutId)
        if (response.success) {
          resolve()
        } else {
          reject(new Error(response.error))
        }
      }

      this.socket.on('database-cleared', resultHandler)
      this.socket.emit('clear-database')

      const timeoutId = setTimeout(() => {
        this.socket.off('database-cleared', resultHandler)
        reject(new Error('Clear database timeout'))
      }, 10000)
    })
  }

  // Get daily P&L history for charting
  getDailyPnLHistory() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('daily-pnl-result', resultHandler)
        this.socket.off('daily-pnl-error', errorHandler)
        clearTimeout(timeoutId)
        if (response.success) {
          resolve(response.data)
        } else {
          reject(new Error(response.error))
        }
      }

      const errorHandler = (response) => {
        this.socket.off('daily-pnl-result', resultHandler)
        this.socket.off('daily-pnl-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('daily-pnl-result', resultHandler)
      this.socket.on('daily-pnl-error', errorHandler)
      this.socket.emit('get-daily-pnl')

      const timeoutId = setTimeout(() => {
        this.socket.off('daily-pnl-result', resultHandler)
        this.socket.off('daily-pnl-error', errorHandler)
        reject(new Error('Get daily P&L timeout'))
      }, 10000)
    })
  }

  // Get symbol-specific daily P&L with price
  getSymbolDailyPnL(symbol) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        if (response.symbol === symbol) {
          this.socket.off('symbol-pnl-result', resultHandler)
          this.socket.off('symbol-pnl-error', errorHandler)
          clearTimeout(timeoutId)
          if (response.success) {
            resolve(response.data)
          } else {
            reject(new Error(response.error))
          }
        }
      }

      const errorHandler = (response) => {
        this.socket.off('symbol-pnl-result', resultHandler)
        this.socket.off('symbol-pnl-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('symbol-pnl-result', resultHandler)
      this.socket.on('symbol-pnl-error', errorHandler)
      this.socket.emit('get-symbol-pnl', { symbol })

      const timeoutId = setTimeout(() => {
        this.socket.off('symbol-pnl-result', resultHandler)
        this.socket.off('symbol-pnl-error', errorHandler)
        reject(new Error('Get symbol P&L timeout'))
      }, 10000)
    })
  }

  // Get list of symbols with snapshot data
  getSymbolsList() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to server'))
        return
      }

      const resultHandler = (response) => {
        this.socket.off('symbols-list-result', resultHandler)
        this.socket.off('symbols-list-error', errorHandler)
        clearTimeout(timeoutId)
        if (response.success) {
          resolve(response.data)
        } else {
          reject(new Error(response.error))
        }
      }

      const errorHandler = (response) => {
        this.socket.off('symbols-list-result', resultHandler)
        this.socket.off('symbols-list-error', errorHandler)
        clearTimeout(timeoutId)
        reject(new Error(response.error))
      }

      this.socket.on('symbols-list-result', resultHandler)
      this.socket.on('symbols-list-error', errorHandler)
      this.socket.emit('get-symbols-list')

      const timeoutId = setTimeout(() => {
        this.socket.off('symbols-list-result', resultHandler)
        this.socket.off('symbols-list-error', errorHandler)
        reject(new Error('Get symbols list timeout'))
      }, 10000)
    })
  }

  // Remove listeners
  off(event, callback) {
    if (this.socket) {
      this.socket.off(event, callback)
    }
  }
}

// Export singleton instance
export const socketService = new SocketService()
