import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import PriceChart from './PriceChart'

function SupportResistanceLevels({ socket, symbols, trades, connected, currentPrices }) {
  const { isDark } = useTheme()
  const [levels, setLevels] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedSymbol, setSelectedSymbol] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [showConfig, setShowConfig] = useState(false)
  const [chartSymbol, setChartSymbol] = useState(null)
  const [resistanceAlerts, setResistanceAlerts] = useState([])
  const [showAlerts, setShowAlerts] = useState(false)
  const [alertsLoading, setAlertsLoading] = useState(false)
  const [emaAlerts, setEmaAlerts] = useState([])
  const [showEmaAlerts, setShowEmaAlerts] = useState(false)
  const [emaAlertsLoading, setEmaAlertsLoading] = useState(false)
  const [config, setConfig] = useState({
    lookbackDays: 7,
    timeframe: 'daily',
    minTouches: 2,
    priceTolerance: 0.5,
    minVolumePercentile: 75,
    maxLevels: 10
  })

  // Fetch levels for selected symbol
  const fetchLevels = (symbol) => {
    console.log('fetchLevels called with symbol:', symbol)
    console.log('Socket exists?', !!socket)
    console.log('Socket connected?', socket?.connected)

    if (!socket) {
      console.error('No socket available!')
      return
    }

    setLoading(true)
    setError(null) // Clear previous errors
    console.log('Emitting get-support-resistance event for:', symbol)
    socket.emit('get-support-resistance', { symbol })
  }

  // Fetch levels for all portfolio symbols
  const fetchAllLevels = () => {
    console.log('fetchAllLevels called')
    console.log('Socket exists?', !!socket)
    console.log('Symbols:', symbols)

    if (!socket || !symbols || symbols.length === 0) {
      console.error('Missing socket or symbols:', { socket: !!socket, symbolsCount: symbols?.length })
      return
    }

    setLoading(true)
    setError(null) // Clear previous errors
    console.log('Emitting get-support-resistance-multi event for:', symbols)
    socket.emit('get-support-resistance-multi', { symbols })
  }

  // Check resistance alerts
  const checkResistanceAlerts = () => {
    if (!socket || !symbols || symbols.length === 0) {
      return
    }

    setAlertsLoading(true)
    console.log('Checking resistance alerts for:', symbols)
    console.log('Using current prices:', currentPrices)
    socket.emit('check-resistance-alerts', { symbols, currentPrices: currentPrices || {} })
  }

  // Check EMA crossovers
  const checkEMACrossovers = () => {
    if (!socket || !symbols || symbols.length === 0) {
      return
    }

    setEmaAlertsLoading(true)
    console.log('Checking EMA crossovers for:', symbols)
    socket.emit('check-ema-crossovers', { symbols })
  }

  // Listen for results
  useEffect(() => {
    if (!socket) {
      console.log('No socket in useEffect')
      return
    }

    console.log('Setting up socket listeners for support/resistance')

    socket.on('support-resistance-result', (data) => {
      console.log('Received support-resistance-result:', data)
      setLoading(false)
      if (data.success) {
        console.log('Setting levels:', data.levels)
        setLevels(data.levels)
        setError(null)
      } else {
        console.error('Request failed:', data.error)
        setError(data.error || 'Failed to fetch support/resistance levels')
        setLevels([])
      }
    })

    socket.on('support-resistance-multi-result', (data) => {
      console.log('Received support-resistance-multi-result:', data)
      setLoading(false)
      if (data.success) {
        // Flatten all levels from all symbols
        const allLevels = Object.values(data.results).flat()
        console.log('Setting all levels:', allLevels)
        setLevels(allLevels)
        setError(null)
      } else {
        console.error('Request failed:', data.error)
        setError(data.error || 'Failed to fetch support/resistance levels')
        setLevels([])
      }
    })

    socket.on('support-resistance-alert', (data) => {
      // Real-time alert for strong levels
      console.log('🎯 Strong support/resistance detected:', data.levels)
      // Could show notification here
    })

    socket.on('resistance-alerts-result', (data) => {
      console.log('Received resistance alerts:', data)
      setAlertsLoading(false)
      if (data.success) {
        setResistanceAlerts(data.alerts)
        setShowAlerts(true)
      } else {
        console.error('Failed to get resistance alerts:', data.error)
      }
    })

    socket.on('ema-crossovers-result', (data) => {
      console.log('Received EMA crossover alerts:', data)
      setEmaAlertsLoading(false)
      if (data.success) {
        setEmaAlerts(data.alerts)
        setShowEmaAlerts(true)
      } else {
        console.error('Failed to get EMA crossover alerts:', data.error)
      }
    })

    return () => {
      socket.off('support-resistance-result')
      socket.off('support-resistance-multi-result')
      socket.off('support-resistance-alert')
      socket.off('resistance-alerts-result')
      socket.off('ema-crossovers-result')
    }
  }, [socket])

  // Auto-refresh every 5 minutes
  useEffect(() => {
    if (!autoRefresh) return

    const interval = setInterval(() => {
      if (selectedSymbol) {
        fetchLevels(selectedSymbol)
      } else if (symbols && symbols.length > 0) {
        fetchAllLevels()
      }
    }, 5 * 60 * 1000)

    return () => clearInterval(interval)
  }, [autoRefresh, selectedSymbol, symbols])

  // Update config
  const updateConfig = () => {
    if (!socket) return
    socket.emit('update-level2-config', { config })
  }

  // Get color based on strength
  const getStrengthColor = (strength) => {
    if (strength >= 80) return '#22c55e' // Strong green
    if (strength >= 60) return '#eab308' // Warning yellow
    return '#94a3b8' // Weak gray
  }

  // Group levels by symbol
  const levelsBySymbol = levels.reduce((acc, level) => {
    if (!acc[level.symbol]) acc[level.symbol] = []
    acc[level.symbol].push(level)
    return acc
  }, {})

  return (
    <div style={{
      background: isDark ? '#1e1e1e' : 'white',
      borderRadius: '12px',
      padding: '20px',
      marginTop: '20px',
      border: isDark ? '1px solid #333' : '1px solid #e5e7eb'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <h2 style={{
          margin: 0,
          fontSize: '18px',
          fontWeight: '600',
          color: isDark ? '#e0e0e0' : '#1f2937'
        }}>
          🎯 Support & Resistance Levels
        </h2>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            color: isDark ? '#b0b0b0' : '#6b7280'
          }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (5m)
          </label>

          <button
            onClick={() => setShowConfig(!showConfig)}
            style={{
              padding: '6px 12px',
              background: isDark ? '#333' : '#f3f4f6',
              color: isDark ? '#e0e0e0' : '#374151',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            ⚙️ Config
          </button>

          <button
            onClick={() => selectedSymbol ? fetchLevels(selectedSymbol) : fetchAllLevels()}
            disabled={loading}
            style={{
              padding: '6px 12px',
              background: loading ? '#94a3b8' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? '⏳ Loading...' : '🔄 Refresh'}
          </button>

          <button
            onClick={checkResistanceAlerts}
            disabled={alertsLoading || !symbols || symbols.length === 0}
            style={{
              padding: '6px 12px',
              background: alertsLoading ? '#94a3b8' : '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: (alertsLoading || !symbols || symbols.length === 0) ? 'not-allowed' : 'pointer',
              fontWeight: '500',
              position: 'relative'
            }}
          >
            {alertsLoading ? '⏳' : '🚨'} Resistance Alerts
            {resistanceAlerts.length > 0 && !alertsLoading && (
              <span style={{
                position: 'absolute',
                top: '-8px',
                right: '-8px',
                background: '#22c55e',
                color: 'white',
                borderRadius: '50%',
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '11px',
                fontWeight: 'bold'
              }}>
                {resistanceAlerts.length}
              </span>
            )}
          </button>

          <button
            onClick={checkEMACrossovers}
            disabled={emaAlertsLoading || !symbols || symbols.length === 0}
            style={{
              padding: '6px 12px',
              background: emaAlertsLoading ? '#94a3b8' : '#8b5cf6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: (emaAlertsLoading || !symbols || symbols.length === 0) ? 'not-allowed' : 'pointer',
              fontWeight: '500',
              position: 'relative'
            }}
          >
            {emaAlertsLoading ? '⏳' : '📊'} EMA Crossovers
            {emaAlerts.length > 0 && !emaAlertsLoading && (
              <span style={{
                position: 'absolute',
                top: '-8px',
                right: '-8px',
                background: '#22c55e',
                color: 'white',
                borderRadius: '50%',
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '11px',
                fontWeight: 'bold'
              }}>
                {emaAlerts.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Configuration Panel */}
      {showConfig && (
        <div style={{
          background: isDark ? '#2a2a2a' : '#f9fafb',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '15px'
        }}>
          <h3 style={{
            margin: '0 0 10px 0',
            fontSize: '14px',
            fontWeight: '600',
            color: isDark ? '#e0e0e0' : '#1f2937'
          }}>
            Detection Settings
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={{
                fontSize: '12px',
                color: isDark ? '#b0b0b0' : '#6b7280',
                display: 'block',
                marginBottom: '4px'
              }}>
                Timeframe
              </label>
              <select
                value={config.timeframe}
                onChange={(e) => setConfig({ ...config, timeframe: e.target.value })}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: isDark ? '1px solid #444' : '1px solid #d1d5db',
                  background: isDark ? '#1e1e1e' : 'white',
                  color: isDark ? '#e0e0e0' : '#1f2937',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                <option value="daily">Daily (Free)</option>
                <option value="1hour">1 Hour - Requires Starter Plan</option>
                <option value="15min">15 Min - Requires Starter Plan</option>
                <option value="5min">5 Min - Requires Starter Plan</option>
              </select>
            </div>
            <div>
              <label style={{
                fontSize: '12px',
                color: isDark ? '#b0b0b0' : '#6b7280',
                display: 'block',
                marginBottom: '4px'
              }}>
                Lookback {config.timeframe === 'daily' ? 'Days' : 'Days'} {config.timeframe !== 'daily' && '(use 1 for today only)'}
              </label>
              <input
                type="number"
                value={config.lookbackDays}
                onChange={(e) => setConfig({ ...config, lookbackDays: parseInt(e.target.value) })}
                min="1"
                max={config.timeframe === 'daily' ? 365 : 5}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: isDark ? '1px solid #444' : '1px solid #d1d5db',
                  background: isDark ? '#1e1e1e' : 'white',
                  color: isDark ? '#e0e0e0' : '#1f2937',
                  fontSize: '13px'
                }}
              />
            </div>
            <div>
              <label style={{
                fontSize: '12px',
                color: isDark ? '#b0b0b0' : '#6b7280',
                display: 'block',
                marginBottom: '4px'
              }}>
                Min Touches
              </label>
              <input
                type="number"
                value={config.minTouches}
                onChange={(e) => setConfig({ ...config, minTouches: parseInt(e.target.value) })}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: isDark ? '1px solid #444' : '1px solid #d1d5db',
                  background: isDark ? '#1e1e1e' : 'white',
                  color: isDark ? '#e0e0e0' : '#1f2937',
                  fontSize: '13px'
                }}
              />
            </div>
            <div>
              <label style={{
                fontSize: '12px',
                color: isDark ? '#b0b0b0' : '#6b7280',
                display: 'block',
                marginBottom: '4px'
              }}>
                Price Tolerance (%)
              </label>
              <input
                type="number"
                step="0.1"
                value={config.priceTolerance}
                onChange={(e) => setConfig({ ...config, priceTolerance: parseFloat(e.target.value) })}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: isDark ? '1px solid #444' : '1px solid #d1d5db',
                  background: isDark ? '#1e1e1e' : 'white',
                  color: isDark ? '#e0e0e0' : '#1f2937',
                  fontSize: '13px'
                }}
              />
            </div>
            <div>
              <label style={{
                fontSize: '12px',
                color: isDark ? '#b0b0b0' : '#6b7280',
                display: 'block',
                marginBottom: '4px'
              }}>
                Volume Percentile
              </label>
              <input
                type="number"
                value={config.minVolumePercentile}
                onChange={(e) => setConfig({ ...config, minVolumePercentile: parseInt(e.target.value) })}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: isDark ? '1px solid #444' : '1px solid #d1d5db',
                  background: isDark ? '#1e1e1e' : 'white',
                  color: isDark ? '#e0e0e0' : '#1f2937',
                  fontSize: '13px'
                }}
              />
            </div>
          </div>
          <button
            onClick={updateConfig}
            style={{
              marginTop: '10px',
              padding: '6px 12px',
              background: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            Save Configuration
          </button>
        </div>
      )}

      {/* Symbol Filter */}
      {symbols && symbols.length > 0 && (
        <div style={{ marginBottom: '15px' }}>
          <select
            value={selectedSymbol || ''}
            onChange={(e) => {
              const symbol = e.target.value || null
              setSelectedSymbol(symbol)
              if (symbol) {
                fetchLevels(symbol)
              } else {
                fetchAllLevels()
              }
            }}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: isDark ? '1px solid #444' : '1px solid #d1d5db',
              background: isDark ? '#2a2a2a' : 'white',
              color: isDark ? '#e0e0e0' : '#1f2937',
              fontSize: '14px',
              cursor: 'pointer'
            }}
          >
            <option value="">All Symbols ({symbols.length})</option>
            {[...symbols].sort().map(symbol => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
        </div>
      )}

      {/* Resistance Alerts Display */}
      {showAlerts && resistanceAlerts.length > 0 && (
        <div style={{
          background: isDark ? '#2a2a2a' : '#fef2f2',
          border: `2px solid #ef4444`,
          borderRadius: '8px',
          padding: '15px',
          marginBottom: '15px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{
              margin: 0,
              fontSize: '16px',
              fontWeight: '600',
              color: '#ef4444'
            }}>
              🚨 Resistance Alerts ({resistanceAlerts.length})
            </h3>
            <button
              onClick={() => setShowAlerts(false)}
              style={{
                padding: '4px 10px',
                background: 'transparent',
                color: isDark ? '#888' : '#6b7280',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer'
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: '13px', color: isDark ? '#888' : '#6b7280', marginBottom: '12px' }}>
            Stocks near or above their highest resistance levels
          </div>
          <div style={{ display: 'grid', gap: '8px' }}>
            {resistanceAlerts.map((alert, idx) => {
              const statusColor = alert.status === 'broken' ? '#22c55e' : alert.status === 'testing' ? '#eab308' : '#ef4444'
              const statusText = alert.status === 'broken' ? 'BROKEN ✓' : alert.status === 'testing' ? 'TESTING' : 'APPROACHING'

              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px',
                    background: isDark ? '#1e1e1e' : 'white',
                    borderRadius: '6px',
                    borderLeft: `4px solid ${statusColor}`
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: '15px',
                      fontWeight: '600',
                      color: isDark ? '#e0e0e0' : '#1f2937',
                      marginBottom: '4px'
                    }}>
                      {alert.symbol}
                      <span style={{
                        marginLeft: '8px',
                        fontSize: '12px',
                        fontWeight: '500',
                        color: statusColor,
                        background: isDark ? '#2a2a2a' : '#f3f4f6',
                        padding: '2px 8px',
                        borderRadius: '4px'
                      }}>
                        {statusText}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '13px',
                      color: isDark ? '#888' : '#6b7280'
                    }}>
                      Current: ${alert.currentPrice.toFixed(2)} • Resistance: ${alert.resistancePrice.toFixed(2)}
                      {' • '}{alert.percentFromResistance >= 0 ? '+' : ''}{alert.percentFromResistance}%
                      {' • '}{alert.touches} touches
                    </div>
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}>
                    <div style={{
                      width: '60px',
                      height: '6px',
                      background: isDark ? '#333' : '#e5e7eb',
                      borderRadius: '3px',
                      overflow: 'hidden'
                    }}>
                      <div style={{
                        width: `${alert.resistanceStrength}%`,
                        height: '100%',
                        background: alert.resistanceStrength >= 80 ? '#22c55e' : alert.resistanceStrength >= 60 ? '#eab308' : '#94a3b8',
                        borderRadius: '3px'
                      }} />
                    </div>
                    <span style={{
                      fontSize: '13px',
                      fontWeight: '600',
                      color: alert.resistanceStrength >= 80 ? '#22c55e' : alert.resistanceStrength >= 60 ? '#eab308' : '#94a3b8',
                      minWidth: '35px'
                    }}>
                      {alert.resistanceStrength}
                    </span>
                    <button
                      onClick={() => setChartSymbol(alert.symbol)}
                      style={{
                        padding: '6px 10px',
                        background: '#3b82f6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: '500',
                        marginLeft: '8px'
                      }}
                    >
                      📊 Chart
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showAlerts && resistanceAlerts.length === 0 && !alertsLoading && (
        <div style={{
          background: isDark ? '#2a2a2a' : '#f0fdf4',
          border: '1px solid #22c55e',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '15px',
          color: '#166534'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '4px' }}>✅ All Clear</div>
          <div style={{ fontSize: '14px' }}>No stocks are currently near or above resistance levels.</div>
        </div>
      )}

      {/* EMA Crossover Alerts Display */}
      {showEmaAlerts && emaAlerts.length > 0 && (
        <div style={{
          background: isDark ? '#2a2a2a' : '#f5f3ff',
          border: '2px solid #8b5cf6',
          borderRadius: '8px',
          padding: '15px',
          marginBottom: '15px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{
              margin: 0,
              fontSize: '16px',
              fontWeight: '600',
              color: '#8b5cf6'
            }}>
              📊 EMA Crossover Alerts ({emaAlerts.length})
            </h3>
            <button
              onClick={() => setShowEmaAlerts(false)}
              style={{
                padding: '4px 10px',
                background: 'transparent',
                color: isDark ? '#888' : '#6b7280',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer'
              }}
            >
              ✕
            </button>
          </div>
          <div style={{
            fontSize: '14px',
            color: isDark ? '#b0b0b0' : '#6b7280',
            marginBottom: '12px'
          }}>
            EMA 9 and EMA 21 crossovers detected
          </div>
          <div style={{ display: 'grid', gap: '8px' }}>
            {emaAlerts.map((alert, idx) => {
              const isBullish = alert.type === 'golden_cross'
              const signalColor = isBullish ? '#22c55e' : '#ef4444'
              const signalText = isBullish ? '🟢 GOLDEN CROSS' : '🔴 DEATH CROSS'
              const bgColor = isBullish
                ? (isDark ? '#1a3a2a' : '#f0fdf4')
                : (isDark ? '#3a1a1a' : '#fef2f2')

              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px',
                    background: bgColor,
                    border: `1px solid ${signalColor}`,
                    borderRadius: '6px'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                      <span style={{
                        fontWeight: '700',
                        fontSize: '15px',
                        color: isDark ? '#e0e0e0' : '#1f2937'
                      }}>
                        {alert.symbol}
                      </span>
                      <span style={{
                        padding: '2px 8px',
                        background: signalColor,
                        color: 'white',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: '700'
                      }}>
                        {signalText}
                      </span>
                      <span style={{
                        fontSize: '13px',
                        color: isDark ? '#b0b0b0' : '#6b7280'
                      }}>
                        ${alert.currentPrice}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '13px',
                      color: isDark ? '#b0b0b0' : '#6b7280'
                    }}>
                      EMA 9: ${alert.ema9} | EMA 21: ${alert.ema21} | Diff: {alert.percentDiff > 0 ? '+' : ''}{alert.percentDiff}%
                    </div>
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <button
                      onClick={() => setChartSymbol(alert.symbol)}
                      style={{
                        padding: '6px 10px',
                        background: '#3b82f6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: '500'
                      }}
                    >
                      📊 Chart
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showEmaAlerts && emaAlerts.length === 0 && !emaAlertsLoading && (
        <div style={{
          background: isDark ? '#2a2a2a' : '#f0fdf4',
          border: '1px solid #22c55e',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '15px',
          color: '#166534'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '4px' }}>✅ No EMA Crossovers</div>
          <div style={{ fontSize: '14px' }}>No EMA 9/21 crossovers detected in your portfolio.</div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div style={{
          background: '#fef2f2',
          border: '1px solid #fca5a5',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '15px',
          color: '#991b1b'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '4px' }}>❌ Error</div>
          <div style={{ fontSize: '14px' }}>{error}</div>
          {error.includes('API key') && (
            <div style={{ fontSize: '13px', marginTop: '8px', color: '#dc2626' }}>
              💡 Get a free API key at <a href="https://polygon.io" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }}>polygon.io</a>, then set the POLYGON_API_KEY environment variable in Railway.
            </div>
          )}
          {(error.includes('0 candles') || error.includes('Insufficient historical data')) && config.timeframe !== 'daily' && (
            <div style={{ fontSize: '13px', marginTop: '8px', color: '#dc2626' }}>
              ⚠️ Intraday data (5min, 15min, 1hour) requires <a href="https://polygon.io/pricing" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }}>Polygon Starter plan</a> ($99/mo). Free tier only supports Daily timeframe.
            </div>
          )}
        </div>
      )}

      {/* Levels Display */}
      {levels.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '40px',
          color: isDark ? '#666' : '#9ca3af'
        }}>
          {loading ? '⏳ Loading levels...' : '📊 No support/resistance levels detected yet. Click Refresh to scan.'}
        </div>
      ) : (
        <div>
          {Object.entries(levelsBySymbol).map(([symbol, symbolLevels]) => (
            <div key={symbol} style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h3 style={{
                  margin: 0,
                  fontSize: '16px',
                  fontWeight: '600',
                  color: isDark ? '#e0e0e0' : '#1f2937'
                }}>
                  {symbol}
                </h3>
                <button
                  onClick={() => setChartSymbol(symbol)}
                  style={{
                    padding: '6px 12px',
                    background: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    fontWeight: '500'
                  }}
                >
                  📊 View Chart
                </button>
              </div>

              <div style={{ display: 'grid', gap: '8px' }}>
                {symbolLevels
                  .sort((a, b) => b.strength - a.strength)
                  .map((level, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px',
                        background: isDark ? '#2a2a2a' : '#f9fafb',
                        borderRadius: '8px',
                        borderLeft: `4px solid ${level.type === 'support' ? '#22c55e' : '#ef4444'}`
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{
                          fontSize: '14px',
                          fontWeight: '600',
                          color: level.type === 'support' ? '#22c55e' : '#ef4444'
                        }}>
                          {level.type === 'support' ? '📈 Support' : '📉 Resistance'} @ ${level.price.toFixed(2)}
                        </div>
                        <div style={{
                          fontSize: '12px',
                          color: isDark ? '#888' : '#6b7280',
                          marginTop: '4px'
                        }}>
                          {level.touches} touches • {level.methods || 'swing_pivot'}
                          {level.timestamp && (
                            <>
                              {' • '}
                              {(() => {
                                const date = new Date(level.timestamp)
                                const now = new Date()
                                const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24))
                                if (diffDays === 0) return 'Today'
                                if (diffDays === 1) return 'Yesterday'
                                if (diffDays < 7) return `${diffDays} days ago`
                                return date.toLocaleDateString()
                              })()}
                            </>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{
                            fontSize: '11px',
                            color: isDark ? '#888' : '#6b7280',
                            marginBottom: '2px'
                          }}>
                            Distance
                          </div>
                          <div style={{
                            fontSize: '13px',
                            fontWeight: '500',
                            color: isDark ? '#e0e0e0' : '#374151'
                          }}>
                            {level.distanceFromPrice > 0 ? '+' : ''}{level.distanceFromPrice}%
                          </div>
                        </div>

                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}>
                          <div style={{
                            width: '60px',
                            height: '6px',
                            background: isDark ? '#333' : '#e5e7eb',
                            borderRadius: '3px',
                            overflow: 'hidden'
                          }}>
                            <div style={{
                              width: `${level.strength}%`,
                              height: '100%',
                              background: getStrengthColor(level.strength),
                              borderRadius: '3px'
                            }} />
                          </div>
                          <span style={{
                            fontSize: '13px',
                            fontWeight: '600',
                            color: getStrengthColor(level.strength),
                            minWidth: '35px'
                          }}>
                            {level.strength}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div style={{
        marginTop: '15px',
        padding: '10px',
        background: isDark ? '#2a2a2a' : '#f9fafb',
        borderRadius: '6px',
        fontSize: '12px',
        color: isDark ? '#888' : '#6b7280'
      }}>
        <strong>Strength Score:</strong> <span style={{ color: '#22c55e' }}>80-100 (Strong)</span> • <span style={{ color: '#eab308' }}>60-79 (Moderate)</span> • <span style={{ color: '#94a3b8' }}>0-59 (Weak)</span>
      </div>

      {/* Price Chart with Support/Resistance */}
      {chartSymbol && trades && (
        <PriceChart
          symbol={chartSymbol}
          trades={trades}
          onClose={() => setChartSymbol(null)}
          useServer={true}
          connected={connected}
        />
      )}
    </div>
  )
}

export default SupportResistanceLevels
