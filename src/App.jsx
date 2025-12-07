import React, { useState, useEffect } from 'react'
import CSVUpload from './components/CSVUpload'
import TradesTable from './components/TradesTable'
import TradingSignals from './components/TradingSignals'
import MarketAnalysis from './components/MarketAnalysis'
import { parseTrades, parseDeposits } from './utils/csvParser'
import { calculatePnL } from './utils/pnlCalculator'
import { fetchCurrentPrices } from './utils/yahooFinance'
import { getIntradayData } from './utils/marketData'
import { generateSignal } from './utils/technicalAnalysis'
import { socketService } from './services/socketService'

function App() {
  const [trades, setTrades] = useState([])
  const [pnlData, setPnlData] = useState([])
  const [includeOptions, setIncludeOptions] = useState(false)
  const [showOpenOnly, setShowOpenOnly] = useState(true)
  const [symbolFilter, setSymbolFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [manualPrices, setManualPrices] = useState({})
  const [currentPrices, setCurrentPrices] = useState({})
  const [splitAdjustments, setSplitAdjustments] = useState({})
  const [failedSymbols, setFailedSymbols] = useState([])
  const [showSignals, setShowSignals] = useState(false)
  const [visiblePnlColumns, setVisiblePnlColumns] = useState({
    real: true,
    avgCost: false,
    fifo: true,
    lifo: true
  })
  const [lastPriceUpdate, setLastPriceUpdate] = useState(null)
  const [tradingSignals, setTradingSignals] = useState([])
  const [signalFilter, setSignalFilter] = useState({
    BUY: true,
    SELL: true,
    HOLD: true
  })
  const [pnlTotals, setPnlTotals] = useState(null)
  const [showPnlSummary, setShowPnlSummary] = useState(true)
  const [signalFetchingEnabled, setSignalFetchingEnabled] = useState(false)
  const [showSymbolLookup, setShowSymbolLookup] = useState(false)
  const [lookupSymbol, setLookupSymbol] = useState('')
  const [lookupSignal, setLookupSignal] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState(null)
  const [totalPrincipal, setTotalPrincipal] = useState(0)
  const [deposits, setDeposits] = useState([])
  const [pnlPercentages, setPnlPercentages] = useState({
    realizedPercent: 0,
    unrealizedPercent: 0,
    totalPercent: 0
  })
  const [showChartsInHistory, setShowChartsInHistory] = useState(false)
  const [connected, setConnected] = useState(false)
  const [useServer, setUseServer] = useState(true) // Toggle between server and standalone mode
  const [showMarketAnalysis, setShowMarketAnalysis] = useState(false)
  const [showRiskManagement, setShowRiskManagement] = useState(false)
  const [riskAllocations, setRiskAllocations] = useState({})
  const [totalRiskBudget, setTotalRiskBudget] = useState(10000) // Default $10k risk budget

  // Connect to server on mount
  useEffect(() => {
    if (!useServer) return

    console.log('Connecting to WebSocket server...')
    socketService.connect()

    // Listen for connection status
    socketService.socket.on('connect', () => {
      setConnected(true)
      console.log('✅ Connected to server')
    })

    socketService.socket.on('disconnect', () => {
      setConnected(false)
      console.log('❌ Disconnected from server')
    })

    // Listen for price updates from server
    socketService.onPriceUpdate((data) => {
      console.log('📈 Received price update from server')
      setCurrentPrices(data.currentPrices)
      setPnlData(data.pnlData)
      setLastPriceUpdate(new Date(data.timestamp))
    })

    // Listen for P&L updates
    socketService.onPnLUpdate((data) => {
      console.log('💰 Received P&L update from server')
      setPnlData(data.pnlData)
    })

    // Cleanup on unmount
    return () => {
      socketService.disconnect()
    }
  }, [useServer])

  const handleManualPriceUpdate = (symbol, price) => {
    const updatedManualPrices = { ...manualPrices, [symbol]: parseFloat(price) }
    setManualPrices(updatedManualPrices)

    // Send to server if connected
    if (useServer && connected) {
      socketService.updateManualPrice(symbol, parseFloat(price))
    } else {
      // Standalone mode: recalculate locally
      if (trades.length > 0) {
        const mergedPrices = { ...currentPrices, ...updatedManualPrices }
        const adjustedTrades = applySplitAdjustments(trades, splitAdjustments)
        const pnl = calculatePnL(adjustedTrades, mergedPrices, true) // Always rollup options
        setPnlData(pnl)
      }
    }
  }

  const handleClearManualPrice = (symbol) => {
    const updatedManualPrices = { ...manualPrices }
    delete updatedManualPrices[symbol]
    setManualPrices(updatedManualPrices)

    // Recalculate P&L with updated prices
    if (trades.length > 0) {
      const mergedPrices = { ...currentPrices, ...updatedManualPrices }
      const adjustedTrades = applySplitAdjustments(trades, splitAdjustments)
      const pnl = calculatePnL(adjustedTrades, mergedPrices, true) // Always rollup options
      setPnlData(pnl)
    }
  }

  const handleSplitAdjustment = (symbol, ratio) => {
    const updatedSplits = { ...splitAdjustments, [symbol]: parseFloat(ratio) }
    setSplitAdjustments(updatedSplits)

    // Send to server if connected
    if (useServer && connected) {
      socketService.updateSplit(symbol, parseFloat(ratio))
    } else {
      // Standalone mode: recalculate locally
      if (trades.length > 0) {
        const mergedPrices = { ...currentPrices, ...manualPrices }
        const adjustedTrades = applySplitAdjustments(trades, updatedSplits)
        const pnl = calculatePnL(adjustedTrades, mergedPrices, true) // Always rollup options
        setPnlData(pnl)
      }
    }
  }

  const handleClearSplitAdjustment = (symbol) => {
    const updatedSplits = { ...splitAdjustments }
    delete updatedSplits[symbol]
    setSplitAdjustments(updatedSplits)

    // Recalculate P&L
    if (trades.length > 0) {
      const mergedPrices = { ...currentPrices, ...manualPrices }
      const adjustedTrades = applySplitAdjustments(trades, updatedSplits)
      const pnl = calculatePnL(adjustedTrades, mergedPrices, true) // Always rollup options
      setPnlData(pnl)
    }
  }

  const handleRiskAllocationUpdate = (symbol, amount) => {
    const updatedAllocations = { ...riskAllocations, [symbol]: parseFloat(amount) }
    setRiskAllocations(updatedAllocations)
    console.log(`Risk allocation for ${symbol} set to ${amount}`)
  }

  const applySplitAdjustments = (trades, splits) => {
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

  const refreshPrices = async () => {
    if (trades.length === 0) return

    console.log('Refreshing prices...')

    // Get unique symbols (exclude options)
    const allSymbols = [...new Set(trades.map(t => t.symbol))]
    const stockSymbols = allSymbols.filter(s => {
      return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
    })

    // Fetch current prices
    const fetchedPrices = await fetchCurrentPrices(stockSymbols)

    // Track failed symbols
    const failed = stockSymbols.filter(s => fetchedPrices[s] === 0)
    setFailedSymbols(failed)

    // Set price to 0 for options
    allSymbols.forEach(symbol => {
      if (!fetchedPrices[symbol]) {
        fetchedPrices[symbol] = 0
      }
    })

    // Merge with manual overrides
    const mergedPrices = { ...fetchedPrices, ...manualPrices }
    setCurrentPrices(fetchedPrices)

    // Recalculate P&L
    const adjustedTrades = applySplitAdjustments(trades, splitAdjustments)
    const pnl = calculatePnL(adjustedTrades, mergedPrices, true) // Always rollup options
    setPnlData(pnl)

    setLastPriceUpdate(new Date())
    console.log('Prices refreshed')
  }

  const handleSymbolLookup = async () => {
    if (!lookupSymbol.trim()) {
      setLookupError('Please enter a symbol')
      return
    }

    setLookupLoading(true)
    setLookupError(null)
    setLookupSignal(null)

    try {
      const symbol = lookupSymbol.trim().toUpperCase()
      console.log(`Fetching signal for ${symbol}...`)

      if (useServer && connected) {
        // SERVER MODE: Use server's lookup-signal endpoint
        const signal = await socketService.lookupSignal(symbol)

        setLookupSignal(signal)
        console.log(`✓ Signal received from server for ${symbol}`)
      } else {
        // STANDALONE MODE: Fetch locally
        // Fetch current price
        const prices = await fetchCurrentPrices([symbol])
        const currentPrice = prices[symbol]

        if (!currentPrice || currentPrice === 0) {
          throw new Error('Could not fetch current price for symbol')
        }

        // Fetch historical data
        const historicalData = await getIntradayData(symbol)

        if (!historicalData || historicalData.length === 0) {
          throw new Error('No historical data available for this symbol')
        }

        // Generate signal
        const signal = generateSignal(symbol, currentPrice, historicalData)

        setLookupSignal({
          ...signal,
          currentPrice
        })

        console.log(`✓ Signal generated for ${symbol}`)
      }
    } catch (error) {
      console.error('Error fetching signal:', error)
      setLookupError(error.message || 'Failed to fetch trading signal')
    } finally {
      setLookupLoading(false)
    }
  }

  const closeLookup = () => {
    setShowSymbolLookup(false)
    setLookupSymbol('')
    setLookupSignal(null)
    setLookupError(null)
  }

  // Calculate time-weighted P&L percentages based on principal at time of trades
  const calculatePnlPercentages = (trades, deposits, pnlTotals) => {
    if (!deposits || deposits.length === 0 || !pnlTotals) {
      return { realizedPercent: 0, unrealizedPercent: 0, totalPercent: 0 }
    }

    // Build cumulative principal timeline
    let cumulativePrincipal = 0
    const principalTimeline = deposits.map(deposit => {
      cumulativePrincipal += deposit.amount
      return {
        date: deposit.date,
        cumulativePrincipal
      }
    })

    // Function to get principal at a specific date
    const getPrincipalAtDate = (date) => {
      // Find the cumulative principal up to this date
      let principal = 0
      for (const entry of principalTimeline) {
        if (entry.date <= date) {
          principal = entry.cumulativePrincipal
        } else {
          break
        }
      }
      return principal > 0 ? principal : principalTimeline[0]?.cumulativePrincipal || 0
    }

    // For realized P&L: calculate weighted average based on when trades occurred
    const sellTrades = trades.filter(t => !t.isBuy)

    if (sellTrades.length > 0) {
      // Calculate average principal during the trading period
      const tradeDates = sellTrades.map(t => t.date)
      const avgPrincipal = tradeDates.reduce((sum, date) => {
        return sum + getPrincipalAtDate(date)
      }, 0) / tradeDates.length

      const realizedPercent = avgPrincipal > 0
        ? (pnlTotals.realRealized / avgPrincipal) * 100
        : 0

      // For unrealized P&L: use current total principal
      const unrealizedPercent = cumulativePrincipal > 0
        ? (pnlTotals.realUnrealized / cumulativePrincipal) * 100
        : 0

      // For total P&L: weighted combination
      const totalPercent = (realizedPercent * Math.abs(pnlTotals.realRealized) +
                           unrealizedPercent * Math.abs(pnlTotals.realUnrealized)) /
                           (Math.abs(pnlTotals.realRealized) + Math.abs(pnlTotals.realUnrealized) || 1)

      return { realizedPercent, unrealizedPercent, totalPercent }
    } else {
      // No sells yet, only unrealized
      const unrealizedPercent = cumulativePrincipal > 0
        ? (pnlTotals.realUnrealized / cumulativePrincipal) * 100
        : 0

      return {
        realizedPercent: 0,
        unrealizedPercent,
        totalPercent: unrealizedPercent
      }
    }
  }

  // Note: Options are always rolled up into their underlying instruments
  // The "Include Other Instruments" toggle only affects filtering, not rollup behavior

  // Calculate P&L percentages when data changes
  useEffect(() => {
    if (trades.length > 0 && deposits.length > 0 && pnlTotals) {
      const percentages = calculatePnlPercentages(trades, deposits, pnlTotals)
      setPnlPercentages(percentages)
      console.log('P&L Percentages:', percentages)
    }
  }, [trades, deposits, pnlTotals])

  // Auto-refresh prices every 1 minute (STANDALONE MODE ONLY)
  useEffect(() => {
    // Skip auto-refresh in server mode (server pushes updates)
    if (useServer) return
    if (trades.length === 0) return

    // Set up interval for auto-refresh
    const interval = setInterval(() => {
      refreshPrices()
    }, 60000) // 1 minute = 60000ms

    // Clean up on unmount
    return () => clearInterval(interval)
  }, [trades, manualPrices, splitAdjustments, useServer])

  const handleFileUpload = async (file) => {
    try {
      setLoading(true)
      setError(null)

      if (useServer && connected) {
        // SERVER MODE: Upload CSV to server via WebSocket
        console.log('📤 Uploading CSV to server...')

        // Read file as text
        const csvContent = await file.text()

        // Upload to server
        const response = await socketService.uploadCSV(csvContent)

        console.log('✅ CSV processed by server')

        // Set state from server response
        setTrades(response.trades)
        setDeposits(response.deposits)
        setTotalPrincipal(response.totalPrincipal)
        setCurrentPrices(response.currentPrices)
        setPnlData(response.pnlData)
        setFailedSymbols(response.failedSymbols || [])
        setLastPriceUpdate(new Date(response.timestamp))

        console.log(`Server response: ${response.pnlData.length} symbols, principal: ${response.totalPrincipal}`)

      } else {
        // STANDALONE MODE: Process locally (original logic)
        console.log('💻 Processing CSV locally (standalone mode)...')

        // Parse CSV file for trades
        const parsedTrades = await parseTrades(file)
        setTrades(parsedTrades)

        // Parse CSV file for deposits to calculate principal
        const { deposits: parsedDeposits, totalPrincipal: principal } = await parseDeposits(file)
        setDeposits(parsedDeposits)
        setTotalPrincipal(principal)
        console.log(`Total principal from ACH deposits: ${principal}`)
        console.log(`Deposits timeline:`, parsedDeposits)

        // Get unique symbols (exclude options - they use full descriptions as symbols)
        const allSymbols = [...new Set(parsedTrades.map(t => t.symbol))]
        const stockSymbols = allSymbols.filter(s => {
          // Options will have spaces, dates, "Put", "Call" in the symbol
          return !s.includes(' ') && !s.includes('Put') && !s.includes('Call')
        })

        console.log(`Total symbols: ${allSymbols.length}, Stock symbols to fetch: ${stockSymbols.length}`)

        // Fetch current prices from Yahoo Finance (only for stocks, not options)
        const fetchedPrices = await fetchCurrentPrices(stockSymbols)

        // Track failed symbols (stocks that got $0 price)
        const failed = stockSymbols.filter(s => fetchedPrices[s] === 0)
        setFailedSymbols(failed)

        // Set price to 0 for options (they don't need current market prices)
        allSymbols.forEach(symbol => {
          if (!fetchedPrices[symbol]) {
            fetchedPrices[symbol] = 0
          }
        })

        // Merge fetched prices with manual overrides
        const mergedPrices = { ...fetchedPrices, ...manualPrices }
        setCurrentPrices(fetchedPrices)

        // Apply split adjustments to trades
        const adjustedTrades = applySplitAdjustments(parsedTrades, splitAdjustments)

        // Calculate P&L with both FIFO and LIFO
        // Options are always rolled up into their underlying instruments
        const pnl = calculatePnL(adjustedTrades, mergedPrices, true)
        setPnlData(pnl)

        // Set initial price update timestamp
        setLastPriceUpdate(new Date())

        // Debug: Log all symbols found
        console.log('Total symbols found:', pnl.length)
        console.log('All symbols:', pnl.map(p => p.symbol).sort().join(', '))
      }

      setLoading(false)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  let filteredData = pnlData

  // Filter by options/rollups
  // Since options are always rolled up into parent instruments,
  // we filter out the rolled-up parent rows when "Include Other Instruments" is unchecked
  if (!includeOptions) {
    filteredData = filteredData.filter(item => !item.isOption && !item.isRollup)
  }

  // Filter by open positions only
  if (showOpenOnly) {
    filteredData = filteredData.filter(item => item.avgCost.position > 0)
  }

  // Filter by symbol search
  if (symbolFilter.trim()) {
    filteredData = filteredData.filter(item =>
      item.symbol.toLowerCase().includes(symbolFilter.toLowerCase())
    )
  }

  // Filter by signal type
  if (tradingSignals.length > 0) {
    const activeSignalTypes = Object.keys(signalFilter).filter(key => signalFilter[key])
    if (activeSignalTypes.length > 0 && activeSignalTypes.length < 3) {
      filteredData = filteredData.filter(item => {
        const signal = tradingSignals.find(s => s.symbol === item.symbol)
        if (!signal) return true // Show items without signals
        return activeSignalTypes.includes(signal.signal)
      })
    }
  }

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2
    }).format(value)
  }

  const getClassName = (value) => {
    if (value > 0) return 'positive'
    if (value < 0) return 'negative'
    return ''
  }

  return (
    <div className="app-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ margin: 0 }}>Robinhood P&L Tracker</h1>
        <label className="upload-button">
          📁 Upload CSV
          <input
            type="file"
            accept=".csv"
            onChange={(e) => {
              const file = e.target.files[0]
              if (file) handleFileUpload(file)
            }}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      {error && (
        <div className="error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {loading && (
        <div className="loading">
          Processing trades and fetching market data...
        </div>
      )}

      {failedSymbols.length > 0 && !loading && (
        <div className="error" style={{ background: '#fff3cd', color: '#856404', borderColor: '#ffeaa7' }}>
          <strong>⚠ Price Fetch Failed for {failedSymbols.length} symbol(s):</strong> {failedSymbols.join(', ')}
          <br />
          <small>These symbols show $0.00. Use the "Edit" button to manually enter prices.</small>
        </div>
      )}

      {useServer && (
        <div style={{
          padding: '10px 20px',
          background: connected ? '#d4edda' : '#f8d7da',
          borderRadius: '8px',
          marginBottom: '15px',
          fontSize: '14px',
          color: connected ? '#155724' : '#721c24',
          textAlign: 'center',
          fontWeight: '500',
          border: `1px solid ${connected ? '#c3e6cb' : '#f5c6cb'}`
        }}>
          {connected ? '✅ Connected to server - Real-time updates enabled' : '⚠️ Not connected to server - Check if server is running'}
        </div>
      )}

      {/* Lookup Symbol Signal & Market Analysis - Always visible */}
      <div style={{ textAlign: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '15px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setShowSymbolLookup(true)}
            className="btn-signals"
            style={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', padding: '12px 24px', fontSize: '16px' }}
          >
            🔍 Lookup Symbol Signal
          </button>
          <button
            onClick={() => setShowMarketAnalysis(true)}
            className="btn-signals"
            disabled={trades.length === 0}
            style={{
              background: trades.length > 0
                ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                : '#ccc',
              padding: '12px 24px',
              fontSize: '16px',
              cursor: trades.length > 0 ? 'pointer' : 'not-allowed'
            }}
          >
            📉 Market Downturn Analysis
          </button>
        </div>
        <p style={{ marginTop: '10px', fontSize: '14px', color: '#666' }}>
          Analyze trading signals or identify market opportunities from downturns
        </p>
      </div>

      {pnlData.length > 0 && !loading && (
          <>
            {lastPriceUpdate && (
              <div style={{
                padding: '12px 20px',
                background: '#e7f3ff',
                borderRadius: '8px',
                marginBottom: '15px',
                fontSize: '14px',
                color: '#0056b3',
                textAlign: 'center',
                fontWeight: '500'
              }}>
                {useServer && connected
                  ? '🔄 Server auto-updates every 1 minute'
                  : '🔄 Prices auto-refresh every 1 minute'
                } | <strong>Last updated: {lastPriceUpdate.toLocaleTimeString()}</strong>
              </div>
            )}

            <div className="controls">
            <div className="search-box">
              <input
                type="text"
                placeholder="Filter by symbol..."
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                className="symbol-search"
              />
            </div>
            <label>
              <input
                type="checkbox"
                checked={includeOptions}
                onChange={(e) => setIncludeOptions(e.target.checked)}
              />
              Include Other Instruments
            </label>
            <label>
              <input
                type="checkbox"
                checked={showOpenOnly}
                onChange={(e) => setShowOpenOnly(e.target.checked)}
              />
              Show Open Positions Only
            </label>
            <label>
              <input
                type="checkbox"
                checked={showChartsInHistory}
                onChange={(e) => setShowChartsInHistory(e.target.checked)}
              />
              Include Chart in History
            </label>
            <label>
              <input
                type="checkbox"
                checked={showRiskManagement}
                onChange={(e) => setShowRiskManagement(e.target.checked)}
              />
              Show Risk Management
            </label>
            {showRiskManagement && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '20px' }}>
                <label style={{ fontWeight: 'bold' }}>Total Risk Budget:</label>
                <input
                  type="number"
                  step="1000"
                  min="0"
                  value={totalRiskBudget}
                  onChange={(e) => setTotalRiskBudget(parseFloat(e.target.value) || 0)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: '1px solid #ddd',
                    width: '150px',
                    fontSize: '14px'
                  }}
                />
              </div>
            )}
            <div className="pnl-toggles">
              <strong>P&L Columns:</strong>
              <label>
                <input
                  type="checkbox"
                  checked={visiblePnlColumns.real}
                  onChange={(e) => setVisiblePnlColumns({...visiblePnlColumns, real: e.target.checked})}
                />
                Real
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={visiblePnlColumns.avgCost}
                  onChange={(e) => setVisiblePnlColumns({...visiblePnlColumns, avgCost: e.target.checked})}
                />
                Avg Cost
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={visiblePnlColumns.fifo}
                  onChange={(e) => setVisiblePnlColumns({...visiblePnlColumns, fifo: e.target.checked})}
                />
                FIFO
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={visiblePnlColumns.lifo}
                  onChange={(e) => setVisiblePnlColumns({...visiblePnlColumns, lifo: e.target.checked})}
                />
                LIFO
              </label>
            </div>
            {tradingSignals.length > 0 && (
              <div className="pnl-toggles">
                <strong>Signal Filter:</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={signalFilter.BUY}
                    onChange={(e) => setSignalFilter({...signalFilter, BUY: e.target.checked})}
                  />
                  🟢 BUY
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={signalFilter.SELL}
                    onChange={(e) => setSignalFilter({...signalFilter, SELL: e.target.checked})}
                  />
                  🔴 SELL
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={signalFilter.HOLD}
                    onChange={(e) => setSignalFilter({...signalFilter, HOLD: e.target.checked})}
                  />
                  ⚪ HOLD
                </label>
              </div>
            )}
            <label>
              <input
                type="checkbox"
                checked={signalFetchingEnabled}
                onChange={(e) => setSignalFetchingEnabled(e.target.checked)}
              />
              Enable Signal Fetching
            </label>
            <button
              onClick={() => {
                if (!signalFetchingEnabled) {
                  alert('Please enable "Enable Signal Fetching" first')
                  return
                }
                const newState = !showSignals
                setShowSignals(newState)
                // Scroll to signals after they render
                if (newState) {
                  setTimeout(() => {
                    document.querySelector('.signals-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }, 100)
                }
              }}
              className="btn-signals"
              disabled={!signalFetchingEnabled}
            >
              {showSignals ? 'Hide' : 'Show'} Trading Signals
            </button>
          </div>
          {signalFetchingEnabled && (
            <div style={{ marginTop: '20px', marginBottom: '20px', display: showSignals ? 'block' : 'none' }}>
              <TradingSignals
                openPositions={pnlData.filter(p => p.avgCost.position > 0 && !p.isOption)}
                onClose={() => setShowSignals(false)}
                onSignalsUpdate={setTradingSignals}
                fetchingEnabled={signalFetchingEnabled}
                useServer={useServer}
                connected={connected}
              />
            </div>
          )}

          <TradesTable
            data={filteredData}
            allData={pnlData}
            trades={trades}
            manualPrices={manualPrices}
            splitAdjustments={splitAdjustments}
            visiblePnlColumns={visiblePnlColumns}
            tradingSignals={tradingSignals}
            showChartsInHistory={showChartsInHistory}
            showRiskManagement={showRiskManagement}
            riskAllocations={riskAllocations}
            onManualPriceUpdate={handleManualPriceUpdate}
            onClearManualPrice={handleClearManualPrice}
            onSplitAdjustment={handleSplitAdjustment}
            onClearSplitAdjustment={handleClearSplitAdjustment}
            onTotalsUpdate={setPnlTotals}
            onRiskAllocationUpdate={handleRiskAllocationUpdate}
          />

          {/* PNL Summary Cards */}
          {pnlTotals && (
            <div className="summary" style={{ marginTop: '20px' }}>
              {/* Total Principal Card */}
              <div className="summary-card">
                <h3>Total Principal</h3>
                <div className="value" style={{ color: '#667eea' }}>
                  {formatCurrency(totalPrincipal)}
                </div>
              </div>

              {/* Risk Management Summary */}
              {showRiskManagement && (() => {
                const totalAllocated = filteredData.reduce((sum, row) => sum + ((riskAllocations && riskAllocations[row.symbol]) || 0), 0)
                const totalUsed = filteredData.reduce((sum, row) => sum + (row.real.avgCostBasis * row.real.position), 0)
                const availableRisk = totalRiskBudget - totalAllocated
                const utilizationPercent = totalRiskBudget > 0 ? (totalUsed / totalRiskBudget) * 100 : 0

                return (
                  <>
                    <div className="summary-card" style={{ background: '#fff4e6', borderLeft: '4px solid #f59e0b' }}>
                      <h3>Risk Budget</h3>
                      <div className="value" style={{ color: '#f59e0b' }}>
                        {formatCurrency(totalRiskBudget)}
                      </div>
                    </div>
                    <div className="summary-card" style={{ background: '#fff4e6', borderLeft: '4px solid #f59e0b' }}>
                      <h3>Risk Allocated</h3>
                      <div className="value" style={{ color: '#f59e0b' }}>
                        {formatCurrency(totalAllocated)}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
                        {totalRiskBudget > 0 ? ((totalAllocated / totalRiskBudget) * 100).toFixed(1) : 0}% of budget
                      </div>
                    </div>
                    <div className="summary-card" style={{ background: '#fff4e6', borderLeft: '4px solid #f59e0b' }}>
                      <h3>Risk Used</h3>
                      <div className="value" style={{ color: utilizationPercent > 100 ? '#dc3545' : '#f59e0b' }}>
                        {formatCurrency(totalUsed)}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
                        {utilizationPercent.toFixed(1)}% utilized
                        {utilizationPercent > 100 && <span style={{ color: '#dc3545', marginLeft: '5px' }}>⚠ Over Budget!</span>}
                      </div>
                    </div>
                    <div className="summary-card" style={{ background: availableRisk < 0 ? '#ffe6e6' : '#e6f7e6', borderLeft: `4px solid ${availableRisk < 0 ? '#dc3545' : '#28a745'}` }}>
                      <h3>Available Risk</h3>
                      <div className={`value ${availableRisk >= 0 ? 'positive' : 'negative'}`}>
                        {formatCurrency(Math.abs(availableRisk))}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
                        {availableRisk < 0 ? 'Over-allocated' : 'Remaining capacity'}
                      </div>
                    </div>
                  </>
                )
              })()}

              {visiblePnlColumns.real && (
                <>
                  <div className="summary-card">
                    <h3>Real Total P&L</h3>
                    <div className={`value ${pnlTotals.realTotal >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.realTotal)}
                    </div>
                    <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
                      {pnlPercentages.totalPercent >= 0 ? '+' : ''}{pnlPercentages.totalPercent.toFixed(2)}%
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>Real Realized</h3>
                    <div className={`value ${pnlTotals.realRealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.realRealized)}
                    </div>
                    <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
                      {pnlPercentages.realizedPercent >= 0 ? '+' : ''}{pnlPercentages.realizedPercent.toFixed(2)}%
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>Real Unrealized</h3>
                    <div className={`value ${pnlTotals.realUnrealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.realUnrealized)}
                    </div>
                    <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
                      {pnlPercentages.unrealizedPercent >= 0 ? '+' : ''}{pnlPercentages.unrealizedPercent.toFixed(2)}%
                    </div>
                  </div>
                </>
              )}
              {visiblePnlColumns.avgCost && (
                <div className="summary-card">
                  <h3>Avg Cost Unrealized P&L</h3>
                  <div className={`value ${pnlTotals.avgCostUnrealized >= 0 ? 'positive' : 'negative'}`}>
                    {formatCurrency(pnlTotals.avgCostUnrealized)}
                  </div>
                </div>
              )}
              {visiblePnlColumns.fifo && (
                <>
                  <div className="summary-card">
                    <h3>FIFO Total P&L</h3>
                    <div className={`value ${pnlTotals.fifoTotal >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.fifoTotal)}
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>FIFO Realized</h3>
                    <div className={`value ${pnlTotals.fifoRealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.fifoRealized)}
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>FIFO Unrealized</h3>
                    <div className={`value ${pnlTotals.fifoUnrealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.fifoUnrealized)}
                    </div>
                  </div>
                </>
              )}
              {visiblePnlColumns.lifo && (
                <>
                  <div className="summary-card">
                    <h3>LIFO Total P&L</h3>
                    <div className={`value ${pnlTotals.lifoTotal >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.lifoTotal)}
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>LIFO Realized</h3>
                    <div className={`value ${pnlTotals.lifoRealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.lifoRealized)}
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>LIFO Unrealized</h3>
                    <div className={`value ${pnlTotals.lifoUnrealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.lifoUnrealized)}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Symbol Lookup Popup */}
      {showSymbolLookup && (
        <>
          <div
            className="signal-popup"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 999999,
              borderLeftColor: '#f5576c',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
          >
            <div className="signal-popup-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4>🔍 Lookup Symbol Signal</h4>
              <button onClick={closeLookup} className="btn-small btn-cancel" style={{ fontSize: '16px', padding: '4px 8px' }}>✗</button>
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                Enter Symbol:
              </label>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  type="text"
                  placeholder="e.g. AAPL"
                  value={lookupSymbol}
                  onChange={(e) => setLookupSymbol(e.target.value.toUpperCase())}
                  onKeyPress={(e) => e.key === 'Enter' && handleSymbolLookup()}
                  className="price-input"
                  style={{ flex: 1, padding: '8px', fontSize: '14px' }}
                  autoFocus
                />
                <button
                  onClick={handleSymbolLookup}
                  disabled={lookupLoading}
                  className="btn-small"
                  style={{ padding: '8px 16px', fontSize: '14px' }}
                >
                  {lookupLoading ? 'Loading...' : 'Fetch Signal'}
                </button>
              </div>
            </div>

            {lookupError && (
              <div style={{ padding: '10px', background: '#f8d7da', color: '#721c24', borderRadius: '6px', marginBottom: '15px', border: '1px solid #f5c6cb' }}>
                ❌ {lookupError}
              </div>
            )}

            {lookupLoading && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                <div style={{ marginBottom: '10px' }}>⏳ Fetching signal data...</div>
                <div style={{ fontSize: '12px' }}>This may take a few seconds</div>
              </div>
            )}

            {lookupSignal && !lookupLoading && (
              <div style={{ borderTop: '2px solid #e9ecef', paddingTop: '15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <h3 style={{ margin: 0 }}>{lookupSignal.symbol}</h3>
                  <div
                    className="signal-badge"
                    style={{
                      background: lookupSignal.signal === 'BUY' ? '#28a745' : lookupSignal.signal === 'SELL' ? '#dc3545' : '#6c757d',
                      padding: '8px 16px',
                      borderRadius: '20px',
                      color: 'white',
                      fontWeight: 'bold',
                      fontSize: '14px'
                    }}
                  >
                    {lookupSignal.signal === 'BUY' ? '🟢' : lookupSignal.signal === 'SELL' ? '🔴' : '⚪'} {lookupSignal.signal}
                  </div>
                </div>

                <div style={{ padding: '10px', background: '#f8f9fa', borderRadius: '6px', marginBottom: '15px' }}>
                  <div style={{ marginBottom: '5px' }}>
                    <strong>Current Price:</strong> ${lookupSignal.currentPrice?.toFixed(2)}
                  </div>
                  <div>
                    <strong>Strength:</strong> {lookupSignal.strengthLabel} ({lookupSignal.strength}/7)
                  </div>
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <strong style={{ display: 'block', marginBottom: '8px' }}>Technical Indicators:</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '14px' }}>
                    <div style={{ padding: '8px', background: '#e7f3ff', borderRadius: '4px' }}>
                      <div style={{ color: '#666', fontSize: '12px' }}>EMA 9</div>
                      <div style={{ fontWeight: 'bold' }}>${lookupSignal.indicators.ema9}</div>
                    </div>
                    <div style={{ padding: '8px', background: '#e7f3ff', borderRadius: '4px' }}>
                      <div style={{ color: '#666', fontSize: '12px' }}>EMA 21</div>
                      <div style={{ fontWeight: 'bold' }}>${lookupSignal.indicators.ema21}</div>
                    </div>
                    <div style={{ padding: '8px', background: '#e7f3ff', borderRadius: '4px' }}>
                      <div style={{ color: '#666', fontSize: '12px' }}>RSI</div>
                      <div style={{ fontWeight: 'bold' }}>{lookupSignal.indicators.rsi}</div>
                    </div>
                    <div style={{ padding: '8px', background: '#e7f3ff', borderRadius: '4px' }}>
                      <div style={{ color: '#666', fontSize: '12px' }}>MACD</div>
                      <div style={{ fontWeight: 'bold' }}>{lookupSignal.indicators.macd}</div>
                    </div>
                  </div>
                </div>

                <div>
                  <strong style={{ display: 'block', marginBottom: '8px' }}>Analysis:</strong>
                  <ul style={{ margin: 0, paddingLeft: '20px' }}>
                    {lookupSignal.reasons.map((reason, i) => (
                      <li key={i} style={{ marginBottom: '5px' }}>{reason}</li>
                    ))}
                  </ul>
                </div>

                <div style={{ marginTop: '15px', padding: '10px', background: '#fff3cd', borderRadius: '6px', fontSize: '13px', color: '#856404' }}>
                  ⚠️ <strong>Educational purposes only.</strong> Not financial advice.
                </div>
              </div>
            )}
          </div>

          {/* Backdrop */}
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.5)',
              zIndex: 999998
            }}
            onClick={closeLookup}
          />
        </>
      )}

      {/* Market Downturn Analysis Popup */}
      {showMarketAnalysis && (
        <MarketAnalysis
          trades={trades}
          onClose={() => setShowMarketAnalysis(false)}
        />
      )}
    </div>
  )
}

export default App
