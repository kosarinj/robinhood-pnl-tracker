import React, { useState, useEffect } from 'react'
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Scatter,
  ReferenceLine
} from 'recharts'
import { fetchHistoricalPrices } from '../utils/yahooFinance'
import { addIndicators } from '../utils/technicalIndicators'
import { socketService } from '../services/socketService'

function PriceChart({ symbol, trades, onClose, useServer = false, connected = false }) {
  const [priceData, setPriceData] = useState([])
  const [rawData, setRawData] = useState([]) // Store raw data separately
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [chartReady, setChartReady] = useState(false)
  const [supportResistanceLevels, setSupportResistanceLevels] = useState([])
  const [showSupportResistance, setShowSupportResistance] = useState(true)
  const [showStockPnL, setShowStockPnL] = useState(true)
  const [showOptionsPnL, setShowOptionsPnL] = useState(true)
  const [dateRange, setDateRange] = useState('6mo') // '1mo', '3mo', '6mo', '1y', 'max'
  const [indicators, setIndicators] = useState({
    showEMA9: false,
    showEMA21: false,
    showRSI: false,
    showMACD: false
  })

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)

      try {
        console.log(`Loading historical data for ${symbol}...`)
        let historical

        // Use server if connected, otherwise use CORS proxies
        if (useServer && connected) {
          console.log(`Using server to fetch historical data (${dateRange}, no CORS issues)`)
          historical = await socketService.fetchHistoricalData(symbol, dateRange, '1d')
          // Convert date strings back to Date objects
          historical = historical.map(item => ({
            ...item,
            date: new Date(item.date)
          }))
        } else {
          console.log(`Using CORS proxies to fetch historical data (${dateRange})`)
          historical = await fetchHistoricalPrices(symbol, dateRange, '1d')
        }

        console.log(`Received ${historical.length} data points for ${symbol}`)
        console.log('First data point:', historical[0])
        console.log('Last data point:', historical[historical.length - 1])

        if (historical.length === 0) {
          throw new Error('No historical data available. The data provider may be unavailable or the symbol may be invalid.')
        }

        // Store raw historical data
        setRawData(historical)

        // Add technical indicators
        const dataWithIndicators = addIndicators(historical, indicators)
        console.log('After adding indicators:', dataWithIndicators.length, 'points')
        console.log('First point with indicators:', dataWithIndicators[0])

        // Calculate running P&L and add buy/sell markers from trades
        console.log(`Processing ${trades.length} trades for ${symbol}:`, trades.slice(0, 3))

        // Calculate running P&L for each date
        let runningBuyAmount = 0
        let runningSellAmount = 0
        let runningPosition = 0

        const enrichedData = dataWithIndicators.map(candle => {
          const candleDate = new Date(candle.date).setHours(0, 0, 0, 0)

          // Find trades on or before this date
          const tradesUpToDate = trades.filter(trade => {
            const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
            return tradeDate <= candleDate
          })

          // Calculate cumulative buys, sells, and position
          runningBuyAmount = tradesUpToDate
            .filter(t => t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          runningSellAmount = tradesUpToDate
            .filter(t => !t.isBuy)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0)

          runningPosition = tradesUpToDate.reduce((pos, t) =>
            t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

          // Running P&L = Sell proceeds + Current position value - Buy cost
          const currentPositionValue = runningPosition * candle.close
          const runningPnL = runningSellAmount + currentPositionValue - runningBuyAmount

          // Find trades on this specific date for markers
          const dayTrades = trades.filter(trade => {
            const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
            return tradeDate === candleDate
          })

          const buys = dayTrades.filter(t => t.isBuy)
          const sells = dayTrades.filter(t => !t.isBuy)

          if (buys.length > 0 || sells.length > 0) {
            console.log(`Found trades on ${candle.date}: ${buys.length} buys, ${sells.length} sells, Running P&L: $${runningPnL.toFixed(2)}`)
          }

          return {
            ...candle,
            buyPrice: buys.length > 0 ? buys.reduce((sum, t) => sum + t.price, 0) / buys.length : null,
            sellPrice: sells.length > 0 ? sells.reduce((sum, t) => sum + t.price, 0) / sells.length : null,
            buyQuantity: buys.reduce((sum, t) => sum + t.quantity, 0),
            sellQuantity: sells.reduce((sum, t) => sum + t.quantity, 0),
            runningPnL: runningPnL
          }
        })

        const tradesWithMarkers = enrichedData.filter(d => d.buyPrice || d.sellPrice)
        console.log(`Chart has ${tradesWithMarkers.length} days with buy/sell markers`)

        console.log('Final enriched data:', enrichedData.length, 'points')
        console.log('Sample enriched point:', enrichedData[Math.floor(enrichedData.length / 2)])
        setPriceData(enrichedData)

        // Delay chart rendering to ensure DOM is ready
        setTimeout(() => {
          setChartReady(true)
        }, 100)
      } catch (err) {
        console.error('Error loading price chart:', err)
        setError(err.message || 'Failed to load chart data. Please try again later.')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [symbol, useServer, connected, dateRange])

  // Fetch support/resistance levels
  useEffect(() => {
    if (!useServer || !connected || !socketService.socket) return

    console.log(`Fetching support/resistance levels for ${symbol}...`)

    // Listen for the response
    const handleLevelsResult = (data) => {
      if (data.success && data.symbol === symbol) {
        console.log(`Received ${data.levels.length} support/resistance levels for ${symbol}`)
        setSupportResistanceLevels(data.levels)
      }
    }

    socketService.socket.on('support-resistance-result', handleLevelsResult)

    // Request levels for this symbol
    socketService.socket.emit('get-support-resistance', { symbol })

    return () => {
      socketService.socket.off('support-resistance-result', handleLevelsResult)
    }
  }, [symbol, useServer, connected])

  // Recalculate indicators and P&L when dependencies change
  useEffect(() => {
    if (rawData.length === 0) return

    const dataWithIndicators = addIndicators(rawData, indicators)

    // Separate stock and options trades
    const stockTrades = trades.filter(t => t.symbol === symbol)
    const optionsTrades = trades.filter(t =>
      (t.symbol.startsWith(symbol + ' ') || t.underlyingSymbol === symbol) &&
      (t.symbol.includes(' ') || t.symbol.includes('Put') || t.symbol.includes('Call'))
    )

    const enrichedData = dataWithIndicators.map(candle => {
      const candleDate = new Date(candle.date).setHours(0, 0, 0, 0)

      // Calculate Stock P&L
      const stockTradesUpToDate = stockTrades.filter(trade => {
        const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
        return tradeDate <= candleDate
      })

      const stockBuyAmount = stockTradesUpToDate
        .filter(t => t.isBuy)
        .reduce((sum, t) => sum + (t.price * t.quantity), 0)

      const stockSellAmount = stockTradesUpToDate
        .filter(t => !t.isBuy)
        .reduce((sum, t) => sum + (t.price * t.quantity), 0)

      const stockPosition = stockTradesUpToDate.reduce((pos, t) =>
        t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

      const stockPositionValue = stockPosition * candle.close
      const stockPnL = stockSellAmount + stockPositionValue - stockBuyAmount

      // Calculate Options P&L
      let optionsPnL = 0
      const uniqueOptionsSymbols = [...new Set(optionsTrades.map(t => t.symbol))]

      for (const optSymbol of uniqueOptionsSymbols) {
        const optTradesUpToDate = optionsTrades
          .filter(t => t.symbol === optSymbol)
          .filter(trade => {
            const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
            return tradeDate <= candleDate
          })

        if (optTradesUpToDate.length === 0) continue

        const optBuyAmount = optTradesUpToDate
          .filter(t => t.isBuy)
          .reduce((sum, t) => sum + (t.price * t.quantity), 0)

        const optSellAmount = optTradesUpToDate
          .filter(t => !t.isBuy)
          .reduce((sum, t) => sum + (t.price * t.quantity), 0)

        const optPosition = optTradesUpToDate.reduce((pos, t) =>
          t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

        const optPositionValue = optPosition * 0
        optionsPnL += optSellAmount + optPositionValue - optBuyAmount
      }

      // Calculate Total P&L based on checkbox selections
      const totalPnL = (showStockPnL ? stockPnL : 0) + (showOptionsPnL ? optionsPnL : 0)

      // Find stock trades on this specific date for markers
      const dayStockTrades = stockTrades.filter(trade => {
        const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
        return tradeDate === candleDate
      })
      const buys = dayStockTrades.filter(t => t.isBuy)
      const sells = dayStockTrades.filter(t => !t.isBuy)

      return {
        ...candle,
        buyPrice: buys.length > 0 ? buys.reduce((sum, t) => sum + t.price, 0) / buys.length : null,
        sellPrice: sells.length > 0 ? sells.reduce((sum, t) => sum + t.price, 0) / sells.length : null,
        buyQuantity: buys.reduce((sum, t) => sum + t.quantity, 0),
        sellQuantity: sells.reduce((sum, t) => sum + t.quantity, 0),
        stockPnL: stockPnL,
        optionsPnL: optionsPnL,
        runningPnL: totalPnL
      }
    })
    setPriceData(enrichedData)
  }, [showStockPnL, showOptionsPnL, indicators, rawData, trades, symbol])

  const toggleIndicator = (indicator) => {
    setIndicators(prev => ({
      ...prev,
      [indicator]: !prev[indicator]
    }))
  }

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const formatPrice = (value) => {
    return value ? `$${value.toFixed(2)}` : ''
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        padding: '30px',
        maxWidth: '1200px',
        width: '90%',
        maxHeight: '90vh',
        overflow: 'auto'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '24px', color: '#333' }}>
            {symbol} - Price Chart
          </h2>
          <button
            onClick={onClose}
            onTouchEnd={(e) => {
              e.preventDefault()
              onClose()
            }}
            style={{
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '12px 24px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: '500',
              minWidth: '80px',
              minHeight: '44px',
              touchAction: 'manipulation'
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Loading/Error states */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
            Loading price data...
          </div>
        )}

        {error && (
          <div style={{
            textAlign: 'center',
            padding: '40px',
            color: '#dc3545',
            backgroundColor: '#f8d7da',
            borderRadius: '6px'
          }}>
            Error: {error}
          </div>
        )}

        {/* Price Chart */}
        {!loading && !error && priceData.length > 0 && chartReady && (
          <>
            {/* Toggle Controls */}
            <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
              {/* Date Range Selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label style={{ fontSize: '14px', color: '#666', fontWeight: '500' }}>Range:</label>
                <select
                  value={dateRange}
                  onChange={(e) => setDateRange(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: '1px solid #ccc',
                    background: 'white',
                    fontSize: '14px',
                    cursor: 'pointer',
                    color: '#333'
                  }}
                >
                  <option value="1mo">1 Month</option>
                  <option value="3mo">3 Months</option>
                  <option value="6mo">6 Months</option>
                  <option value="1y">1 Year</option>
                  <option value="2y">2 Years</option>
                  <option value="5y">5 Years</option>
                  <option value="max">All Time</option>
                </select>
              </div>

              {/* Support/Resistance Toggle */}
              {supportResistanceLevels.length > 0 && (
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '14px',
                  color: '#666',
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={showSupportResistance}
                    onChange={(e) => setShowSupportResistance(e.target.checked)}
                  />
                  Support/Resistance ({supportResistanceLevels.length})
                </label>
              )}

              {/* Stock P&L Toggle */}
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                background: showStockPnL ? '#e3f2fd' : '#f0f0f0',
                borderRadius: '6px',
                fontSize: '14px',
                color: '#666',
                cursor: 'pointer',
                border: showStockPnL ? '1px solid #3b82f6' : '1px solid transparent'
              }}>
                <input
                  type="checkbox"
                  checked={showStockPnL}
                  onChange={(e) => setShowStockPnL(e.target.checked)}
                />
                Include Stock P&L
              </label>

              {/* Options P&L Toggle */}
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                background: showOptionsPnL ? '#fff7ed' : '#f0f0f0',
                borderRadius: '6px',
                fontSize: '14px',
                color: '#666',
                cursor: 'pointer',
                border: showOptionsPnL ? '1px solid #f59e0b' : '1px solid transparent'
              }}>
                <input
                  type="checkbox"
                  checked={showOptionsPnL}
                  onChange={(e) => setShowOptionsPnL(e.target.checked)}
                />
                Include Options P&L
              </label>
            </div>
            <div style={{ width: '100%', height: '400px', background: '#fafafa', border: '1px solid #ddd' }}>
              <ResponsiveContainer width="100%" height="100%" key={`chart-${priceData.length}`}>
              <ComposedChart data={priceData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis
                  dataKey="timestamp"
                  domain={['auto', 'auto']}
                  type="number"
                  tickFormatter={formatDate}
                  stroke="#666"
                  style={{ fontSize: '12px' }}
                />
                <YAxis
                  yAxisId="price"
                  domain={['auto', 'auto']}
                  tickFormatter={formatPrice}
                  stroke="#666"
                  style={{ fontSize: '12px' }}
                  label={{ value: 'Price', angle: -90, position: 'insideLeft' }}
                />
                <YAxis
                  yAxisId="pnl"
                  orientation="right"
                  domain={['auto', 'auto']}
                  tickFormatter={formatPrice}
                  stroke="#28a745"
                  style={{ fontSize: '12px' }}
                  label={{ value: 'P&L', angle: 90, position: 'insideRight' }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', border: '1px solid #ccc', borderRadius: '6px' }}
                  labelFormatter={formatDate}
                  formatter={(value) => value !== null ? formatPrice(value) : 'N/A'}
                />
                <Legend />

                {/* Price Line */}
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="close"
                  stroke="#2196F3"
                  strokeWidth={2}
                  dot={false}
                  name="Price"
                  connectNulls={true}
                  isAnimationActive={false}
                />

                {/* Total P&L Line - dynamically includes Stock and/or Options based on checkboxes */}
                <Line
                  yAxisId="pnl"
                  type="monotone"
                  dataKey="runningPnL"
                  stroke="#28a745"
                  strokeWidth={3}
                  dot={false}
                  name="Total P&L"
                  connectNulls={true}
                  isAnimationActive={false}
                />

                {/* Buy markers (green dots) */}
                <Scatter
                  yAxisId="price"
                  dataKey="buyPrice"
                  fill="#28a745"
                  shape="circle"
                  name="Buys"
                />

                {/* Sell markers (red dots) */}
                <Scatter
                  yAxisId="price"
                  dataKey="sellPrice"
                  fill="#dc3545"
                  shape="circle"
                  name="Sells"
                />

                {/* Support/Resistance levels and Weekly High/Low */}
                {showSupportResistance && (() => {
                  const linesToShow = []

                  // Get most recent support and resistance levels
                  const supportLevels = supportResistanceLevels.filter(l => l.type === 'support')
                  const resistanceLevels = supportResistanceLevels.filter(l => l.type === 'resistance')

                  const mostRecentSupport = supportLevels.length > 0
                    ? supportLevels.sort((a, b) => b.timestamp - a.timestamp)[0]
                    : null
                  const mostRecentResistance = resistanceLevels.length > 0
                    ? resistanceLevels.sort((a, b) => b.timestamp - a.timestamp)[0]
                    : null

                  // Calculate weekly high and low from price data
                  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000)
                  const recentData = priceData.filter(d => d.timestamp >= oneWeekAgo)

                  const weeklyHigh = recentData.length > 0
                    ? Math.max(...recentData.map(d => d.high))
                    : null
                  const weeklyLow = recentData.length > 0
                    ? Math.min(...recentData.map(d => d.low))
                    : null

                  // Format date helper - short version
                  const formatDate = (timestamp) => {
                    if (!timestamp) return ''
                    const diffDays = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24))
                    if (diffDays === 0) return '0d'
                    if (diffDays === 1) return '1d'
                    return `${diffDays}d`
                  }

                  // Add support level
                  if (mostRecentSupport) {
                    linesToShow.push(
                      <ReferenceLine
                        key="support"
                        y={mostRecentSupport.price}
                        yAxisId="price"
                        stroke="#22c55e"
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        label={{
                          value: `📈 ${mostRecentSupport.price.toFixed(2)} (${formatDate(mostRecentSupport.timestamp)})`,
                          position: 'insideTopLeft',
                          fill: '#22c55e',
                          fontSize: 10,
                          fontWeight: 'bold'
                        }}
                      />
                    )
                  }

                  // Add resistance level
                  if (mostRecentResistance) {
                    linesToShow.push(
                      <ReferenceLine
                        key="resistance"
                        y={mostRecentResistance.price}
                        yAxisId="price"
                        stroke="#ef4444"
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        label={{
                          value: `📉 ${mostRecentResistance.price.toFixed(2)} (${formatDate(mostRecentResistance.timestamp)})`,
                          position: 'insideBottomLeft',
                          fill: '#ef4444',
                          fontSize: 10,
                          fontWeight: 'bold'
                        }}
                      />
                    )
                  }

                  // Add weekly high
                  if (weeklyHigh) {
                    linesToShow.push(
                      <ReferenceLine
                        key="weekly-high"
                        y={weeklyHigh}
                        yAxisId="price"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        strokeDasharray="3 3"
                        label={{
                          value: `⬆️ Week High: $${weeklyHigh.toFixed(2)}`,
                          position: 'left',
                          fill: '#3b82f6',
                          fontSize: 11,
                          fontWeight: 'bold'
                        }}
                      />
                    )
                  }

                  // Add weekly low
                  if (weeklyLow) {
                    linesToShow.push(
                      <ReferenceLine
                        key="weekly-low"
                        y={weeklyLow}
                        yAxisId="price"
                        stroke="#9333ea"
                        strokeWidth={2}
                        strokeDasharray="3 3"
                        label={{
                          value: `⬇️ Week Low: $${weeklyLow.toFixed(2)}`,
                          position: 'left',
                          fill: '#9333ea',
                          fontSize: 11,
                          fontWeight: 'bold'
                        }}
                      />
                    )
                  }

                  return linesToShow
                })()}
              </ComposedChart>
            </ResponsiveContainer>
            </div>

            {/* Trade Summary */}
            <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '6px' }}>
              <strong>Trade Summary:</strong>
              <div style={{ marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                <div>
                  <span style={{ color: '#28a745', fontWeight: 'bold' }}>● Buys:</span> {trades.filter(t => t.isBuy).length} trades
                </div>
                <div>
                  <span style={{ color: '#dc3545', fontWeight: 'bold' }}>● Sells:</span> {trades.filter(t => !t.isBuy).length} trades
                </div>
                <div>
                  Current Price: <strong>${priceData[priceData.length - 1].close.toFixed(2)}</strong>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default PriceChart
