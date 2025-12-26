import React, { useState, useEffect } from 'react'
import CSVUpload from './components/CSVUpload'
import TradesTable from './components/TradesTable'
import TradingSignals from './components/TradingSignals'
import MarketAnalysis from './components/MarketAnalysis'
import SignalPerformance from './components/SignalPerformance'
import ThemeToggle from './components/ThemeToggle'
import DailyPnLChart from './components/DailyPnLChart'
import { parseTrades, parseDeposits } from './utils/csvParser'
import { calculatePnL } from './utils/pnlCalculator'
import { fetchCurrentPrices } from './utils/yahooFinance'
import { getIntradayData } from './utils/marketData'
import { generateSignal } from './utils/technicalAnalysis'
import { socketService } from './services/socketService'

function App() {
  const [trades, setTrades] = useState([])
  const [pnlData, setPnlData] = useState([])
  const [showOpenOnly, setShowOpenOnly] = useState(true)
  const [symbolFilter, setSymbolFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)
  const [csvStats, setCsvStats] = useState(null)
  const [manualPrices, setManualPrices] = useState({})
  const [currentPrices, setCurrentPrices] = useState({})
  const [previousClosePrices, setPreviousClosePrices] = useState({})
  const [splitAdjustments, setSplitAdjustments] = useState({})
  const [snapshotDates, setSnapshotDates] = useState([])
  const [currentSnapshotDate, setCurrentSnapshotDate] = useState(null)
  const [isViewingSnapshot, setIsViewingSnapshot] = useState(false)
  const [uploadDates, setUploadDates] = useState([])
  const [currentUploadDate, setCurrentUploadDate] = useState(null)
  const [failedSymbols, setFailedSymbols] = useState([])
  const [showSignals, setShowSignals] = useState(false)
  const [visiblePnlColumns, setVisiblePnlColumns] = useState({
    real: true,
    avgCost: false,
    fifo: false,
    lifo: false
  })
  const [showColumnCustomizer, setShowColumnCustomizer] = useState(false)
  const [draggedColumn, setDraggedColumn] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const [realPnlColumnOrder, setRealPnlColumnOrder] = useState(() => {
    const defaultOrder = [
      'avgCost',
      'lowestBuy',
      'recentLowestBuy',
      'recentLowestSell',
      'realized',
      'currentValue',
      'unrealized',
      'total',
      'buySellTotal',
      'dailyPnL',
      'madeUpGround',
      'optionsPnL',
      'percentage'
    ]

    const saved = localStorage.getItem('realPnlColumnOrder')
    if (!saved) return defaultOrder

    const savedOrder = JSON.parse(saved)

    // Migration: Add new columns to saved order if they don't exist
    if (!savedOrder.includes('recentLowestBuy')) {
      // Insert recentLowestBuy after lowestBuy
      const lowestBuyIndex = savedOrder.indexOf('lowestBuy')
      if (lowestBuyIndex !== -1) {
        savedOrder.splice(lowestBuyIndex + 1, 0, 'recentLowestBuy')
      } else {
        // If lowestBuy not found, just add at the beginning
        savedOrder.unshift('recentLowestBuy')
      }
    }

    if (!savedOrder.includes('recentLowestSell')) {
      // Insert recentLowestSell after recentLowestBuy
      const recentLowestBuyIndex = savedOrder.indexOf('recentLowestBuy')
      if (recentLowestBuyIndex !== -1) {
        savedOrder.splice(recentLowestBuyIndex + 1, 0, 'recentLowestSell')
      } else {
        // If recentLowestBuy not found, add after lowestBuy
        const lowestBuyIndex = savedOrder.indexOf('lowestBuy')
        if (lowestBuyIndex !== -1) {
          savedOrder.splice(lowestBuyIndex + 1, 0, 'recentLowestSell')
        } else {
          savedOrder.unshift('recentLowestSell')
        }
      }
    }

    return savedOrder
  })
  const [lastPriceUpdate, setLastPriceUpdate] = useState(null)
  const [priceUpdateCount, setPriceUpdateCount] = useState(0)
  const [prevCloseDebug, setPrevCloseDebug] = useState(null)
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
  const [dividendsAndInterest, setDividendsAndInterest] = useState([])
  const [pnlPercentages, setPnlPercentages] = useState({
    realizedPercent: 0,
    unrealizedPercent: 0,
    totalPercent: 0
  })
  const [showChartsInHistory, setShowChartsInHistory] = useState(false)
  const [connected, setConnected] = useState(false)
  const [useServer, setUseServer] = useState(true) // Toggle between server and standalone mode - SERVER mode by default
  const [showMarketAnalysis, setShowMarketAnalysis] = useState(false)
  const [showSignalPerformance, setShowSignalPerformance] = useState(false)
  const [showRiskManagement, setShowRiskManagement] = useState(false)
  const [riskAllocations, setRiskAllocations] = useState({})
  const [totalRiskBudget, setTotalRiskBudget] = useState(10000) // Default $10k risk budget
  const [stockSymbols, setStockSymbols] = useState([]) // Stock symbols (excluding options)

  // Helper function to get dynamic color for Daily PNL
  const getDailyPnLColor = (value) => {
    if (value === 0) {
      return { background: '#f8f9fa', border: '#6c757d', textColor: '#333' }
    }

    // For positive values: scale from light green to deep green
    if (value > 0) {
      const intensity = Math.min(value / 1000, 1) // Cap at $1000 for max green
      const lightness = 85 - (intensity * 45) // 85% to 40% lightness
      const saturation = 40 + (intensity * 30) // 40% to 70% saturation
      return {
        background: `hsl(120, ${saturation}%, ${lightness}%)`,
        border: `hsl(120, ${saturation + 10}%, ${lightness - 20}%)`,
        textColor: lightness < 60 ? '#fff' : '#155724'
      }
    }

    // For negative values: scale from light red to deep red
    const intensity = Math.min(Math.abs(value) / 1000, 1) // Cap at -$1000 for max red
    const lightness = 85 - (intensity * 45) // 85% to 40% lightness
    const saturation = 40 + (intensity * 30) // 40% to 70% saturation
    return {
      background: `hsl(0, ${saturation}%, ${lightness}%)`,
      border: `hsl(0, ${saturation + 10}%, ${lightness - 20}%)`,
      textColor: lightness < 60 ? '#fff' : '#721c24'
    }
  }

  // Connect to server on mount
  useEffect(() => {
    if (!useServer) return

    console.log('Connecting to WebSocket server...')
    socketService.connect()

    // Listen for connection status
    socketService.socket.on('connect', async () => {
      setConnected(true)
      console.log('✅ Connected to server')

      // Auto-load latest saved trades if no trades are currently loaded
      if (trades.length === 0) {
        try {
          console.log('📥 Attempting to auto-load latest saved trades...')
          const result = await socketService.getLatestTrades()
          if (result.success && result.trades && result.trades.length > 0) {
            console.log(`✅ Auto-loaded ${result.trades.length} trades from ${result.uploadDate}`)
            setTrades(result.trades)
            setDeposits(result.deposits || [])
            setTotalPrincipal(result.totalPrincipal || 0)
            // Set historical prices and P&L data
            if (result.currentPrices) {
              setCurrentPrices(result.currentPrices)
            }
            if (result.pnlData) {
              setPnlData(result.pnlData)
            }
            // No popup message for auto-load
          } else {
            console.log('ℹ️  No saved trades found on server')
          }
        } catch (error) {
          console.log('ℹ️  Could not auto-load trades:', error.message)
        }
      }
    })

    socketService.socket.on('disconnect', () => {
      setConnected(false)
      console.log('❌ Disconnected from server')
    })

    // Listen for price updates from server
    socketService.onPriceUpdate((data) => {
      console.log('📈 Received price update from server')
      setPriceUpdateCount(prev => prev + 1)

      // Check if viewing today's data
      const today = new Date().toISOString().split('T')[0]
      const isViewingTodaysSnapshot = isViewingSnapshot && currentSnapshotDate === today
      const isViewingTodaysUpload = currentUploadDate && currentUploadDate === today

      console.log('🔍 Price update check:', {
        isViewingSnapshot,
        currentSnapshotDate,
        currentUploadDate,
        today,
        isViewingTodaysSnapshot,
        isViewingTodaysUpload,
        willUpdate: (!currentUploadDate || isViewingTodaysUpload) && (!isViewingSnapshot || isViewingTodaysSnapshot)
      })

      // Allow updates if viewing today's data (either snapshot or upload)
      const shouldUpdate = (!currentUploadDate || isViewingTodaysUpload) && (!isViewingSnapshot || isViewingTodaysSnapshot)

      if (shouldUpdate) {
        const hasMadeUpGround = data.pnlData?.some(d => d.madeUpGround !== null && d.madeUpGround !== undefined)
        console.warn(`🔄 APPLYING PRICE UPDATE: ${data.pnlData?.length} positions, Made Up Ground: ${hasMadeUpGround ? 'YES ✅' : 'NO ❌'}`)
        setCurrentPrices(data.currentPrices)
        setPnlData(data.pnlData)
        setLastPriceUpdate(new Date(data.timestamp))
      } else {
        console.warn('⏸️  IGNORING PRICE UPDATE - viewing historical data')
      }
    })

    // Listen for P&L updates
    socketService.onPnLUpdate((data) => {
      console.log('💰 Received P&L update from server')

      // Check if viewing today's data
      const today = new Date().toISOString().split('T')[0]
      const isViewingTodaysSnapshot = isViewingSnapshot && currentSnapshotDate === today
      const isViewingTodaysUpload = currentUploadDate && currentUploadDate === today

      // Allow updates if viewing today's data (either snapshot or upload)
      const shouldUpdate = (!currentUploadDate || isViewingTodaysUpload) && (!isViewingSnapshot || isViewingTodaysSnapshot)

      if (shouldUpdate) {
        setPnlData(data.pnlData)
      } else {
        console.log('⏸️  Ignoring P&L update - viewing historical data')
      }
    })

    // Cleanup on unmount
    return () => {
      socketService.disconnect()
    }
  }, [useServer, currentUploadDate, isViewingSnapshot, currentSnapshotDate])

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
        const pnl = calculatePnL(adjustedTrades, mergedPrices, true, null, previousClosePrices, dividendsAndInterest) // Always rollup options
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
      const pnl = calculatePnL(adjustedTrades, mergedPrices, true, null, previousClosePrices) // Always rollup options
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
        const pnl = calculatePnL(adjustedTrades, mergedPrices, true, null, previousClosePrices, dividendsAndInterest) // Always rollup options
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
      const pnl = calculatePnL(adjustedTrades, mergedPrices, true, null, previousClosePrices) // Always rollup options
      setPnlData(pnl)
    }
  }

  const handleRiskAllocationUpdate = (symbol, amount) => {
    const updatedAllocations = { ...riskAllocations, [symbol]: parseFloat(amount) }
    setRiskAllocations(updatedAllocations)
    console.log(`Risk allocation for ${symbol} set to ${amount}`)
  }

  const handleColumnOrderChange = (newOrder) => {
    setRealPnlColumnOrder(newOrder)
    localStorage.setItem('realPnlColumnOrder', JSON.stringify(newOrder))
  }

  const moveColumn = (index, direction) => {
    const newOrder = [...realPnlColumnOrder]
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex >= 0 && newIndex < newOrder.length) {
      [newOrder[index], newOrder[newIndex]] = [newOrder[newIndex], newOrder[index]]
      handleColumnOrderChange(newOrder)
    }
  }

  const resetColumnOrder = () => {
    const defaultOrder = [
      'avgCost',
      'lowestBuy',
      'recentLowestBuy',
      'recentLowestSell',
      'realized',
      'currentValue',
      'unrealized',
      'total',
      'buySellTotal',
      'dailyPnL',
      'optionsPnL',
      'percentage'
    ]
    handleColumnOrderChange(defaultOrder)
  }

  const handleDragStart = (e, index) => {
    setDraggedColumn(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/html', e.currentTarget)
  }

  const handleDragOver = (e, index) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const handleDragLeave = () => {
    setDragOverIndex(null)
  }

  const handleDrop = (e, dropIndex) => {
    e.preventDefault()
    if (draggedColumn === null || draggedColumn === dropIndex) {
      setDraggedColumn(null)
      setDragOverIndex(null)
      return
    }

    const newOrder = [...realPnlColumnOrder]
    const [draggedItem] = newOrder.splice(draggedColumn, 1)
    newOrder.splice(dropIndex, 0, draggedItem)

    handleColumnOrderChange(newOrder)
    setDraggedColumn(null)
    setDragOverIndex(null)
  }

  const handleDragEnd = () => {
    setDraggedColumn(null)
    setDragOverIndex(null)
  }

  const applySplitAdjustments = (trades, splits) => {
    return trades.map(trade => {
      if (splits[trade.symbol]) {
        const ratio = splits[trade.symbol]
        return {
          ...trade,
          price: trade.price / ratio,
          quantity: trade.quantity * ratio  // Adjust quantity for split
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

    // Save stock symbols to state
    setStockSymbols(stockSymbols)

    // Fetch current prices and previous close prices
    const { currentPrices: fetchedPrices, previousClosePrices: fetchedPrevClosePrices } = await fetchCurrentPrices(stockSymbols)

    // Debug previousClose for display
    const prevCloseSamples = Object.entries(fetchedPrevClosePrices).slice(0, 5)
    const allZero = prevCloseSamples.every(([s, p]) => p === 0)
    setPrevCloseDebug({
      samples: prevCloseSamples,
      allZero,
      total: Object.keys(fetchedPrevClosePrices).length
    })

    console.log('✓ Fetched prices:', {
      sampleCurrent: Object.entries(fetchedPrices).slice(0, 3),
      samplePrevClose: prevCloseSamples
    })

    // Track failed symbols
    const failed = stockSymbols.filter(s => fetchedPrices[s] === 0)
    setFailedSymbols(failed)

    // Set price to 0 for options
    allSymbols.forEach(symbol => {
      if (!fetchedPrices[symbol]) {
        fetchedPrices[symbol] = 0
        fetchedPrevClosePrices[symbol] = 0
      }
    })

    // Merge with manual overrides
    const mergedPrices = { ...fetchedPrices, ...manualPrices }
    setCurrentPrices(fetchedPrices)
    setPreviousClosePrices(fetchedPrevClosePrices)

    // Recalculate P&L with warnings collection
    const adjustedTrades = applySplitAdjustments(trades, splitAdjustments)
    const warnings = []

    // Add previousClose info to debug output
    const prevCloseSample = Object.entries(fetchedPrevClosePrices).slice(0, 5)
    warnings.push(`📊 PreviousClose samples: ${prevCloseSample.map(([s, p]) => `${s}=$${p}`).join(', ')}`)

    const pnl = calculatePnL(adjustedTrades, mergedPrices, true, (msg) => {
      console.log('DEBUG:', msg)
      warnings.push(msg)
    }, fetchedPrevClosePrices, dividendsAndInterest) // Always rollup options
    setPnlData(pnl)
    setDebugInfo(warnings) // Show warnings on screen

    setLastPriceUpdate(new Date())
    console.log('Prices refreshed', { warningsCount: warnings.length })
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

    // Calculate total principal from all deposits
    const cumulativePrincipal = deposits.reduce((sum, deposit) => sum + deposit.amount, 0)

    if (cumulativePrincipal === 0) {
      return { realizedPercent: 0, unrealizedPercent: 0, totalPercent: 0 }
    }

    // Calculate percentages using total principal as denominator
    // This works correctly with options (including expired options and short positions)
    const realizedPercent = (pnlTotals.realRealized / cumulativePrincipal) * 100
    const unrealizedPercent = (pnlTotals.realUnrealized / cumulativePrincipal) * 100
    const totalPercent = (pnlTotals.realTotal / cumulativePrincipal) * 100

    return { realizedPercent, unrealizedPercent, totalPercent }
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

  // Auto-refresh prices every 1 minute when viewing today's data
  useEffect(() => {
    if (trades.length === 0) return

    // Only auto-refresh when viewing today's data (not historical snapshots/uploads)
    const today = new Date().toISOString().split('T')[0]
    const isViewingTodaysSnapshot = isViewingSnapshot && currentSnapshotDate === today
    const isViewingTodaysUpload = currentUploadDate && currentUploadDate === today
    const isViewingToday = (!currentUploadDate || isViewingTodaysUpload) && (!isViewingSnapshot || isViewingTodaysSnapshot)

    if (!isViewingToday) {
      console.log('⏸️  Auto-refresh disabled - viewing historical data')
      return
    }

    console.log('✅ Auto-refresh enabled - viewing today\'s data')

    // Set up interval for auto-refresh
    const interval = setInterval(() => {
      console.log('🔄 Auto-refreshing prices...')
      refreshPrices()
    }, 60000) // 1 minute = 60000ms

    // Clean up on unmount
    return () => clearInterval(interval)
  }, [trades, manualPrices, splitAdjustments, currentUploadDate, currentSnapshotDate, isViewingSnapshot])

  // Load snapshot dates when connected to server
  useEffect(() => {
    console.log('Snapshot dates effect - useServer:', useServer, 'connected:', connected)
    if (useServer && connected) {
      console.log('Fetching snapshot dates...')
      socketService.getSnapshotDates()
        .then(dates => {
          console.log('✅ Received snapshot dates:', dates)
          setSnapshotDates(dates || [])
        })
        .catch(err => {
          console.error('❌ Error loading snapshot dates:', err)
          setSnapshotDates([])
        })
    } else {
      console.log('Not fetching dates - not connected or not in server mode')
    }
  }, [useServer, connected])

  // Load upload dates when connected to server
  useEffect(() => {
    if (useServer && connected) {
      console.log('Fetching upload dates...')
      socketService.getUploadDates()
        .then(dates => {
          console.log('✅ Received upload dates:', dates)
          setUploadDates(dates || [])
        })
        .catch(err => {
          console.error('❌ Error loading upload dates:', err)
          setUploadDates([])
        })
    }
  }, [useServer, connected])

  const handleLoadTrades = async (uploadDate) => {
    if (!uploadDate) {
      // Clear - could reload latest or just return
      setCurrentUploadDate(null)
      return
    }

    try {
      setLoading(true)
      console.log(`Loading trades for ${uploadDate}...`)

      const result = await socketService.loadTrades(uploadDate)
      console.log(`Received trades:`, result)

      if (result.success && result.trades) {
        console.log(`📊 Loading data for ${uploadDate}:`)
        console.log(`  - Trades: ${result.trades.length}`)
        console.log(`  - Prices:`, result.currentPrices ? Object.keys(result.currentPrices).length : 0, 'symbols')
        console.log(`  - Sample prices:`, result.currentPrices ? Object.entries(result.currentPrices).slice(0, 3) : [])
        console.log(`  - P&L data:`, result.pnlData ? result.pnlData.length : 0, 'positions')

        setTrades(result.trades)
        setDeposits(result.deposits || [])
        setTotalPrincipal(result.totalPrincipal || 0)
        if (result.currentPrices) {
          setCurrentPrices(result.currentPrices)
        }
        if (result.pnlData) {
          setPnlData(result.pnlData)
          console.log(`  - Total P&L: $${result.pnlData.reduce((sum, p) => sum + (p.real?.totalPnL || 0), 0).toFixed(2)}`)

          // DEBUG: Show what we received from loading saved data
          const optionItems = result.pnlData.filter(item => item.isOption)
          const stockItems = result.pnlData.filter(item => !item.isOption)
          setDebugInfo({
            source: '🔵 LOAD SAVED',
            totalItems: result.pnlData.length,
            stocks: stockItems.length,
            options: optionItems.length,
            optionSymbols: optionItems.map(o => o.symbol)
          })
        }
        setCurrentUploadDate(uploadDate)
        console.log(`✅ Loaded ${result.trades.length} trades from ${uploadDate}`)
      }
    } catch (error) {
      console.error('Error loading trades:', error)
      setError(`Failed to load trades: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleLoadSnapshot = async (asofDate) => {
    if (!asofDate) {
      // Clear snapshot view - return to live mode
      setIsViewingSnapshot(false)
      setCurrentSnapshotDate(null)
      // Note: Don't clear pnlData - it will be refreshed when user uploads CSV or refreshes prices
      return
    }

    try {
      setLoading(true)
      setError(null)
      console.log(`Loading snapshot for ${asofDate}...`)

      const snapshotData = await socketService.loadPnLSnapshot(asofDate)
      console.log(`Received snapshot data:`, snapshotData)

      if (!snapshotData || snapshotData.length === 0) {
        setError(`No data found for ${asofDate}. Upload a CSV to save data first.`)
        setLoading(false)
        return
      }

      // Transform snapshot data to match pnlData format
      console.log('Sample row:', snapshotData[0])

      const transformedData = snapshotData.map(row => {
        try {
          // Helper to ensure numeric values (convert null/undefined to 0)
          const num = (val) => (val === null || val === undefined || isNaN(val)) ? 0 : Number(val)

          const emptyPnl = {
            position: 0,
            avgCostBasis: 0,
            currentValue: 0,
            realizedPnL: 0,
            unrealizedPnL: 0,
            totalPnL: 0,
            dailyPnL: 0,
            optionsPnL: 0,
            percentage: 0,
            percentageReturn: 0,
            lowestOpenBuyPrice: 0
          }

          return {
            symbol: row.symbol || 'UNKNOWN',
            currentPrice: num(row.current_price),
            previousClose: num(row.current_price),
            optionsPnL: num(row.options_pnl),
            optionsDailyPnL: 0,
            optionsMadeUpGround: 0,
            optionsCount: 0,
            options: [],
            avgCost: {
              position: num(row.position),
              avgCostBasis: num(row.avg_cost),
              currentValue: num(row.current_value),
              realizedPnL: num(row.realized_pnl),
              unrealizedPnL: num(row.unrealized_pnl),
              totalPnL: num(row.total_pnl),
              dailyPnL: num(row.daily_pnl),
              optionsPnL: num(row.options_pnl),
              percentage: num(row.percentage),
              percentageReturn: num(row.percentage),
              lowestOpenBuyPrice: num(row.lowest_open_buy_price),
              lowestOpenBuyDaysAgo: row.lowest_open_buy_days_ago || 0
            },
            real: {
              position: num(row.position),
              avgCostBasis: num(row.avg_cost),
              currentValue: num(row.current_value),
              realizedPnL: num(row.realized_pnl),
              unrealizedPnL: num(row.unrealized_pnl),
              totalPnL: num(row.total_pnl),
              dailyPnL: num(row.daily_pnl),
              optionsPnL: num(row.options_pnl),
              percentage: num(row.percentage),
              percentageReturn: num(row.percentage),
              lowestOpenBuyPrice: num(row.lowest_open_buy_price),
              lowestOpenBuyDaysAgo: row.lowest_open_buy_days_ago || 0
            },
            lifo: { ...emptyPnl },
            fifo: { ...emptyPnl },
            // Preserve Made Up Ground fields from server enrichment
            madeUpGround: row.madeUpGround ?? null,
            madeUpGroundAvailable: row.madeUpGroundAvailable ?? false,
            weekAgoData: row.weekAgoData || null
          }
        } catch (err) {
          console.error('Error transforming row:', row, err)
          return null
        }
      }).filter(item => item !== null)

      console.log(`Transformed ${transformedData.length} rows`)
      console.log('Sample transformed:', JSON.stringify(transformedData[0], null, 2))

      // Set snapshot data
      console.log('Setting pnlData to transformed data...')
      const hasMadeUpGround = transformedData.some(d => d.madeUpGround !== null && d.madeUpGround !== undefined)
      console.warn(`🎯 SNAPSHOT LOADED: ${transformedData.length} positions, Made Up Ground: ${hasMadeUpGround ? 'YES ✅' : 'NO ❌'}`)
      if (hasMadeUpGround) {
        const sample = transformedData.find(d => d.madeUpGround != null)
        console.warn(`   Sample: ${sample.symbol} = ${sample.madeUpGround}`)
      }
      setPnlData(transformedData)
      console.log('pnlData set - about to render')

      // If viewing today's snapshot, load trades so server can send price updates
      const today = new Date().toISOString().split('T')[0]
      if (asofDate === today && useServer) {
        console.log('📥 Loading latest trades for today\'s snapshot to enable price updates...')
        try {
          const result = await socketService.getLatestTrades()
          if (result.trades && result.trades.length > 0) {
            setTrades(result.trades)
            console.log(`✅ Loaded ${result.trades.length} trades for server session`)
          }
        } catch (err) {
          console.error('Error loading trades for today\'s snapshot:', err)
        }
      } else {
        setTrades([]) // Clear trades for historical snapshots
      }

      setCurrentSnapshotDate(asofDate)
      setIsViewingSnapshot(true)
      setLoading(false)
      console.log(`✅ Snapshot loaded successfully`)
    } catch (error) {
      console.error('Error loading snapshot:', error)
      setError('Error loading snapshot: ' + error.message)
      setLoading(false)
    }
  }

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

        // DEBUG: Show what we received from CSV upload
        const optionItems = response.pnlData.filter(item => item.isOption)
        const stockItems = response.pnlData.filter(item => !item.isOption)
        setDebugInfo({
          source: '🟢 CSV UPLOAD',
          totalItems: response.pnlData.length,
          stocks: stockItems.length,
          options: optionItems.length,
          optionSymbols: optionItems.map(o => o.symbol)
        })

        // If uploadDate is present, we're viewing historical data
        if (response.uploadDate) {
          setCurrentUploadDate(response.uploadDate)
          console.log(`📅 Viewing historical data for ${response.uploadDate}`)
        } else {
          setCurrentUploadDate(null)
        }

        // Count options vs stocks for debugging
        const optionCount = response.trades.filter(t => t.isOption).length
        const stockCount = response.trades.filter(t => !t.isOption).length
        const stats = { total: response.trades.length, options: optionCount, stocks: stockCount }
        setCsvStats(stats)

        console.log(`Server response: ${response.pnlData.length} symbols, principal: ${response.totalPrincipal}`)

      } else {
        // STANDALONE MODE: Process locally (original logic)
        console.log('💻 Processing CSV locally (standalone mode)...')

        // Parse CSV file for trades and dividends/interest
        const { trades: parsedTrades, dividendsAndInterest } = await parseTrades(file)
        setTrades(parsedTrades)
        setDividendsAndInterest(dividendsAndInterest)

        // Count options vs stocks for debugging
        const optionCount = parsedTrades.filter(t => t.isOption).length
        const stockCount = parsedTrades.filter(t => !t.isOption).length
        const stats = { total: parsedTrades.length, options: optionCount, stocks: stockCount }
        setCsvStats(stats)

        console.log(`📊 Dividends/Interest: ${dividendsAndInterest.length} entries`)
        console.log(`💰 Dividends: ${dividendsAndInterest.filter(d => d.isDividend).length}`)
        console.log(`💸 Interest: ${dividendsAndInterest.filter(d => d.isInterest).length}`)

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

        // Save stock symbols to state
        setStockSymbols(stockSymbols)

        // Fetch current prices from Yahoo Finance (only for stocks, not options)
        const { currentPrices: fetchedPrices, previousClosePrices: fetchedPrevClosePrices } = await fetchCurrentPrices(stockSymbols)

        // Track failed symbols (stocks that got $0 price)
        const failed = stockSymbols.filter(s => fetchedPrices[s] === 0)
        setFailedSymbols(failed)

        // Set price to 0 for options (they don't need current market prices)
        allSymbols.forEach(symbol => {
          if (!fetchedPrices[symbol]) {
            fetchedPrices[symbol] = 0
            fetchedPrevClosePrices[symbol] = 0
          }
        })

        // Merge fetched prices with manual overrides
        const mergedPrices = { ...fetchedPrices, ...manualPrices }
        setCurrentPrices(fetchedPrices)
        setPreviousClosePrices(fetchedPrevClosePrices)

        // Apply split adjustments to trades
        const adjustedTrades = applySplitAdjustments(parsedTrades, splitAdjustments)

        // Calculate P&L with both FIFO and LIFO
        // Options are always rolled up into their underlying instruments
        const debugMessages = []
        const pnl = calculatePnL(adjustedTrades, mergedPrices, true, (msg) => {
          console.log('DEBUG CALLBACK:', msg)
          debugMessages.push(msg)
        }, fetchedPrevClosePrices, dividendsAndInterest)
        setPnlData(pnl)
        console.log('Debug messages collected:', debugMessages.length)
        setDebugInfo(debugMessages)

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

  const handleRobinhoodDownload = async () => {
    try {
      setLoading(true)
      setError(null)

      console.log('🤖 Initiating Robinhood download...')

      const API_BASE = useServer && connected
        ? `http://localhost:${socketService.port || 5000}`
        : 'http://localhost:5000'

      const response = await fetch(`${API_BASE}/api/robinhood/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.error || `Failed to download from Robinhood: ${response.statusText}`)
      }

      if (result.success) {
        console.log('✅ Successfully downloaded and imported from Robinhood')

        if (result.manualDownload) {
          alert('CSV downloaded manually and imported successfully!')
        } else {
          alert('CSV downloaded automatically and imported successfully!')
        }

        // Refresh data by fetching latest from server
        if (useServer && connected) {
          const refreshResponse = await socketService.emitWithResponse('getLatestData', {})
          setTrades(refreshResponse.trades)
          setDeposits(refreshResponse.deposits)
          setTotalPrincipal(refreshResponse.totalPrincipal)
          setCurrentPrices(refreshResponse.currentPrices)
          setPnlData(refreshResponse.pnlData)
          setCurrentUploadDate(result.uploadDate)
        }
      }

      setLoading(false)
    } catch (err) {
      console.error('❌ Robinhood download error:', err)
      setError(err.message)
      setLoading(false)
    }
  }

  let filteredData = pnlData

  // Filter out individual options - they're shown as aggregated P&L in the Options P&L column
  filteredData = filteredData.filter(item => !item.isOption)

  // Filter by open positions only
  if (showOpenOnly) {
    console.log('🔍 Filtering for open positions only...')
    console.log('Before filter:', filteredData.length, 'positions')
    filteredData = filteredData.filter(item => {
      const position = item.avgCost?.position || 0
      const isOpen = position >= 0.01
      if (!isOpen) {
        console.log(`  ❌ Filtering out ${item.symbol}: position = ${position}`)
      }
      return isOpen // Filter out closed positions (including tiny fractional shares from rounding)
    })
    console.log('After filter:', filteredData.length, 'positions')
  }

  // Filter by symbol search
  if (symbolFilter.trim()) {
    filteredData = filteredData.filter(item =>
      item.symbol.toLowerCase().includes(symbolFilter.toLowerCase())
    )
  }

  // DEBUG: Find symbols that look like options (for display only, don't setState during render)
  const suspiciousSymbolsForDisplay = filteredData.filter(item => {
    const hasDatePattern = /\d{1,2}\/\d{1,2}\/\d{4}/.test(item.symbol)
    const hasCallOrPut = item.symbol.includes('Call') || item.symbol.includes('Put')
    return hasDatePattern || hasCallOrPut
  }).map(s => ({
    symbol: s.symbol,
    isOption: s.isOption,
    position: s.avgCost?.position || 0,
    isRollup: s.isRollup
  }))

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
      <ThemeToggle />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', gap: '10px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Robinhood P&L Tracker</h1>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {useServer && connected && uploadDates.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '14px', fontWeight: '500' }}>Saved Data:</label>
              <select
                value={currentUploadDate || ''}
                onChange={(e) => handleLoadTrades(e.target.value || null)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ccc',
                  fontSize: '14px',
                  cursor: 'pointer',
                  background: currentUploadDate ? '#d4edda' : 'white'
                }}
              >
                <option value="">Select Date...</option>
                {uploadDates.map(item => (
                  <option key={item.upload_date} value={item.upload_date}>
                    {item.upload_date} ({item.trade_count} trades)
                  </option>
                ))}
              </select>
              <button
                onClick={async () => {
                  if (window.confirm('⚠️ Clear all saved data from database? This cannot be undone. You will need to re-upload all CSV files.')) {
                    try {
                      await socketService.clearDatabase()
                      setUploadDates([])
                      setCurrentUploadDate(null)
                      setTrades([])
                      setPnlData([])
                      alert('✅ Database cleared successfully! Please re-upload your CSV files.')
                    } catch (error) {
                      alert(`Error clearing database: ${error.message}`)
                    }
                  }
                }}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  background: '#dc3545',
                  color: 'white'
                }}
                title="Clear all saved data from database"
              >
                🗑️ Clear DB
              </button>
            </div>
          )}
          {useServer && connected && snapshotDates.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '14px', fontWeight: '500' }}>Load Snapshot:</label>
              <select
                value={currentSnapshotDate || ''}
                onChange={(e) => handleLoadSnapshot(e.target.value || null)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ccc',
                  fontSize: '14px',
                  cursor: 'pointer',
                  background: isViewingSnapshot ? '#fff3cd' : 'white'
                }}
              >
                <option value="">Live View</option>
                {snapshotDates.map(date => (
                  <option key={date} value={date}>{date}</option>
                ))}
              </select>
            </div>
          )}
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
          <button
            className="upload-button"
            onClick={handleRobinhoodDownload}
            disabled={loading}
            style={{
              marginLeft: '10px',
              opacity: useServer && connected ? 0.5 : 1,
              cursor: useServer && connected ? 'not-allowed' : 'pointer'
            }}
            title={useServer && connected ? 'This feature only works when running locally. Use CSV upload on Railway.' : 'Opens browser to download from Robinhood'}
          >
            {loading ? '⏳ Downloading...' : '🤖 Download from Robinhood (Local Only)'}
          </button>
        </div>
      </div>

      {/* Debug Panel */}
      <div style={{
        background: '#e3f2fd',
        border: '2px solid #2196f3',
        borderRadius: '6px',
        padding: '12px 16px',
        marginBottom: '16px',
        fontFamily: 'monospace',
        fontSize: '12px'
      }}>
        <strong>🔍 Auto-Update Debug:</strong><br/>
        <strong style={{ color: priceUpdateCount > 0 ? 'green' : 'red' }}>
          Updates Received: {priceUpdateCount}
        </strong> | {(() => {
          const today = new Date().toISOString().split('T')[0]
          const isViewingTodaysSnapshot = isViewingSnapshot && currentSnapshotDate === today
          const isViewingTodaysUpload = currentUploadDate && currentUploadDate === today
          const shouldUpdate = (!currentUploadDate || isViewingTodaysUpload) && (!isViewingSnapshot || isViewingTodaysSnapshot)
          return (
            <>
              Snapshot: {isViewingSnapshot ? 'YES' : 'NO'} |
              Snap Date: "{currentSnapshotDate || 'none'}" |
              Upload Date: "{currentUploadDate || 'none'}" |
              Today: "{today}" |
              Match Upload: {isViewingTodaysUpload ? 'YES' : 'NO'} |
              Match Snap: {isViewingTodaysSnapshot ? 'YES' : 'NO'} |
              Should Update: {shouldUpdate ? 'YES ✅' : 'NO ❌'}
            </>
          )
        })()}
      </div>

      {/* Sale Opportunities View */}
      {pnlData.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <button
            className="upload-button"
            onClick={() => {
              const opportunities = pnlData
                .filter(row => !row.isOption && !row.isRollup && (row.real?.position || 0) > 0)
                .map(row => {
                  const signal = tradingSignals?.find(s => s.symbol === row.symbol)
                  const unrealizedPnL = row.real?.unrealizedPnL || 0
                  const totalPnL = row.real?.totalPnL || 0
                  const position = row.real?.position || 0
                  const currentPrice = row.currentPrice || 0
                  const avgCost = row.real?.avgCostBasis || 0
                  const gainPercent = avgCost > 0 ? ((currentPrice - avgCost) / avgCost * 100) : 0

                  // Get sell opportunities from recent buys (same logic as grid)
                  const recentBuys = row.real?.recentLowestBuys || []
                  const recentSells = row.real?.recentSells || []
                  const eligibleBuys = []

                  for (const buy of recentBuys) {
                    const buyPrice = buy?.price || 0
                    const buyDate = buy?.date

                    if (currentPrice > buyPrice && buyPrice > 0) {
                      // Check if there's a sell after this buy that already captured this opportunity
                      let alreadySold = false

                      for (const sell of recentSells) {
                        const sellPrice = sell?.price || 0
                        const sellDate = sell?.date

                        // If there's a sell after this buy at a higher price, opportunity already taken
                        if (sellDate && buyDate && sellDate > buyDate && sellPrice >= buyPrice) {
                          alreadySold = true
                          break
                        }
                      }

                      // Add to eligible list if opportunity hasn't been taken yet
                      if (!alreadySold) {
                        eligibleBuys.push({
                          price: buyPrice,
                          daysAgo: buy.daysAgo || 0,
                          profit: currentPrice - buyPrice
                        })
                      }
                    }
                  }

                  // Score the opportunity (higher = better sale candidate)
                  let score = 0
                  if (signal?.signal === 'SELL') score += 10
                  if (eligibleBuys.length > 0) score += 8
                  if (unrealizedPnL > 0) score += 5
                  if (gainPercent > 20) score += 3
                  if (gainPercent > 50) score += 5
                  if (totalPnL > 1000) score += 2

                  return {
                    symbol: row.symbol,
                    currentPrice,
                    position,
                    avgCost,
                    unrealizedPnL,
                    totalPnL,
                    gainPercent,
                    signal: signal?.signal || 'HOLD',
                    signalStrength: signal?.signalStrength || 'N/A',
                    score,
                    eligibleBuys,
                    recentBuys
                  }
                })
                .sort((a, b) => a.symbol.localeCompare(b.symbol))

              const html = `
                <html>
                <head>
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>Sale Opportunities</title>
                  <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                      padding: 16px;
                      background: #f5f5f5;
                    }
                    h1 {
                      font-size: 24px;
                      margin-bottom: 16px;
                      color: #333;
                    }
                    .count {
                      background: #2196f3;
                      color: white;
                      padding: 4px 12px;
                      border-radius: 12px;
                      font-size: 14px;
                      margin-left: 8px;
                    }
                    .card {
                      background: white;
                      border-radius: 12px;
                      padding: 16px;
                      margin-bottom: 12px;
                      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .symbol {
                      font-size: 20px;
                      font-weight: bold;
                      color: #333;
                      margin-bottom: 8px;
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                    }
                    .signal-badge {
                      padding: 4px 12px;
                      border-radius: 16px;
                      font-size: 12px;
                      font-weight: bold;
                    }
                    .sell { background: #dc3545; color: white; }
                    .buy { background: #28a745; color: white; }
                    .hold { background: #6c757d; color: white; }
                    .metrics {
                      display: grid;
                      grid-template-columns: 1fr 1fr;
                      gap: 12px;
                      margin-top: 12px;
                    }
                    .metric {
                      display: flex;
                      flex-direction: column;
                    }
                    .metric-label {
                      font-size: 11px;
                      color: #666;
                      text-transform: uppercase;
                      margin-bottom: 4px;
                    }
                    .metric-value {
                      font-size: 16px;
                      font-weight: 600;
                    }
                    .positive { color: #28a745; }
                    .negative { color: #dc3545; }
                    .score {
                      position: absolute;
                      top: 16px;
                      right: 16px;
                      background: #ffc107;
                      color: #000;
                      padding: 4px 8px;
                      border-radius: 8px;
                      font-size: 12px;
                      font-weight: bold;
                    }
                    .sell-opps {
                      margin-top: 12px;
                      padding: 12px;
                      background: #fff3cd;
                      border-left: 4px solid #ffc107;
                      border-radius: 4px;
                    }
                    .sell-opps-title {
                      font-size: 12px;
                      font-weight: bold;
                      color: #856404;
                      margin-bottom: 8px;
                    }
                    .buy-item {
                      font-size: 13px;
                      color: #333;
                      margin-bottom: 4px;
                      padding-left: 8px;
                    }
                    .recent-buys {
                      margin-top: 12px;
                      padding: 12px;
                      background: #e3f2fd;
                      border-left: 4px solid #2196f3;
                      border-radius: 4px;
                    }
                    .recent-buys-title {
                      font-size: 12px;
                      font-weight: bold;
                      color: #0d47a1;
                      margin-bottom: 8px;
                    }
                    .close-btn {
                      position: fixed;
                      top: 16px;
                      right: 16px;
                      width: 36px;
                      height: 36px;
                      background: #dc3545;
                      color: white;
                      border: none;
                      border-radius: 50%;
                      font-size: 24px;
                      font-weight: bold;
                      cursor: pointer;
                      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                      z-index: 1000;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      line-height: 1;
                    }
                    .close-btn:active {
                      background: #c82333;
                    }
                  </style>
                </head>
                <body>
                  <button class="close-btn" onclick="window.close()">×</button>
                  <h1>Sale Opportunities <span class="count">${opportunities.length}</span></h1>
                  ${opportunities.map(opp => `
                    <div class="card" style="position: relative;">
                      ${opp.score > 10 ? `<div class="score">★ ${opp.score}</div>` : ''}
                      <div class="symbol">
                        <span>${opp.symbol}</span>
                        <span class="signal-badge ${opp.signal.toLowerCase()}">${opp.signal} ${opp.signalStrength}</span>
                      </div>
                      <div class="metrics">
                        <div class="metric">
                          <div class="metric-label">Price</div>
                          <div class="metric-value">$${opp.currentPrice.toFixed(2)}</div>
                        </div>
                        <div class="metric">
                          <div class="metric-label">Position</div>
                          <div class="metric-value">${opp.position.toFixed(2)} shares</div>
                        </div>
                        <div class="metric">
                          <div class="metric-label">Avg Cost</div>
                          <div class="metric-value">$${opp.avgCost.toFixed(2)}</div>
                        </div>
                        <div class="metric">
                          <div class="metric-label">Gain %</div>
                          <div class="metric-value ${opp.gainPercent >= 0 ? 'positive' : 'negative'}">
                            ${opp.gainPercent >= 0 ? '+' : ''}${opp.gainPercent.toFixed(1)}%
                          </div>
                        </div>
                        <div class="metric">
                          <div class="metric-label">Unrealized P&L</div>
                          <div class="metric-value ${opp.unrealizedPnL >= 0 ? 'positive' : 'negative'}">
                            ${opp.unrealizedPnL >= 0 ? '+' : ''}$${opp.unrealizedPnL.toFixed(2)}
                          </div>
                        </div>
                        <div class="metric">
                          <div class="metric-label">Current Value</div>
                          <div class="metric-value">
                            $${(opp.position * opp.currentPrice).toFixed(2)}
                          </div>
                        </div>
                      </div>
                      ${opp.eligibleBuys.length > 0 ? `
                        <div class="sell-opps">
                          <div class="sell-opps-title">🎯 Sell Opportunities</div>
                          ${opp.eligibleBuys.map(buy => `
                            <div class="buy-item">• $${buy.price.toFixed(2)} (${buy.daysAgo}d ago) → Profit: +$${buy.profit.toFixed(2)}</div>
                          `).join('')}
                        </div>
                      ` : ''}
                      ${opp.recentBuys && opp.recentBuys.length > 0 ? `
                        <div class="recent-buys">
                          <div class="recent-buys-title">📋 All Recent Buys</div>
                          ${opp.recentBuys.map((buy, i) => `
                            <div class="buy-item">#${i + 1}: $${buy.price?.toFixed(2) || '0.00'} (${buy.daysAgo || 0}d ago)</div>
                          `).join('')}
                        </div>
                      ` : ''}
                    </div>
                  `).join('')}
                </body>
                </html>
              `

              const newWindow = window.open('', '_blank', 'width=400,height=800')
              newWindow.document.write(html)
              newWindow.document.close()
            }}
            style={{ marginRight: '10px' }}
          >
            💰 View Sale Opportunities
          </button>

          <button
            className="upload-button"
            onClick={async () => {
              try {
                console.log('🔄 Manually calculating Made Up Ground...')

                // Get current viewing date
                const viewingDate = currentSnapshotDate || currentUploadDate
                if (!viewingDate) {
                  alert('No viewing date available')
                  return
                }

                // Calculate 7 days ago
                const [year, month, day] = viewingDate.split('-').map(Number)
                const date = new Date(year, month - 1, day)
                date.setDate(date.getDate() - 7)
                const weekAgoDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

                console.log(`Loading snapshot from ${weekAgoDate}...`)
                const weekAgoData = await socketService.loadPnLSnapshot(weekAgoDate)

                if (!weekAgoData || weekAgoData.length === 0) {
                  alert(`No snapshot found for ${weekAgoDate}`)
                  return
                }

                console.log(`Loaded ${weekAgoData.length} positions from ${weekAgoDate}`)

                // Create lookup map
                const weekAgoMap = {}
                weekAgoData.forEach(row => {
                  weekAgoMap[row.symbol] = row
                })

                // Enrich current pnlData
                const enriched = pnlData.map(position => {
                  const weekAgo = weekAgoMap[position.symbol]
                  if (!weekAgo) {
                    return {
                      ...position,
                      madeUpGround: null,
                      madeUpGroundAvailable: false
                    }
                  }

                  const todayRealPnL = position.real?.realizedPnL || 0
                  const weekAgoRealPnL = weekAgo.realized_pnl || weekAgo.real?.realizedPnL || 0
                  const weekAgoQuantity = weekAgo.position || 0
                  const todayPrice = position.currentPrice || 0
                  const weekAgoPrice = weekAgo.current_price || weekAgo.currentPrice || 0

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

                console.log('✅ Made Up Ground calculated')
                setPnlData(enriched)
              } catch (err) {
                console.error('Error calculating Made Up Ground:', err)
                alert(`Error: ${err.message}`)
              }
            }}
            style={{ marginRight: '10px' }}
          >
            📊 Calculate Made Up Ground
          </button>
          <span style={{ fontSize: '12px', color: '#666' }}>
            Compares current data against snapshot from 7 days ago
          </span>
        </div>
      )}

      {isViewingSnapshot && (
        <div style={{
          background: '#fff3cd',
          border: '2px solid #ffc107',
          borderRadius: '6px',
          padding: '12px 16px',
          marginBottom: '15px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ fontWeight: '500', color: '#856404' }}>
            📅 Viewing snapshot from: {currentSnapshotDate}
          </span>
          <button
            onClick={() => handleLoadSnapshot(null)}
            style={{
              background: '#ffc107',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500'
            }}
          >
            Return to Live View
          </button>
        </div>
      )}

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

      {/* Daily P&L Chart */}
      <DailyPnLChart useServer={useServer} connected={connected} />

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
          <button
            onClick={() => setShowSignalPerformance(true)}
            className="btn-signals"
            style={{
              background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
              padding: '12px 24px',
              fontSize: '16px',
              cursor: 'pointer'
            }}
          >
            📊 Signal Performance
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
            <button
              onClick={refreshPrices}
              disabled={loading || trades.length === 0}
              style={{
                padding: '8px 16px',
                cursor: trades.length === 0 ? 'not-allowed' : 'pointer',
                opacity: trades.length === 0 ? 0.5 : 1
              }}
            >
              🔄 Refresh Prices
            </button>
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
              {visiblePnlColumns.real && (
                <button
                  onClick={() => setShowColumnCustomizer(true)}
                  className="btn-small"
                  style={{ marginLeft: '10px', padding: '4px 8px', fontSize: '12px' }}
                >
                  ⚙️ Customize
                </button>
              )}
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

          {/* PNL Summary Cards - Real PNL and Daily PNL Above Grid */}
          {pnlTotals && (
            <div className="summary" style={{ marginTop: '20px', marginBottom: '20px' }}>
              {/* Total Principal Card */}
              <div className="summary-card">
                <h3>Total Principal</h3>
                <div className="value" style={{ color: '#667eea' }}>
                  {formatCurrency(totalPrincipal)}
                </div>
              </div>

              {/* Real PNL Cards */}
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
                    <h3>Buy/Sell Total</h3>
                    <div className={`value ${pnlTotals.realRealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.realRealized)}
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', marginTop: '5px', fontStyle: 'italic' }}>
                      Net cash flow
                    </div>
                  </div>
                  <div className="summary-card">
                    <h3>Current Value</h3>
                    <div className={`value ${pnlTotals.realUnrealized >= 0 ? 'positive' : 'negative'}`}>
                      {formatCurrency(pnlTotals.realUnrealized)}
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', marginTop: '5px', fontStyle: 'italic' }}>
                      Holdings value
                    </div>
                  </div>
                  <div className="summary-card" style={{
                    background: getDailyPnLColor(pnlTotals.dailyPnL).background,
                    borderLeft: `4px solid ${getDailyPnLColor(pnlTotals.dailyPnL).border}`
                  }}>
                    <h3 style={{ color: getDailyPnLColor(pnlTotals.dailyPnL).textColor }}>Daily P&L</h3>
                    <div className="value" style={{ color: getDailyPnLColor(pnlTotals.dailyPnL).textColor }}>
                      {formatCurrency(pnlTotals.dailyPnL)}
                    </div>
                    <div style={{ fontSize: '12px', color: getDailyPnLColor(pnlTotals.dailyPnL).textColor, marginTop: '5px', fontStyle: 'italic', fontWeight: '500', opacity: 0.8 }}>
                      Today's change
                    </div>
                  </div>
                  <div className="summary-card" style={{
                    background: pnlTotals.madeUpGround > 0 ? '#d4edda' : '#f8f9fa',
                    borderLeft: `4px solid ${pnlTotals.madeUpGround > 0 ? '#28a745' : '#6c757d'}`
                  }}>
                    <h3 style={{ color: pnlTotals.madeUpGround > 0 ? '#155724' : '#666' }}>Made Up Ground</h3>
                    <div className="value" style={{ color: pnlTotals.madeUpGround > 0 ? '#155724' : '#666' }}>
                      {formatCurrency(pnlTotals.madeUpGround || 0)}
                    </div>
                    <div style={{ fontSize: '12px', color: pnlTotals.madeUpGround > 0 ? '#155724' : '#666', marginTop: '5px', fontStyle: 'italic', fontWeight: '500', opacity: 0.8 }}>
                      Profit when down
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          <TradesTable
            data={filteredData}
            allData={pnlData}
            trades={trades}
            manualPrices={manualPrices}
            splitAdjustments={splitAdjustments}
            visiblePnlColumns={visiblePnlColumns}
            realPnlColumnOrder={realPnlColumnOrder}
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
            useServer={useServer}
            connected={connected}
          />

          {/* PNL Summary Cards - LIFO/FIFO Below Grid */}
          {pnlTotals && (
            <div className="summary" style={{ marginTop: '20px' }}>
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

      {/* Signal Performance Analysis Popup */}
      {showSignalPerformance && (
        <SignalPerformance
          symbols={stockSymbols}
          onClose={() => setShowSignalPerformance(false)}
          useServer={useServer}
          connected={connected}
        />
      )}

      {/* Column Customizer Popup */}
      {showColumnCustomizer && (
        <>
          <div
            className="signal-popup"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 999999,
              borderLeftColor: '#667eea',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
          >
            <div className="signal-popup-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4>⚙️ Customize Real P&L Columns</h4>
              <button onClick={() => setShowColumnCustomizer(false)} className="btn-small btn-cancel" style={{ fontSize: '16px', padding: '4px 8px' }}>✗</button>
            </div>

            <div style={{ marginBottom: '15px', fontSize: '14px', color: '#666' }}>
              Drag and drop to reorder columns, or use arrow buttons. Changes are saved automatically.
            </div>

            <div style={{ marginBottom: '20px' }}>
              {realPnlColumnOrder.map((columnId, index) => {
                const columnNames = {
                  avgCost: 'Avg Cost',
                  lowestBuy: 'Lowest Buy',
                  recentLowestBuy: 'Most Recent Buy',
                  recentLowestSell: 'Most Recent Sell',
                  realized: 'Realized P&L',
                  currentValue: 'Current Value',
                  unrealized: 'Unrealized P&L',
                  total: 'Total P&L',
                  buySellTotal: 'Buy/Sell Total',
                  dailyPnL: 'Daily P&L',
                  madeUpGround: 'Made Up Ground',
                  optionsPnL: 'Options P&L',
                  percentage: 'Percentage %'
                }

                const isDragging = draggedColumn === index
                const isDragOver = dragOverIndex === index

                return (
                  <div
                    key={columnId}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '10px',
                      marginBottom: '8px',
                      background: isDragging ? '#e9ecef' : isDragOver ? '#d4edda' : '#f8f9fa',
                      borderRadius: '6px',
                      border: isDragOver ? '2px dashed #28a745' : '1px solid #dee2e6',
                      cursor: 'grab',
                      opacity: isDragging ? 0.5 : 1,
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <span style={{ marginRight: '10px', color: '#999', fontSize: '18px' }}>⋮⋮</span>
                    <span style={{ flex: 1, fontWeight: '500' }}>
                      {index + 1}. {columnNames[columnId]}
                    </span>
                    <div style={{ display: 'flex', gap: '5px' }}>
                      <button
                        onClick={() => moveColumn(index, 'up')}
                        disabled={index === 0}
                        className="btn-small"
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                          opacity: index === 0 ? 0.5 : 1
                        }}
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => moveColumn(index, 'down')}
                        disabled={index === realPnlColumnOrder.length - 1}
                        className="btn-small"
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          cursor: index === realPnlColumnOrder.length - 1 ? 'not-allowed' : 'pointer',
                          opacity: index === realPnlColumnOrder.length - 1 ? 0.5 : 1
                        }}
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={resetColumnOrder}
                className="btn-small"
                style={{ padding: '8px 16px' }}
              >
                Reset to Default
              </button>
              <button
                onClick={() => setShowColumnCustomizer(false)}
                className="btn-small"
                style={{ padding: '8px 16px', background: '#667eea', color: 'white' }}
              >
                Done
              </button>
            </div>
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
            onClick={() => setShowColumnCustomizer(false)}
          />
        </>
      )}
    </div>
  )
}

export default App
