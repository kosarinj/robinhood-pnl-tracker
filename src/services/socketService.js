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

      this.socket.emit('lookup-signal', { symbol })

      this.socket.once('lookup-signal-result', (response) => {
        resolve(response.signal)
      })

      this.socket.once('lookup-signal-error', (response) => {
        reject(new Error(response.error))
      })

      // Timeout after 15 seconds
      setTimeout(() => {
        reject(new Error('Signal lookup timeout'))
      }, 15000)
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
      this.socket.emit('fetch-historical-data', { symbol, range, interval })

      this.socket.once('historical-data-result', (response) => {
        if (response.symbol === symbol) {
          console.log(`Received ${response.data.length} data points from server`)
          resolve(response.data)
        }
      })

      this.socket.once('historical-data-error', (response) => {
        if (response.symbol === symbol) {
          reject(new Error(response.error))
        }
      })

      // Timeout after 20 seconds
      setTimeout(() => {
        reject(new Error('Historical data fetch timeout'))
      }, 20000)
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

  // Remove listeners
  off(event, callback) {
    if (this.socket) {
      this.socket.off(event, callback)
    }
  }
}

// Export singleton instance
export const socketService = new SocketService()
