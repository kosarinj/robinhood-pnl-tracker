import { io } from 'socket.io-client'

class SocketService {
  constructor() {
    this.socket = null
    this.connected = false
    this.serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'
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
      console.error('Connection error:', error.message)
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
