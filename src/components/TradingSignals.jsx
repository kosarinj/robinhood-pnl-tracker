import React, { useState, useEffect } from 'react'
import { getIntradayData } from '../utils/marketData'
import { generateSignal } from '../utils/technicalAnalysis'
import { socketService } from '../services/socketService'

function TradingSignals({ openPositions, onClose, onSignalsUpdate, fetchingEnabled, useServer, connected }) {
  const [signals, setSignals] = useState([])
  const [previousSignals, setPreviousSignals] = useState([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [analysisStatus, setAnalysisStatus] = useState([])
  const [errorCount, setErrorCount] = useState(0)

  useEffect(() => {
    // Only fetch signals if fetching is enabled
    if (!fetchingEnabled) {
      setLoading(false)
      return
    }

    analyzePositions()

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    // Auto-refresh every 5 minutes if enabled
    let interval
    if (autoRefresh) {
      interval = setInterval(() => {
        analyzePositions()
      }, 300000) // 5 minutes
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [openPositions, autoRefresh, fetchingEnabled])

  const detectChanges = (newSignal, previousSignalsList) => {
    const prevSignal = previousSignalsList.find(s => s.symbol === newSignal.symbol)
    if (!prevSignal) {
      return { hasChanges: false, changes: [] }
    }

    const changes = []

    // Check if signal type changed (BUY -> SELL, etc.)
    if (prevSignal.signal !== newSignal.signal) {
      changes.push(`Signal: ${prevSignal.signal} → ${newSignal.signal}`)
    }

    // Check if strength changed
    if (prevSignal.strengthLabel !== newSignal.strengthLabel) {
      changes.push(`Strength: ${prevSignal.strengthLabel} → ${newSignal.strengthLabel}`)
    }

    return {
      hasChanges: changes.length > 0,
      changes
    }
  }

  const analyzePositions = async () => {
    setLoading(true)
    setAnalysisStatus([])
    setErrorCount(0)
    const newSignals = []
    const statusUpdates = []
    let errors = 0

    // Only analyze stock positions (not options)
    const stockPositions = openPositions.filter(p => !p.isOption)

    console.log(`Analyzing ${stockPositions.length} stock positions...`)

    if (useServer && connected) {
      // SERVER MODE: Request signals from server
      try {
        console.log('📡 Requesting signals from server...')
        const symbols = stockPositions.map(p => p.symbol)

        // Set up listener BEFORE requesting
        let timeout

        const handleSignalsUpdate = (data) => {
          console.log('📊 Received signals from server:', data.signals.length)

          // Clear timeout
          if (timeout) clearTimeout(timeout)

          // Merge server signals with position data
          const mergedSignals = data.signals.map(serverSignal => {
            const position = stockPositions.find(p => p.symbol === serverSignal.symbol)
            return {
              ...serverSignal,
              position: position?.avgCost?.position || 0,
              currentPrice: position?.currentPrice || 0
            }
          })

          setSignals(mergedSignals)
          setLastUpdate(new Date())
          setLoading(false)

          if (onSignalsUpdate) {
            onSignalsUpdate(mergedSignals)
          }

          // Cleanup listeners
          socketService.off('signals-update', handleSignalsUpdate)
          socketService.off('signals-error', handleSignalsError)
        }

        const handleSignalsError = (data) => {
          console.error('❌ Error from server:', data.error)

          // Clear timeout
          if (timeout) clearTimeout(timeout)

          setLoading(false)

          // Cleanup listeners
          socketService.off('signals-update', handleSignalsUpdate)
          socketService.off('signals-error', handleSignalsError)
        }

        // Set up listeners first
        socketService.onSignalsUpdate(handleSignalsUpdate)
        socketService.socket.on('signals-error', handleSignalsError)

        // Set timeout in case server doesn't respond
        timeout = setTimeout(() => {
          console.error('⏱️ Timeout waiting for signals from server')
          setLoading(false)
          socketService.off('signals-update', handleSignalsUpdate)
          socketService.off('signals-error', handleSignalsError)
        }, 30000) // 30 second timeout

        // Now request signals
        socketService.requestSignals(symbols)
      } catch (error) {
        console.error('Error requesting signals from server:', error)
        setLoading(false)
      }
    } else {
      // STANDALONE MODE: Fetch signals locally (original logic)
      for (const position of stockPositions) {
        try {
          console.log(`Fetching data for ${position.symbol}...`)
          statusUpdates.push({ symbol: position.symbol, status: 'fetching' })
          setAnalysisStatus([...statusUpdates])

          const historicalData = await getIntradayData(position.symbol)

          if (historicalData && historicalData.length > 0) {
            console.log(`✓ Got ${historicalData.length} data points for ${position.symbol}`)
            statusUpdates[statusUpdates.length - 1].status = 'success'
            statusUpdates[statusUpdates.length - 1].dataPoints = historicalData.length
            setAnalysisStatus([...statusUpdates])

            const currentPrice = position.currentPrice
            const signal = generateSignal(position.symbol, currentPrice, historicalData)

            // Detect changes from previous refresh
            const changeInfo = detectChanges(signal, previousSignals)

              newSignals.push({
              ...signal,
              position: position.avgCost.position,
              currentPrice,
              costBasis: position.avgCost.avgCostBasis,
              hasChanges: changeInfo.hasChanges,
              changes: changeInfo.changes
            })

            // Send notification for strong signals
            if (signal.strengthLabel === 'Strong' || signal.strengthLabel === 'Very Strong') {
              sendNotification(signal)
            }
          } else {
            console.warn(`✗ No data received for ${position.symbol}`)
            statusUpdates[statusUpdates.length - 1].status = 'no_data'
            setAnalysisStatus([...statusUpdates])
            errors++
          }

          // Small delay between symbols
          await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (error) {
          console.error(`✗ Error analyzing ${position.symbol}:`, error)
          statusUpdates[statusUpdates.length - 1].status = 'error'
          statusUpdates[statusUpdates.length - 1].error = error.message
          setAnalysisStatus([...statusUpdates])
          errors++
        }
      }

      setErrorCount(errors)
      console.log(`Analysis complete. Generated ${newSignals.length} signals.`)

      // Sort signals alphabetically by symbol
      newSignals.sort((a, b) => a.symbol.localeCompare(b.symbol))

      // Save current signals as previous before updating
      setPreviousSignals(signals)
      setSignals(newSignals)
      setLastUpdate(new Date())
      setLoading(false)

      // Notify parent component of updated signals
      if (onSignalsUpdate) {
        onSignalsUpdate(newSignals)
      }
    } // End of standalone mode else block
  }

  const sendNotification = (signal) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      const title = `${signal.signal} Signal: ${signal.symbol}`
      const body = `${signal.strengthLabel} - ${signal.reasons[0]}`

      new Notification(title, {
        body,
        icon: signal.signal === 'BUY' ? '🟢' : signal.signal === 'SELL' ? '🔴' : '🟡',
        tag: signal.symbol // Prevents duplicate notifications
      })
    }
  }

  const getSignalColor = (signal) => {
    if (signal === 'BUY') return '#28a745'
    if (signal === 'SELL') return '#dc3545'
    return '#6c757d'
  }

  const getSignalIcon = (signal) => {
    if (signal === 'BUY') return '🟢'
    if (signal === 'SELL') return '🔴'
    return '🟡'
  }

  return (
    <div className="signals-panel">
      <div className="signals-header">
        <h3>📈 Trading Signals</h3>
        <div className="signals-controls">
          <label>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (5 min)
          </label>
          <button onClick={analyzePositions} disabled={loading || !fetchingEnabled} className="btn-small">
            {loading ? 'Analyzing...' : 'Refresh Now'}
          </button>
          <button onClick={onClose} className="btn-small btn-cancel">
            Close
          </button>
        </div>
      </div>

      {lastUpdate && (
        <div className="last-update">
          Last updated: {lastUpdate.toLocaleTimeString()}
        </div>
      )}

      <div className="disclaimer">
        ⚠️ <strong>Educational purposes only.</strong> Not financial advice. Always do your own research.
      </div>

      {!fetchingEnabled && (
        <div style={{ padding: '15px', background: '#fff3cd', marginBottom: '10px', fontSize: '14px', color: '#856404', borderRadius: '8px', border: '1px solid #ffeaa7' }}>
          ℹ️ <strong>Signal fetching is disabled.</strong> Enable "Enable Signal Fetching" checkbox in the controls above to start analyzing positions.
        </div>
      )}

      <div style={{ padding: '10px', background: '#f0f0f0', marginBottom: '10px', fontSize: '12px' }}>
        <strong>Debug Info:</strong> Received {openPositions.length} open stock positions to analyze
        {errorCount > 0 && <span style={{ color: 'red', marginLeft: '10px' }}>| {errorCount} errors</span>}
      </div>

      {analysisStatus.length > 0 && (
        <div style={{ padding: '10px', background: '#fff3cd', marginBottom: '10px', fontSize: '12px', maxHeight: '200px', overflowY: 'auto' }}>
          <strong>Analysis Status:</strong>
          {analysisStatus.map((status, idx) => (
            <div key={idx} style={{ padding: '2px 0' }}>
              {status.symbol}: {
                status.status === 'fetching' ? '⏳ Fetching...' :
                status.status === 'success' ? `✅ Success (${status.dataPoints} data points)` :
                status.status === 'no_data' ? '❌ No data received' :
                `❌ Error: ${status.error}`
              }
            </div>
          ))}
        </div>
      )}

      {!loading && signals.filter(s => s.hasChanges).length > 0 && (
        <div className="changes-summary">
          <div className="changes-summary-header">
            ⚡ <strong>{signals.filter(s => s.hasChanges).length} Signal{signals.filter(s => s.hasChanges).length !== 1 ? 's' : ''} Changed</strong> (since last refresh)
          </div>
          <div className="changes-summary-list">
            {signals.filter(s => s.hasChanges).map((signal, idx) => (
              <div key={idx} className="changes-summary-item">
                <span className="changes-summary-symbol">{signal.symbol}:</span>
                <span className="changes-summary-details">
                  {signal.changes.join(', ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && signals.length === 0 ? (
        <div className="signals-loading">
          Analyzing positions... This may take a few minutes due to API rate limits.
        </div>
      ) : (
        <div style={{ maxHeight: '600px', overflowY: 'auto', overflowX: 'hidden' }}>
        <div className="signals-grid">
          {signals.map((signal, index) => (
            <div
              key={index}
              className={`signal-card ${signal.hasChanges ? 'signal-changed' : ''}`}
              style={{ borderLeftColor: getSignalColor(signal.signal) }}
            >
              <div className="signal-header">
                <h4>{signal.symbol}</h4>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {signal.hasChanges && (
                    <div className="change-badge">
                      ⚡ CHANGED
                    </div>
                  )}
                  <div className="signal-badge" style={{ background: getSignalColor(signal.signal) }}>
                    {getSignalIcon(signal.signal)} {signal.signal}
                  </div>
                </div>
              </div>

              {signal.hasChanges && signal.changes.length > 0 && (
                <div className="signal-changes">
                  {signal.changes.map((change, i) => (
                    <div key={i} className="change-item">
                      {change}
                    </div>
                  ))}
                </div>
              )}

              <div className="signal-strength">
                Strength: <strong>{signal.strengthLabel}</strong> ({signal.strength}/7)
              </div>

              <div className="signal-price-info">
                <div>Current: ${signal.currentPrice?.toFixed(2)}</div>
                <div>Cost Basis: ${signal.costBasis?.toFixed(2)}</div>
                <div>Position: {signal.position} shares</div>
              </div>

              <div className="signal-indicators">
                <div className="indicator-row">
                  <span>EMA 9:</span> <span className="indicator-value">${signal.indicators.ema9}</span>
                </div>
                <div className="indicator-row">
                  <span>EMA 21:</span> <span className="indicator-value">${signal.indicators.ema21}</span>
                </div>
                <div className="indicator-row">
                  <span>RSI:</span> <span className="indicator-value">{signal.indicators.rsi}</span>
                </div>
                <div className="indicator-row">
                  <span>MACD:</span> <span className="indicator-value">{signal.indicators.macd}</span>
                </div>
              </div>

              <div className="signal-reasons">
                <strong>Analysis:</strong>
                <ul>
                  {signal.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
        </div>
      )}

      {!loading && signals.length === 0 && (
        <div className="no-signals">
          No signals available. Make sure you have open stock positions.
        </div>
      )}
    </div>
  )
}

export default TradingSignals
