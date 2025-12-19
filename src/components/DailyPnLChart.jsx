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
import { useTheme } from '../contexts/ThemeContext'

function DailyPnLChart({ useServer, connected }) {
  const { isDark } = useTheme()
  const [chartData, setChartData] = useState([])
  const [symbolData, setSymbolData] = useState([])
  const [symbols, setSymbols] = useState([])
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [loading, setLoading] = useState(true)
  const [symbolLoading, setSymbolLoading] = useState(false)
  const [error, setError] = useState(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (useServer && connected) {
      loadDailyPnL()
      loadSymbols()
    } else {
      setLoading(false)
      setError('Connect to server to view daily P&L history')
    }
  }, [useServer, connected])

  // Load symbol-specific data when symbol is selected
  useEffect(() => {
    if (selectedSymbol && useServer && connected) {
      loadSymbolPnL(selectedSymbol)
    }
  }, [selectedSymbol, useServer, connected])

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

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value)
  }

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
            {new Date(label).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
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

  if (!useServer || !connected) {
    return null
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

  if (error) {
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
            onClick={() => loadDailyPnL()}
            style={{
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500',
              marginRight: '10px'
            }}
          >
            🔄 Refresh
          </button>
          <button
            onClick={async () => {
              console.log('🔍 Requesting debug snapshots raw data...')
              try {
                const result = await socketService.debugSnapshotsRaw()
                console.log('🐛 DEBUG SNAPSHOTS RAW RESULT:', result)
                console.table(result.dates)
                if (result.sampleSnapshots && result.sampleSnapshots.length > 0) {
                  console.table(result.sampleSnapshots)
                }
              } catch (err) {
                console.error('❌ Error getting debug snapshots:', err)
              }
            }}
            style={{
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500',
              marginRight: '10px'
            }}
          >
            🐛 Debug DB
          </button>
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
              {/* DEBUG INFO */}
              <div style={{
                background: '#fff3cd',
                border: '1px solid #ffc107',
                borderRadius: '6px',
                padding: '12px',
                marginBottom: '15px',
                fontSize: '12px',
                fontFamily: 'monospace',
                maxHeight: '200px',
                overflow: 'auto'
              }}>
                <strong>🐛 DEBUG:</strong> Chart has {chartData.length} days<br/>
                <strong>Date Range:</strong> {chartData.length > 0 ? `${chartData[0].date} to ${chartData[chartData.length - 1].date}` : 'No data'}<br/>
                <strong>All Dates:</strong> {chartData.map(d => d.date).join(', ')}<br/>
                <strong>Last 3 entries:</strong><br/>
                {chartData.slice(-3).map((d, i) => (
                  <div key={i} style={{ marginLeft: '10px', fontSize: '11px' }}>
                    {d.date}: Total=${d.totalPnL?.toFixed(2) || 'null'}, Daily=${d.dailyPnL?.toFixed(2) || 'null'}
                  </div>
                ))}
              </div>

              <div style={{
                display: 'flex',
                gap: '20px',
                marginBottom: '15px',
                fontSize: '14px',
                color: isDark ? '#b0b0b0' : '#666'
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
                </LineChart>
              </ResponsiveContainer>

              <div style={{
                fontSize: '12px',
                color: isDark ? '#999' : '#666',
                marginTop: '10px',
                fontStyle: 'italic'
              }}>
                * Chart shows historical portfolio Total P&L and Daily P&L changes from saved snapshots
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
                color: isDark ? '#b0b0b0' : '#666'
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
                  <span style={{ color: isDark ? '#b0b0b0' : '#666' }}>Latest P&L:</span>{' '}
                  <strong style={{
                    color: symbolData[symbolData.length - 1]?.totalPnL >= 0 ? '#28a745' : '#dc3545'
                  }}>
                    {formatCurrency(symbolData[symbolData.length - 1]?.totalPnL || 0)}
                  </strong>
                </div>
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
                  <Line
                    yAxisId="pnl"
                    type="monotone"
                    dataKey="totalPnL"
                    stroke="#28a745"
                    strokeWidth={3}
                    dot={{ fill: '#28a745', r: 3 }}
                    name="Actual P&L"
                    connectNulls={true}
                    isAnimationActive={false}
                  />
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
                </ComposedChart>
              </ResponsiveContainer>

              <div style={{
                fontSize: '12px',
                color: isDark ? '#999' : '#666',
                marginTop: '10px',
                fontStyle: 'italic'
              }}>
                * Chart shows {selectedSymbol} stock price (right axis) and P&L (left axis) over time
                <br />
                * Hypothetical P&L shows what your current P&L would be if the price moved to that historical level
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
