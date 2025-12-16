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
  ReferenceLine
} from 'recharts'
import { socketService } from '../services/socketService'

function DailyPnLChart({ useServer, connected }) {
  const [chartData, setChartData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (useServer && connected) {
      loadDailyPnL()
    } else {
      setLoading(false)
      setError('Connect to server to view daily P&L history')
    }
  }, [useServer, connected])

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
      return (
        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          padding: '10px',
          border: '1px solid #ccc',
          borderRadius: '6px',
          fontSize: '13px'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>
            {new Date(label).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
          {payload.map((entry, index) => (
            <div key={index} style={{ color: entry.color }}>
              {entry.name}: {formatCurrency(entry.value)}
            </div>
          ))}
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
        background: '#f8f9fa',
        borderRadius: '8px',
        marginBottom: '20px',
        textAlign: 'center'
      }}>
        Loading daily P&L history...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        padding: '15px',
        background: '#fff3cd',
        color: '#856404',
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
      background: 'white',
      borderRadius: '12px',
      padding: collapsed ? '15px' : '20px',
      marginBottom: '20px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
      border: '1px solid #e0e0e0'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: collapsed ? '0' : '15px'
      }}>
        <h3 style={{ margin: 0, fontSize: '18px', color: '#333' }}>
          📈 Daily Total P&L History
        </h3>
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

      {!collapsed && (
        <>
          <div style={{
            display: 'flex',
            gap: '20px',
            marginBottom: '15px',
            fontSize: '14px'
          }}>
            <div>
              <span style={{ color: '#666' }}>Days tracked:</span>{' '}
              <strong>{chartData.length}</strong>
            </div>
            <div>
              <span style={{ color: '#666' }}>Latest Total P&L:</span>{' '}
              <strong style={{
                color: chartData[chartData.length - 1]?.totalPnL >= 0 ? '#28a745' : '#dc3545'
              }}>
                {formatCurrency(chartData[chartData.length - 1]?.totalPnL || 0)}
              </strong>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                stroke="#666"
                style={{ fontSize: '12px' }}
              />
              <YAxis
                tickFormatter={formatCurrency}
                stroke="#666"
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
            color: '#666',
            marginTop: '10px',
            fontStyle: 'italic'
          }}>
            * Chart shows historical Total P&L and Daily P&L changes from saved snapshots
          </div>
        </>
      )}
    </div>
  )
}

export default DailyPnLChart
