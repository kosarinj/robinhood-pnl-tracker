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
          console.log('Using server to fetch historical data (no CORS issues)')
          historical = await socketService.fetchHistoricalData(symbol, '6mo', '1d')
          // Convert date strings back to Date objects
          historical = historical.map(item => ({
            ...item,
            date: new Date(item.date)
          }))
        } else {
          console.log('Using CORS proxies to fetch historical data')
          // Fetch 6 months of daily data (Yahoo Finance doesn't support 4-hour directly)
          historical = await fetchHistoricalPrices(symbol, '6mo', '1d')
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
          // Force multiple resize events
          setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
          setTimeout(() => window.dispatchEvent(new Event('resize')), 150)
          setTimeout(() => window.dispatchEvent(new Event('resize')), 300)
        }, 100)
      } catch (err) {
        console.error('Error loading price chart:', err)
        setError(err.message || 'Failed to load chart data. Please try again later.')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [symbol, trades, useServer, connected])

  // Recalculate indicators when they change (without refetching data)
  useEffect(() => {
    if (rawData.length === 0) return

    const dataWithIndicators = addIndicators(rawData, indicators)
    const enrichedData = dataWithIndicators.map(candle => {
      const candleDate = new Date(candle.date).setHours(0, 0, 0, 0)

      // Calculate running P&L
      const tradesUpToDate = trades.filter(trade => {
        const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
        return tradeDate <= candleDate
      })

      const runningBuyAmount = tradesUpToDate
        .filter(t => t.isBuy)
        .reduce((sum, t) => sum + (t.price * t.quantity), 0)

      const runningSellAmount = tradesUpToDate
        .filter(t => !t.isBuy)
        .reduce((sum, t) => sum + (t.price * t.quantity), 0)

      const runningPosition = tradesUpToDate.reduce((pos, t) =>
        t.isBuy ? pos + t.quantity : pos - t.quantity, 0)

      const currentPositionValue = runningPosition * candle.close
      const runningPnL = runningSellAmount + currentPositionValue - runningBuyAmount

      // Find trades on this specific date
      const dayTrades = trades.filter(trade => {
        const tradeDate = new Date(trade.date || trade.transDate).setHours(0, 0, 0, 0)
        return tradeDate === candleDate
      })
      const buys = dayTrades.filter(t => t.isBuy)
      const sells = dayTrades.filter(t => !t.isBuy)

      return {
        ...candle,
        buyPrice: buys.length > 0 ? buys.reduce((sum, t) => sum + t.price, 0) / buys.length : null,
        sellPrice: sells.length > 0 ? sells.reduce((sum, t) => sum + t.price, 0) / sells.length : null,
        buyQuantity: buys.reduce((sum, t) => sum + t.quantity, 0),
        sellQuantity: sells.reduce((sum, t) => sum + t.quantity, 0),
        runningPnL: runningPnL
      }
    })
    setPriceData(enrichedData)
  }, [indicators, rawData, trades])

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
            style={{
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 16px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500'
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Debug Info - Always show if we have data */}
        {priceData.length > 0 && (
          <div style={{
            background: '#fffacd',
            padding: '15px',
            marginBottom: '15px',
            borderRadius: '8px',
            fontSize: '13px',
            fontFamily: 'monospace',
            border: '2px solid #ffd700'
          }}>
            <strong style={{ fontSize: '14px', color: '#333' }}>🐛 DEBUG INFO:</strong><br/>
            <div style={{ marginTop: '8px', lineHeight: '1.8' }}>
              📊 Data Points: <strong>{priceData.length}</strong><br/>
              🔢 First: timestamp={priceData[0]?.timestamp}, close=${priceData[0]?.close?.toFixed(2)}<br/>
              🔢 Middle: timestamp={priceData[Math.floor(priceData.length/2)]?.timestamp}, close=${priceData[Math.floor(priceData.length/2)]?.close?.toFixed(2)}<br/>
              🔢 Last: timestamp={priceData[priceData.length-1]?.timestamp}, close=${priceData[priceData.length-1]?.close?.toFixed(2)}
            </div>
          </div>
        )}


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

                {/* Running P&L Line */}
                <Line
                  yAxisId="pnl"
                  type="monotone"
                  dataKey="runningPnL"
                  stroke="#28a745"
                  strokeWidth={2}
                  dot={false}
                  name="Running P&L"
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
