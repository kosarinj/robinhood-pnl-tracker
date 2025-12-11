import React, { useState, useEffect } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import './TradingSignals.css'

function SignalPerformance({ symbols, onClose, useServer, connected }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [accuracyData, setAccuracyData] = useState([])
  const [selectedSymbol, setSelectedSymbol] = useState('ALL')
  const [timeRange, setTimeRange] = useState(168) // 7 days default

  useEffect(() => {
    if (useServer && connected) {
      fetchSignalAccuracy()
    }
  }, [selectedSymbol, timeRange, useServer, connected])

  const fetchSignalAccuracy = async () => {
    try {
      setLoading(true)
      setError(null)

      const symbol = selectedSymbol === 'ALL' ? '' : selectedSymbol
      const url = `http://localhost:5000/api/signal-accuracy?symbol=${symbol}&hours=${timeRange}`

      const response = await fetch(url)
      const data = await response.json()

      if (data.success) {
        setAccuracyData(data.data)
      } else {
        setError(data.error || 'Failed to fetch signal accuracy')
      }
    } catch (err) {
      console.error('Error fetching signal accuracy:', err)
      setError('Failed to fetch signal accuracy: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const formatIntervalLabel = (minutes) => {
    if (minutes < 60) return `${minutes}min`
    const hours = minutes / 60
    return `${hours}hr`
  }

  const prepareChartData = () => {
    const grouped = {}

    accuracyData.forEach(item => {
      const interval = formatIntervalLabel(item.interval)
      if (!grouped[interval]) {
        grouped[interval] = { interval }
      }
      grouped[interval][`${item.signalType}_accuracy`] = parseFloat(item.accuracy)
      grouped[interval][`${item.signalType}_avgChange`] = parseFloat(item.avgChange)
      grouped[interval][`${item.signalType}_total`] = item.total
    })

    return Object.values(grouped).sort((a, b) => {
      const aMin = parseInt(a.interval)
      const bMin = parseInt(b.interval)
      return aMin - bMin
    })
  }

  const calculateOverallStats = () => {
    if (accuracyData.length === 0) return null

    const buySignals = accuracyData.filter(item => item.signalType === 'BUY')
    const sellSignals = accuracyData.filter(item => item.signalType === 'SELL')

    const totalBuy = buySignals.reduce((sum, item) => sum + item.total, 0)
    const correctBuy = buySignals.reduce((sum, item) => sum + item.correct, 0)
    const totalSell = sellSignals.reduce((sum, item) => sum + item.total, 0)
    const correctSell = sellSignals.reduce((sum, item) => sum + item.correct, 0)

    return {
      buy: {
        total: totalBuy,
        correct: correctBuy,
        accuracy: totalBuy > 0 ? ((correctBuy / totalBuy) * 100).toFixed(1) : 0
      },
      sell: {
        total: totalSell,
        correct: correctSell,
        accuracy: totalSell > 0 ? ((correctSell / totalSell) * 100).toFixed(1) : 0
      },
      overall: {
        total: totalBuy + totalSell,
        correct: correctBuy + correctSell,
        accuracy: (totalBuy + totalSell) > 0 ? (((correctBuy + correctSell) / (totalBuy + totalSell)) * 100).toFixed(1) : 0
      }
    }
  }

  if (!useServer || !connected) {
    return (
      <div className="signals-overlay">
        <div className="signals-modal" style={{ maxWidth: '600px' }}>
          <div className="signals-header">
            <h2>Signal Performance Analysis</h2>
            <button onClick={onClose} className="close-button">×</button>
          </div>
          <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
            Signal performance analysis requires server mode to be enabled.
          </div>
        </div>
      </div>
    )
  }

  const chartData = prepareChartData()
  const stats = calculateOverallStats()

  return (
    <div className="signals-overlay">
      <div className="signals-modal" style={{ maxWidth: '1200px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="signals-header">
          <h2>📊 Signal Performance Analysis</h2>
          <button onClick={onClose} className="close-button">×</button>
        </div>

        <div style={{ padding: '20px' }}>
          {/* Controls */}
          <div style={{ marginBottom: '20px', display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <label style={{ marginRight: '8px', fontWeight: '600' }}>Symbol:</label>
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #ddd' }}
              >
                <option value="ALL">All Symbols</option>
                {symbols && symbols.map(symbol => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ marginRight: '8px', fontWeight: '600' }}>Time Range:</label>
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(parseInt(e.target.value))}
                style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #ddd' }}
              >
                <option value={24}>Last 24 Hours</option>
                <option value={168}>Last 7 Days</option>
                <option value={720}>Last 30 Days</option>
              </select>
            </div>

            <button
              onClick={fetchSignalAccuracy}
              style={{
                padding: '8px 16px',
                background: '#667eea',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              🔄 Refresh
            </button>
          </div>

          {loading && (
            <div style={{ padding: '60px', textAlign: 'center', color: '#666' }}>
              <div style={{ fontSize: '40px', marginBottom: '15px' }}>📊</div>
              <div>Loading signal performance data...</div>
            </div>
          )}

          {error && (
            <div style={{
              padding: '20px',
              background: '#fee',
              border: '1px solid #fcc',
              borderRadius: '8px',
              color: '#c33',
              marginBottom: '20px'
            }}>
              {error}
            </div>
          )}

          {!loading && !error && accuracyData.length === 0 && (
            <div style={{ padding: '60px', textAlign: 'center', color: '#666' }}>
              <div style={{ fontSize: '40px', marginBottom: '15px' }}>📭</div>
              <div>No signal performance data available yet.</div>
              <div style={{ fontSize: '14px', marginTop: '10px' }}>
                Signals need to be recorded for at least a few hours before performance can be analyzed.
              </div>
            </div>
          )}

          {!loading && !error && accuracyData.length > 0 && stats && (
            <>
              {/* Overall Statistics */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '15px',
                marginBottom: '30px'
              }}>
                <div style={{
                  padding: '20px',
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  borderRadius: '12px',
                  color: 'white',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>Overall Accuracy</div>
                  <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{stats.overall.accuracy}%</div>
                  <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>
                    {stats.overall.correct} / {stats.overall.total} signals
                  </div>
                </div>

                <div style={{
                  padding: '20px',
                  background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
                  borderRadius: '12px',
                  color: 'white',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>BUY Signal Accuracy</div>
                  <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{stats.buy.accuracy}%</div>
                  <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>
                    {stats.buy.correct} / {stats.buy.total} signals
                  </div>
                </div>

                <div style={{
                  padding: '20px',
                  background: 'linear-gradient(135deg, #ee0979 0%, #ff6a00 100%)',
                  borderRadius: '12px',
                  color: 'white',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>SELL Signal Accuracy</div>
                  <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{stats.sell.accuracy}%</div>
                  <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>
                    {stats.sell.correct} / {stats.sell.total} signals
                  </div>
                </div>
              </div>

              {/* Accuracy by Time Interval Chart */}
              <div style={{ marginBottom: '30px' }}>
                <h3 style={{ marginBottom: '15px' }}>Signal Accuracy by Time Interval</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="interval" />
                    <YAxis label={{ value: 'Accuracy %', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="BUY_accuracy" fill="#38ef7d" name="BUY Accuracy %" />
                    <Bar dataKey="SELL_accuracy" fill="#ff6a00" name="SELL Accuracy %" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Average Price Change Chart */}
              <div style={{ marginBottom: '30px' }}>
                <h3 style={{ marginBottom: '15px' }}>Average Price Change After Signal</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="interval" />
                    <YAxis label={{ value: 'Avg Change %', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="BUY_avgChange" stroke="#38ef7d" name="BUY Avg Change %" strokeWidth={2} />
                    <Line type="monotone" dataKey="SELL_avgChange" stroke="#ff6a00" name="SELL Avg Change %" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Detailed Table */}
              <div>
                <h3 style={{ marginBottom: '15px' }}>Detailed Performance Metrics</h3>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    background: 'white',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    borderRadius: '8px',
                    overflow: 'hidden'
                  }}>
                    <thead>
                      <tr style={{ background: '#f8f9fa' }}>
                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Signal Type</th>
                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Time Interval</th>
                        <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #dee2e6' }}>Total Signals</th>
                        <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #dee2e6' }}>Correct</th>
                        <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #dee2e6' }}>Accuracy</th>
                        <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #dee2e6' }}>Avg Change</th>
                        <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #dee2e6' }}>Min Change</th>
                        <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #dee2e6' }}>Max Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accuracyData.map((item, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '12px' }}>
                            <span style={{
                              padding: '4px 10px',
                              borderRadius: '4px',
                              background: item.signalType === 'BUY' ? '#d4edda' : '#f8d7da',
                              color: item.signalType === 'BUY' ? '#155724' : '#721c24',
                              fontWeight: '600',
                              fontSize: '13px'
                            }}>
                              {item.signalType}
                            </span>
                          </td>
                          <td style={{ padding: '12px' }}>{formatIntervalLabel(item.interval)}</td>
                          <td style={{ padding: '12px', textAlign: 'right' }}>{item.total}</td>
                          <td style={{ padding: '12px', textAlign: 'right' }}>{item.correct}</td>
                          <td style={{ padding: '12px', textAlign: 'right', fontWeight: 'bold' }}>
                            <span style={{ color: parseFloat(item.accuracy) >= 60 ? '#28a745' : parseFloat(item.accuracy) >= 40 ? '#ffc107' : '#dc3545' }}>
                              {item.accuracy}%
                            </span>
                          </td>
                          <td style={{ padding: '12px', textAlign: 'right', color: parseFloat(item.avgChange) >= 0 ? '#28a745' : '#dc3545' }}>
                            {item.avgChange}%
                          </td>
                          <td style={{ padding: '12px', textAlign: 'right', color: '#666' }}>{item.minChange}%</td>
                          <td style={{ padding: '12px', textAlign: 'right', color: '#666' }}>{item.maxChange}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Insights */}
              <div style={{
                marginTop: '30px',
                padding: '20px',
                background: '#e3f2fd',
                borderRadius: '8px',
                border: '1px solid #90caf9'
              }}>
                <h3 style={{ marginTop: 0, color: '#1976d2' }}>💡 Insights</h3>
                <ul style={{ margin: '10px 0', paddingLeft: '20px', color: '#0d47a1' }}>
                  <li style={{ marginBottom: '8px' }}>
                    Signals are most accurate at <strong>{chartData.length > 0 ? chartData.reduce((max, item) => {
                      const buyAcc = item.BUY_accuracy || 0
                      const sellAcc = item.SELL_accuracy || 0
                      return Math.max(buyAcc, sellAcc) > Math.max(max.BUY_accuracy || 0, max.SELL_accuracy || 0) ? item : max
                    }, chartData[0]).interval : 'N/A'}</strong> interval
                  </li>
                  <li style={{ marginBottom: '8px' }}>
                    {stats.buy.accuracy > stats.sell.accuracy
                      ? `BUY signals are ${(stats.buy.accuracy - stats.sell.accuracy).toFixed(1)}% more accurate than SELL signals`
                      : `SELL signals are ${(stats.sell.accuracy - stats.buy.accuracy).toFixed(1)}% more accurate than BUY signals`}
                  </li>
                  <li>
                    Performance data is based on {stats.overall.total} signal{stats.overall.total !== 1 ? 's' : ''} over the last {timeRange} hours
                  </li>
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default SignalPerformance
