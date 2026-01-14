import React, { useState, useEffect } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ComposedChart
} from 'recharts'
import { socketService } from '../services/socketService'
import { fetchHistoricalPrices } from '../utils/yahooFinance'
import { useTheme } from '../contexts/ThemeContext'

function DailyPnLChart({ useServer, connected, trades, currentPrices }) {
  const { isDark } = useTheme()
  const [chartData, setChartData] = useState([])
  const [symbolData, setSymbolData] = useState([])
  const [symbols, setSymbols] = useState([])
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [loading, setLoading] = useState(true)
  const [symbolLoading, setSymbolLoading] = useState(false)
  const [error, setError] = useState(null)
  const [collapsed, setCollapsed] = useState(false)
  const [calculationMode, setCalculationMode] = useState('historical') // 'historical' or 'snapshots'
  const [showStockPnL, setShowStockPnL] = useState(true)
  const [showOptionsPnL, setShowOptionsPnL] = useState(true)

  useEffect(() => {
    if (calculationMode === 'historical' && trades && trades.length > 0) {
      calculateHistoricalPnL()
      // Get unique stock symbols from trades for the dropdown
      const stockTrades = trades.filter(t => !t.symbol.includes(' ') && !t.symbol.includes('Put') && !t.symbol.includes('Call'))
      const uniqueSymbols = [...new Set(stockTrades.map(t => t.symbol))].sort()
      setSymbols(uniqueSymbols)
    } else if (calculationMode === 'snapshots' && useServer && connected) {
      loadDailyPnL()
      loadSymbols()
    } else {
      setLoading(false)
    }
  }, [calculationMode, trades, currentPrices, useServer, connected])

  // Load symbol-specific data when symbol is selected
  useEffect(() => {
    if (selectedSymbol) {
      if (calculationMode === 'historical' && trades && trades.length > 0) {
        calculateSymbolHistoricalPnL(selectedSymbol)
      } else if (calculationMode === 'snapshots' && useServer && connected) {
        loadSymbolPnL(selectedSymbol)
      }
    }
  }, [selectedSymbol, calculationMode, trades, currentPrices, useServer, connected])

  const calculateHistoricalPnL = async () => {
    try {
      setLoading(true)
      setError(null)
      console.log('📊 Calculating historical P&L from trades...')

      if (!trades || trades.length === 0) {
        console.log('No trades available')
        setError('No trades loaded. Upload a CSV file to see historical P&L.')
        setChartData([])
        setLoading(false)
        return
      }

      // Separate stock and options trades
      const stockTrades = trades.filter(t => !t.symbol.includes(' ') && !t.symbol.includes('Put') && !t.symbol.includes('Call'))
      const optionsTrades = trades.filter(t => t.symbol.includes(' ') || t.symbol.includes('Put') || t.symbol.includes('Call'))

      if (stockTrades.length === 0 && optionsTrades.length === 0) {
        console.log('No trades found')
        setError('No trades found')
        setChartData([])
        setLoading(false)
        return
      }

      // Find date range - limit to last 90 days for performance
      const allTradeDates = trades.map(t => new Date(t.date || t.transDate))
      const tradeDates = allTradeDates
      const earliestTrade = new Date(Math.min(...tradeDates))
      const latestDate = new Date()
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      // Use the later of: earliest trade or 90 days ago
      const earliestDate = earliestTrade > ninetyDaysAgo ? earliestTrade : ninetyDaysAgo

      // Get all unique symbols for stocks and options
      const uniqueStockSymbols = [...new Set(stockTrades.map(t => t.symbol))]
      const uniqueOptionsSymbols = [...new Set(optionsTrades.map(t => t.symbol))]
      console.log(`  Calculating P&L for ${uniqueStockSymbols.length} stocks and ${uniqueOptionsSymbols.length} options from ${earliestDate.toLocaleDateString()} to ${latestDate.toLocaleDateString()}`)

      // Use current prices instead of fetching historical (much faster)
      console.log('  Using current prices for calculation...')

      // Generate daily P&L (using current prices for simplicity/speed)
      const dailyPnL = []
      const currentDate = new Date(earliestDate)

      while (currentDate <= latestDate) {
        const dateStr = currentDate.toISOString().split('T')[0]
        const candleDate = new Date(currentDate).setHours(0, 0, 0, 0)

        let stockPnL = 0
        let optionsPnL = 0

        // Calculate Stock P&L
        for (const symbol of uniqueStockSymbols) {
          const symbolTrades = stockTrades.filter(t => t.symbol === symbol)

          // Get trades up to this date
          const tradesUpToDate = symbolTrades.filter(trade => {
            const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
            return tradeDate <= candleDate
          })

          if (tradesUpToDate.length === 0) continue

          // Calculate cumulative buys, sells, and position
          const buyAmount = tradesUpToDate
            .filter(t => t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const sellProceeds = tradesUpToDate
            .filter(t => !t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const position = tradesUpToDate.reduce((pos, t) =>
            t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

          // Use current price (simplified for speed)
          const price = currentPrices?.[symbol] || 0

          // Running P&L = Sell proceeds + Current position value - Buy cost
          const positionValue = position * price
          const symbolPnL = sellProceeds + positionValue - buyAmount

          stockPnL += symbolPnL
        }

        // Calculate Options P&L
        for (const symbol of uniqueOptionsSymbols) {
          const symbolTrades = optionsTrades.filter(t => t.symbol === symbol)

          // Get trades up to this date
          const tradesUpToDate = symbolTrades.filter(trade => {
            const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
            return tradeDate <= candleDate
          })

          if (tradesUpToDate.length === 0) continue

          // Calculate cumulative buys, sells, and position
          const buyAmount = tradesUpToDate
            .filter(t => t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const sellProceeds = tradesUpToDate
            .filter(t => !t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const position = tradesUpToDate.reduce((pos, t) =>
            t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

          // Use current price (simplified for speed)
          const price = currentPrices?.[symbol] || 0

          // Running P&L = Sell proceeds + Current position value - Buy cost
          const positionValue = position * price
          const symbolPnL = sellProceeds + positionValue - buyAmount

          optionsPnL += symbolPnL
        }

        dailyPnL.push({
          date: dateStr,
          stockPnL: parseFloat(stockPnL.toFixed(2)),
          optionsPnL: parseFloat(optionsPnL.toFixed(2)),
          totalPnL: parseFloat((stockPnL + optionsPnL).toFixed(2)),
          realizedPnL: 0,
          unrealizedPnL: 0,
          dailyPnL: 0 // Will calculate in next step
        })

        currentDate.setDate(currentDate.getDate() + 1)
      }

      // Calculate daily changes
      for (let i = 1; i < dailyPnL.length; i++) {
        dailyPnL[i].dailyPnL = parseFloat((dailyPnL[i].totalPnL - dailyPnL[i - 1].totalPnL).toFixed(2))
      }

      console.log(`✅ Calculated ${dailyPnL.length} days of historical P&L`)
      setChartData(dailyPnL)
    } catch (err) {
      console.error('Error calculating historical P&L:', err)
      setError('Failed to calculate historical P&L: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const calculateSymbolHistoricalPnL = async (symbol) => {
    try {
      setSymbolLoading(true)
      setError(null)
      console.log(`📊 Calculating historical P&L for ${symbol}...`)

      if (!trades || trades.length === 0) {
        setSymbolData([])
        setSymbolLoading(false)
        return
      }

      // Filter to this stock's trades and related options
      const stockTrades = trades.filter(t => t.symbol === symbol)
      const optionsTrades = trades.filter(t =>
        (t.symbol.startsWith(symbol + ' ') || t.underlyingSymbol === symbol) &&
        (t.symbol.includes(' ') || t.symbol.includes('Put') || t.symbol.includes('Call'))
      )

      if (stockTrades.length === 0 && optionsTrades.length === 0) {
        console.log(`No trades found for ${symbol}`)
        setSymbolData([])
        setSymbolLoading(false)
        return
      }

      // Find date range - limit to last 90 days
      const allTradeDates = [...stockTrades, ...optionsTrades].map(t => new Date(t.date || t.transDate))
      const earliestTrade = new Date(Math.min(...allTradeDates))
      const latestDate = new Date()
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
      const earliestDate = earliestTrade > ninetyDaysAgo ? earliestTrade : ninetyDaysAgo

      console.log(`  Calculating P&L for ${stockTrades.length} stock trades and ${optionsTrades.length} options trades`)

      // Get unique option symbols
      const uniqueOptionsSymbols = [...new Set(optionsTrades.map(t => t.symbol))]

      // Generate daily P&L
      const dailyPnL = []
      const currentDate = new Date(earliestDate)

      while (currentDate <= latestDate) {
        const dateStr = currentDate.toISOString().split('T')[0]
        const candleDate = new Date(currentDate).setHours(0, 0, 0, 0)

        let stockPnL = 0
        let optionsPnL = 0

        // Calculate Stock P&L
        const tradesUpToDate = stockTrades.filter(trade => {
          const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
          return tradeDate <= candleDate
        })

        if (tradesUpToDate.length > 0) {
          const buyAmount = tradesUpToDate
            .filter(t => t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const sellProceeds = tradesUpToDate
            .filter(t => !t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const position = tradesUpToDate.reduce((pos, t) =>
            t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

          const price = currentPrices?.[symbol] || 0
          const positionValue = position * price
          stockPnL = sellProceeds + positionValue - buyAmount
        }

        // Calculate Options P&L
        for (const optSymbol of uniqueOptionsSymbols) {
          const optTradesUpToDate = optionsTrades
            .filter(t => t.symbol === optSymbol)
            .filter(trade => {
              const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
              return tradeDate <= candleDate
            })

          if (optTradesUpToDate.length === 0) continue

          const buyAmount = optTradesUpToDate
            .filter(t => t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const sellProceeds = optTradesUpToDate
            .filter(t => !t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          const position = optTradesUpToDate.reduce((pos, t) =>
            t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

          const price = currentPrices?.[optSymbol] || 0
          const positionValue = position * price
          optionsPnL += sellProceeds + positionValue - buyAmount
        }

        dailyPnL.push({
          date: dateStr,
          stockPnL: parseFloat(stockPnL.toFixed(2)),
          optionsPnL: parseFloat(optionsPnL.toFixed(2)),
          totalPnL: parseFloat((stockPnL + optionsPnL).toFixed(2)),
          price: currentPrices?.[symbol] || 0
        })

        currentDate.setDate(currentDate.getDate() + 1)
      }

      console.log(`✅ Calculated ${dailyPnL.length} days of P&L for ${symbol}`)
      setSymbolData(dailyPnL)
    } catch (err) {
      console.error(`Error calculating P&L for ${symbol}:`, err)
      setSymbolData([])
    } finally {
      setSymbolLoading(false)
    }
  }

  const loadDailyPnL = async () => {
    try {
      setLoading(true)
      setError(null)
      console.log('📊 Fetching daily P&L history...')

      const data = await socketService.getDailyPnLHistory()

      if (!data || data.length === 0) {
        setError('No historical P&L data available. Upload CSV files to start tracking.')
        setChartData([])
        return
      }

      // Transform data for chart
      const chartData = data.map(row => ({
        date: row.asof_date,
        totalPnL: parseFloat(row.total_pnl || 0),
        realizedPnL: parseFloat(row.realized_pnl || 0),
        unrealizedPnL: parseFloat(row.unrealized_pnl || 0),
        dailyPnL: parseFloat(row.daily_pnl || 0)
      }))

      console.log(`✅ Loaded ${chartData.length} days of P&L history`)
      setChartData(chartData)
    } catch (err) {
      console.error('Error loading daily P&L:', err)
      setError('Failed to load daily P&L history')
    } finally {
      setLoading(false)
    }
  }

  const loadSymbols = async () => {
    try {
      console.log('📋 Fetching symbols list...')
      const symbolsList = await socketService.getSymbolsList()
      console.log(`✅ Loaded ${symbolsList.length} symbols`)
      setSymbols(symbolsList)
    } catch (err) {
      console.error('Error loading symbols:', err)
    }
  }

  const loadSymbolPnL = async (symbol) => {
    try {
      setSymbolLoading(true)
      console.log(`📊 Fetching P&L for ${symbol}...`)

      const data = await socketService.getSymbolDailyPnL(symbol)

      if (!data || data.length === 0) {
        setSymbolData([])
        return
      }

      // Get current (latest) data
      const latestData = data[data.length - 1]
      const currentPosition = parseFloat(latestData.position || 0)
      const currentPrice = parseFloat(latestData.current_price || 0)
      const currentPnL = parseFloat(latestData.total_pnl || 0)

      // Transform data for chart
      const symbolChartData = data.map(row => {
        const historicalPrice = parseFloat(row.current_price || 0)
        const position = parseFloat(row.position || 0)
        const avgCost = parseFloat(row.avg_cost || 0)

        // Calculate hypothetical P&L: current P&L + (current shares * (historical price - current price))
        const hypotheticalPnL = currentPnL + (currentPosition * (historicalPrice - currentPrice))

        return {
          date: row.asof_date,
          price: historicalPrice,
          totalPnL: parseFloat(row.total_pnl || 0),
          dailyPnL: parseFloat(row.daily_pnl || 0),
          position: position,
          avgCost: avgCost,
          hypotheticalPnL: hypotheticalPnL,
          currentPosition: currentPosition,
          currentPrice: currentPrice,
          currentPnL: currentPnL
        }
      })

      console.log(`✅ Loaded ${symbolChartData.length} days of P&L for ${symbol}`)
      console.log(`Current: ${currentPosition} shares @ $${currentPrice.toFixed(2)}, P&L: ${currentPnL.toFixed(2)}`)
      setSymbolData(symbolChartData)
    } catch (err) {
      console.error(`Error loading P&L for ${symbol}:`, err)
      setSymbolData([])
    } finally {
      setSymbolLoading(false)
    }
  }

  const handleClearSnapshots = async () => {
    if (!window.confirm('Are you sure you want to delete ALL P&L snapshots? This will clear all historical data. You can reload your CSV files to recreate them.')) {
      return
    }

    try {
      console.log('🗑️ Clearing all snapshots...')
      const result = await socketService.clearAllSnapshots()
      console.log(`✅ Cleared ${result.deletedCount} snapshot records`)

      // Reload the chart to show empty state
      setChartData([])
      setSymbolData([])
      setError('All snapshots cleared. Upload CSV files to recreate historical data.')
    } catch (err) {
      console.error('Error clearing snapshots:', err)
      alert('Failed to clear snapshots: ' + err.message)
    }
  }

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value)
  }

  const formatDate = (dateString) => {
    // Parse YYYY-MM-DD without timezone conversion
    const [year, month, day] = dateString.split('-').map(Number)
    const date = new Date(year, month - 1, day) // months are 0-indexed
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      // Check if this is symbol-specific data (has hypothetical P&L)
      const dataPoint = payload[0]?.payload
      const hasHypothetical = dataPoint && dataPoint.hypotheticalPnL !== undefined

      return (
        <div style={{
          backgroundColor: isDark ? 'rgba(30, 30, 30, 0.95)' : 'rgba(255, 255, 255, 0.95)',
          padding: '10px',
          border: `1px solid ${isDark ? '#555' : '#ccc'}`,
          borderRadius: '6px',
          fontSize: '13px',
          color: isDark ? '#e0e0e0' : '#333'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>
            {(() => {
              const [year, month, day] = label.split('-').map(Number)
              const date = new Date(year, month - 1, day)
              return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            })()}
          </div>
          {payload.map((entry, index) => (
            <div key={index} style={{ color: entry.color }}>
              {entry.name}: {formatCurrency(entry.value)}
            </div>
          ))}
          {hasHypothetical && (
            <>
              <div style={{
                borderTop: `1px solid ${isDark ? '#555' : '#ddd'}`,
                marginTop: '6px',
                paddingTop: '6px',
                fontSize: '12px'
              }}>
                <div style={{ color: '#9333ea', fontWeight: '500' }}>
                  Hypothetical P&L: {formatCurrency(dataPoint.hypotheticalPnL)}
                </div>
                <div style={{ color: isDark ? '#999' : '#666', fontSize: '11px', marginTop: '2px' }}>
                  If price was ${dataPoint.price.toFixed(2)} (from ${dataPoint.currentPrice.toFixed(2)})
                </div>
              </div>
            </>
          )}
        </div>
      )
    }
    return null
  }

  // Don't show at all if no trades in historical mode
  if (calculationMode === 'historical' && (!trades || trades.length === 0)) {
    return null
  }

  if (!useServer || !connected) {
    if (calculationMode === 'snapshots') {
      return null
    }
  }

  if (loading) {
    return (
      <div style={{
        padding: '20px',
        background: isDark ? '#2a2a2a' : '#f8f9fa',
        borderRadius: '8px',
        marginBottom: '20px',
        textAlign: 'center',
        color: isDark ? '#e0e0e0' : '#333'
      }}>
        Loading daily P&L history...
      </div>
    )
  }

  if (error && calculationMode === 'snapshots') {
    return (
      <div style={{
        padding: '15px',
        background: isDark ? '#3a3a2a' : '#fff3cd',
        color: isDark ? '#ffeb3b' : '#856404',
        borderRadius: '8px',
        marginBottom: '20px',
        fontSize: '14px'
      }}>
        ℹ️ {error}
      </div>
    )
  }

  if (chartData.length === 0) {
    return null
  }

  return (
    <div style={{
      background: isDark ? '#1e1e1e' : 'white',
      borderRadius: '12px',
      padding: collapsed ? '15px' : '20px',
      marginBottom: '20px',
      boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.1)',
      border: `1px solid ${isDark ? '#444' : '#e0e0e0'}`
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: collapsed ? '0' : '15px',
        flexWrap: 'wrap',
        gap: '10px'
      }}>
        <h3 style={{ margin: 0, fontSize: '18px', color: isDark ? '#e0e0e0' : '#333' }}>
          📈 Daily P&L History
        </h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {!collapsed && symbols.length > 0 && (
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: `1px solid ${isDark ? '#555' : '#ccc'}`,
                background: isDark ? '#2a2a2a' : 'white',
                color: isDark ? '#e0e0e0' : '#333',
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              <option value="">All Stocks (Portfolio)</option>
              {symbols.map(symbol => (
                <option key={symbol} value={symbol}>{symbol}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => {
              if (calculationMode === 'historical') {
                calculateHistoricalPnL()
              } else {
                loadDailyPnL()
              }
            }}
            style={{
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500'
            }}
          >
            🔄 Refresh
          </button>
          <button
            onClick={() => {
              const newMode = calculationMode === 'historical' ? 'snapshots' : 'historical'
              setCalculationMode(newMode)
            }}
            style={{
              background: calculationMode === 'historical' ? '#3b82f6' : '#9333ea',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500'
            }}
          >
            {calculationMode === 'historical' ? '📊 Historical' : '📸 Snapshots'}
          </button>
          {calculationMode === 'snapshots' && (
            <button
              onClick={handleClearSnapshots}
              style={{
                background: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '500'
              }}
            >
              🗑️ Clear Snapshots
            </button>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{
              background: '#667eea',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500'
            }}
          >
            {collapsed ? 'Expand ▼' : 'Collapse ▲'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {symbolLoading && (
            <div style={{ textAlign: 'center', padding: '20px', color: isDark ? '#b0b0b0' : '#666' }}>
              Loading {selectedSymbol} data...
            </div>
          )}

          {!symbolLoading && !selectedSymbol && (
            <>
              <div style={{
                display: 'flex',
                gap: '20px',
                marginBottom: '15px',
                fontSize: '14px',
                color: isDark ? '#b0b0b0' : '#666',
                flexWrap: 'wrap',
                alignItems: 'center'
              }}>
                <div>
                  <span style={{ color: isDark ? '#b0b0b0' : '#666' }}>Days tracked:</span>{' '}
                  <strong style={{ color: isDark ? '#e0e0e0' : '#333' }}>{chartData.length}</strong>
                </div>
                <div>
                  <span style={{ color: isDark ? '#b0b0b0' : '#666' }}>Latest Total P&L:</span>{' '}
                  <strong style={{
                    color: chartData[chartData.length - 1]?.totalPnL >= 0 ? '#28a745' : '#dc3545'
                  }}>
                    {formatCurrency(chartData[chartData.length - 1]?.totalPnL || 0)}
                  </strong>
                </div>
                {calculationMode === 'historical' && (
                  <>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 10px',
                      background: isDark ? '#2a2a2a' : '#f0f0f0',
                      borderRadius: '6px'
                    }}>
                      <input
                        type="checkbox"
                        id="show-stock-pnl"
                        checked={showStockPnL}
                        onChange={(e) => setShowStockPnL(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <label htmlFor="show-stock-pnl" style={{ cursor: 'pointer', userSelect: 'none' }}>
                        <span style={{ color: '#3b82f6', fontWeight: '500' }}>●</span> Stock P&L
                      </label>
                    </div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 10px',
                      background: isDark ? '#2a2a2a' : '#f0f0f0',
                      borderRadius: '6px'
                    }}>
                      <input
                        type="checkbox"
                        id="show-options-pnl"
                        checked={showOptionsPnL}
                        onChange={(e) => setShowOptionsPnL(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <label htmlFor="show-options-pnl" style={{ cursor: 'pointer', userSelect: 'none' }}>
                        <span style={{ color: '#f59e0b', fontWeight: '500' }}>●</span> Options P&L
                      </label>
                    </div>
                  </>
                )}
              </div>

              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#444' : '#e0e0e0'} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDate}
                    stroke={isDark ? '#999' : '#666'}
                    style={{ fontSize: '12px' }}
                  />
                  <YAxis
                    tickFormatter={formatCurrency}
                    stroke={isDark ? '#999' : '#666'}
                    style={{ fontSize: '12px' }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <ReferenceLine y={0} stroke="#999" strokeDasharray="3 3" />
                  {calculationMode === 'historical' && showStockPnL && (
                    <Line
                      type="monotone"
                      dataKey="stockPnL"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={{ fill: '#3b82f6', r: 2 }}
                      name="Stock P&L"
                      connectNulls={true}
                      isAnimationActive={false}
                    />
                  )}
                  {calculationMode === 'historical' && showOptionsPnL && (
                    <Line
                      type="monotone"
                      dataKey="optionsPnL"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={{ fill: '#f59e0b', r: 2 }}
                      name="Options P&L"
                      connectNulls={true}
                      isAnimationActive={false}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="totalPnL"
                    stroke="#667eea"
                    strokeWidth={3}
                    dot={{ fill: '#667eea', r: 3 }}
                    name="Total P&L"
                    connectNulls={true}
                    isAnimationActive={false}
                  />
                  {calculationMode !== 'historical' && (
                    <Line
                      type="monotone"
                      dataKey="dailyPnL"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={{ fill: '#f59e0b', r: 2 }}
                      name="Daily P&L"
                      connectNulls={true}
                      isAnimationActive={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>

              <div style={{
                fontSize: '12px',
                color: isDark ? '#999' : '#666',
                marginTop: '10px',
                fontStyle: 'italic'
              }}>
                {calculationMode === 'historical'
                  ? '* Chart shows Stock P&L and Options P&L separately over last 90 days. Toggle checkboxes to show/hide each. Uses current prices (not historical) for faster calculation.'
                  : '* Chart shows historical portfolio Total P&L and Daily P&L changes from saved snapshots'}
              </div>
            </>
          )}

          {!symbolLoading && selectedSymbol && symbolData.length > 0 && (
            <>
              <div style={{
                display: 'flex',
                gap: '20px',
                marginBottom: '15px',
                fontSize: '14px',
                color: isDark ? '#b0b0b0' : '#666',
                flexWrap: 'wrap',
                alignItems: 'center'
              }}>
                <div>
                  <span style={{ color: isDark ? '#b0b0b0' : '#666' }}>Days tracked:</span>{' '}
                  <strong style={{ color: isDark ? '#e0e0e0' : '#333' }}>{symbolData.length}</strong>
                </div>
                <div>
                  <span style={{ color: isDark ? '#b0b0b0' : '#666' }}>Latest Price:</span>{' '}
                  <strong style={{ color: isDark ? '#e0e0e0' : '#333' }}>
                    {formatCurrency(symbolData[symbolData.length - 1]?.price || 0)}
                  </strong>
                </div>
                <div>
                  <span style={{ color: isDark ? '#b0b0b0' : '#666' }}>Latest Total P&L:</span>{' '}
                  <strong style={{
                    color: symbolData[symbolData.length - 1]?.totalPnL >= 0 ? '#28a745' : '#dc3545'
                  }}>
                    {formatCurrency(symbolData[symbolData.length - 1]?.totalPnL || 0)}
                  </strong>
                </div>
                {calculationMode === 'historical' && (
                  <>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 10px',
                      background: isDark ? '#2a2a2a' : '#f0f0f0',
                      borderRadius: '6px'
                    }}>
                      <input
                        type="checkbox"
                        id="show-symbol-stock-pnl"
                        checked={showStockPnL}
                        onChange={(e) => setShowStockPnL(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <label htmlFor="show-symbol-stock-pnl" style={{ cursor: 'pointer', userSelect: 'none' }}>
                        <span style={{ color: '#3b82f6', fontWeight: '500' }}>●</span> Stock P&L
                      </label>
                    </div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 10px',
                      background: isDark ? '#2a2a2a' : '#f0f0f0',
                      borderRadius: '6px'
                    }}>
                      <input
                        type="checkbox"
                        id="show-symbol-options-pnl"
                        checked={showOptionsPnL}
                        onChange={(e) => setShowOptionsPnL(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <label htmlFor="show-symbol-options-pnl" style={{ cursor: 'pointer', userSelect: 'none' }}>
                        <span style={{ color: '#f59e0b', fontWeight: '500' }}>●</span> Options P&L
                      </label>
                    </div>
                  </>
                )}
              </div>

              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={symbolData} margin={{ top: 5, right: 60, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#444' : '#e0e0e0'} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDate}
                    stroke={isDark ? '#999' : '#666'}
                    style={{ fontSize: '12px' }}
                  />
                  <YAxis
                    yAxisId="price"
                    orientation="right"
                    tickFormatter={formatCurrency}
                    stroke="#667eea"
                    style={{ fontSize: '12px' }}
                  />
                  <YAxis
                    yAxisId="pnl"
                    tickFormatter={formatCurrency}
                    stroke="#28a745"
                    style={{ fontSize: '12px' }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <ReferenceLine yAxisId="pnl" y={0} stroke="#999" strokeDasharray="3 3" />
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="price"
                    stroke="#667eea"
                    strokeWidth={2}
                    dot={{ fill: '#667eea', r: 3 }}
                    name="Stock Price"
                    connectNulls={true}
                    isAnimationActive={false}
                  />
                  {calculationMode === 'historical' && showStockPnL && (
                    <Line
                      yAxisId="pnl"
                      type="monotone"
                      dataKey="stockPnL"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={{ fill: '#3b82f6', r: 2 }}
                      name="Stock P&L"
                      connectNulls={true}
                      isAnimationActive={false}
                    />
                  )}
                  {calculationMode === 'historical' && showOptionsPnL && (
                    <Line
                      yAxisId="pnl"
                      type="monotone"
                      dataKey="optionsPnL"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={{ fill: '#f59e0b', r: 2 }}
                      name="Options P&L"
                      connectNulls={true}
                      isAnimationActive={false}
                    />
                  )}
                  <Line
                    yAxisId="pnl"
                    type="monotone"
                    dataKey="totalPnL"
                    stroke="#28a745"
                    strokeWidth={3}
                    dot={{ fill: '#28a745', r: 3 }}
                    name={calculationMode === 'historical' ? 'Total P&L' : 'Actual P&L'}
                    connectNulls={true}
                    isAnimationActive={false}
                  />
                  {calculationMode === 'snapshots' && (
                    <Line
                      yAxisId="pnl"
                      type="monotone"
                      dataKey="hypotheticalPnL"
                      stroke="#9333ea"
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      dot={{ fill: '#9333ea', r: 2 }}
                      name="Hypothetical P&L"
                      connectNulls={true}
                      isAnimationActive={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>

              <div style={{
                fontSize: '12px',
                color: isDark ? '#999' : '#666',
                marginTop: '10px',
                fontStyle: 'italic'
              }}>
                {calculationMode === 'historical' ? (
                  <>
                    * Chart shows {selectedSymbol} stock price (right axis) and P&L breakdown (left axis)
                    <br />
                    * Stock P&L (blue) shows P&L from stock trades only. Options P&L (orange) shows P&L from related options. Total P&L (green) is the combined value.
                  </>
                ) : (
                  <>
                    * Chart shows {selectedSymbol} stock price (right axis) and P&L (left axis) over time
                    <br />
                    * Hypothetical P&L shows what your current P&L would be if the price moved to that historical level
                  </>
                )}
              </div>
            </>
          )}

          {!symbolLoading && selectedSymbol && symbolData.length === 0 && (
            <div style={{
              textAlign: 'center',
              padding: '40px',
              color: isDark ? '#999' : '#666',
              fontSize: '14px'
            }}>
              No historical data available for {selectedSymbol}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default DailyPnLChart
