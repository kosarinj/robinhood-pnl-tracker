import React, { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts'
import { format } from 'date-fns'
import { marketDataService } from '../services/marketDataService'
import { identifyDownturns, analyzeTradeOpportunities, calculateOverallScore, formatCurrency, formatPercentage } from '../utils/marketCorrelation'

function MarketAnalysis({ trades, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [spData, setSpData] = useState([])
  const [nasdaqData, setNasdaqData] = useState([])
  const [dowData, setDowData] = useState([])
  const [spDownturns, setSpDownturns] = useState([])
  const [nasdaqDownturns, setNasdaqDownturns] = useState([])
  const [dowDownturns, setDowDownturns] = useState([])
  const [spAnalyzed, setSpAnalyzed] = useState([])
  const [nasdaqAnalyzed, setNasdaqAnalyzed] = useState([])
  const [dowAnalyzed, setDowAnalyzed] = useState([])
  const [spScore, setSpScore] = useState(null)
  const [nasdaqScore, setNasdaqScore] = useState(null)
  const [dowScore, setDowScore] = useState(null)
  const [selectedIndex, setSelectedIndex] = useState('sp500') // 'sp500', 'nasdaq', or 'dow'
  const [expandedDownturns, setExpandedDownturns] = useState({})

  useEffect(() => {
    analyzeMarket()
  }, [trades])

  const analyzeMarket = async () => {
    try {
      setLoading(true)
      setError(null)

      // Get date range from trades
      const tradeDates = trades.map(t => new Date(t.date))
      const startDate = new Date(Math.min(...tradeDates))
      const endDate = new Date(Math.max(...tradeDates))

      // Add buffer (30 days before and after)
      startDate.setDate(startDate.getDate() - 30)
      endDate.setDate(endDate.getDate() + 30)

      console.log(`Analyzing market from ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`)

      // Fetch S&P 500, NASDAQ, and Dow Jones data in parallel
      const [spDataResult, nasdaqDataResult, dowDataResult] = await Promise.all([
        marketDataService.fetchHistoricalData('^GSPC', startDate, endDate),
        marketDataService.fetchHistoricalData('^IXIC', startDate, endDate),
        marketDataService.fetchHistoricalData('^DJI', startDate, endDate)
      ])

      setSpData(spDataResult)
      setNasdaqData(nasdaqDataResult)
      setDowData(dowDataResult)

      // Analyze S&P 500
      const spDetectedDownturns = identifyDownturns(spDataResult)
      setSpDownturns(spDetectedDownturns)
      const spAnalyzedResult = analyzeTradeOpportunities(trades, spDetectedDownturns)
      setSpAnalyzed(spAnalyzedResult)
      const spScoreResult = calculateOverallScore(spAnalyzedResult)
      setSpScore(spScoreResult)

      // Analyze NASDAQ
      const nasdaqDetectedDownturns = identifyDownturns(nasdaqDataResult)
      setNasdaqDownturns(nasdaqDetectedDownturns)
      const nasdaqAnalyzedResult = analyzeTradeOpportunities(trades, nasdaqDetectedDownturns)
      setNasdaqAnalyzed(nasdaqAnalyzedResult)
      const nasdaqScoreResult = calculateOverallScore(nasdaqAnalyzedResult)
      setNasdaqScore(nasdaqScoreResult)

      // Analyze Dow Jones
      const dowDetectedDownturns = identifyDownturns(dowDataResult)
      setDowDownturns(dowDetectedDownturns)
      const dowAnalyzedResult = analyzeTradeOpportunities(trades, dowDetectedDownturns)
      setDowAnalyzed(dowAnalyzedResult)
      const dowScoreResult = calculateOverallScore(dowAnalyzedResult)
      setDowScore(dowScoreResult)

      setLoading(false)

    } catch (err) {
      console.error('Market analysis error:', err)
      setError(err.message)
      setLoading(false)
    }
  }

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'severe': return '#dc3545'
      case 'moderate': return '#fd7e14'
      case 'mild': return '#ffc107'
      default: return '#6c757d'
    }
  }

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'severe': return '🔴'
      case 'moderate': return '🟠'
      case 'mild': return '🟡'
      default: return '⚪'
    }
  }

  const toggleDownturnExpanded = (index) => {
    setExpandedDownturns(prev => ({
      ...prev,
      [index]: !prev[index]
    }))
  }

  // Get data for selected index
  const currentMarketData = selectedIndex === 'sp500' ? spData : selectedIndex === 'nasdaq' ? nasdaqData : dowData
  const currentDownturns = selectedIndex === 'sp500' ? spDownturns : selectedIndex === 'nasdaq' ? nasdaqDownturns : dowDownturns
  const currentAnalyzed = selectedIndex === 'sp500' ? spAnalyzed : selectedIndex === 'nasdaq' ? nasdaqAnalyzed : dowAnalyzed
  const currentScore = selectedIndex === 'sp500' ? spScore : selectedIndex === 'nasdaq' ? nasdaqScore : dowScore
  const currentIndexName = selectedIndex === 'sp500' ? 'S&P 500' : selectedIndex === 'nasdaq' ? 'NASDAQ' : 'Dow Jones'

  if (loading) {
    return (
      <div className="signal-popup" style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 999999,
        maxWidth: '90%',
        width: '800px',
        maxHeight: '90vh',
        overflowY: 'auto'
      }}>
        <div className="signal-popup-header">
          <h4>📉 Market Downturn Analysis</h4>
          <button onClick={onClose} className="btn-small btn-cancel">✗</button>
        </div>
        <div style={{ padding: '40px', textAlign: 'center' }}>
          <div style={{ fontSize: '18px', marginBottom: '10px' }}>⏳ Analyzing market conditions...</div>
          <div style={{ fontSize: '14px', color: '#666' }}>Fetching S&P 500 data and identifying downturns</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="signal-popup" style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 999999,
        maxWidth: '90%',
        width: '800px'
      }}>
        <div className="signal-popup-header">
          <h4>📉 Market Downturn Analysis</h4>
          <button onClick={onClose} className="btn-small btn-cancel">✗</button>
        </div>
        <div style={{ padding: '20px' }}>
          <div style={{ padding: '15px', background: '#f8d7da', color: '#721c24', borderRadius: '6px', border: '1px solid #f5c6cb' }}>
            <strong>❌ Error:</strong> {error}
            <div style={{ marginTop: '10px', fontSize: '14px' }}>
              Please check your internet connection and try again.
            </div>
          </div>
          <button onClick={analyzeMarket} className="btn-small" style={{ marginTop: '15px' }}>
            🔄 Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 999998
        }}
      />

      {/* Popup */}
      <div className="signal-popup" style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 999999,
        maxWidth: '95%',
        width: '1000px',
        maxHeight: '90vh',
        overflowY: 'auto'
      }}>
        <div className="signal-popup-header">
          <h4>📉 Market Downturn Analysis</h4>
          <button onClick={onClose} className="btn-small btn-cancel">✗</button>
        </div>

        {/* Index Selector */}
        <div style={{ padding: '15px 20px', background: '#f8f9fa', borderBottom: '1px solid #dee2e6', display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setSelectedIndex('sp500')}
            style={{
              padding: '10px 20px',
              borderRadius: '6px',
              border: 'none',
              background: selectedIndex === 'sp500' ? '#667eea' : 'white',
              color: selectedIndex === 'sp500' ? 'white' : '#333',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: selectedIndex === 'sp500' ? '0 2px 8px rgba(102, 126, 234, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
              transition: 'all 0.2s'
            }}
          >
            📊 S&P 500
          </button>
          <button
            onClick={() => setSelectedIndex('nasdaq')}
            style={{
              padding: '10px 20px',
              borderRadius: '6px',
              border: 'none',
              background: selectedIndex === 'nasdaq' ? '#667eea' : 'white',
              color: selectedIndex === 'nasdaq' ? 'white' : '#333',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: selectedIndex === 'nasdaq' ? '0 2px 8px rgba(102, 126, 234, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
              transition: 'all 0.2s'
            }}
          >
            💻 NASDAQ
          </button>
          <button
            onClick={() => setSelectedIndex('dow')}
            style={{
              padding: '10px 20px',
              borderRadius: '6px',
              border: 'none',
              background: selectedIndex === 'dow' ? '#667eea' : 'white',
              color: selectedIndex === 'dow' ? 'white' : '#333',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: selectedIndex === 'dow' ? '0 2px 8px rgba(102, 126, 234, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
              transition: 'all 0.2s'
            }}
          >
            🏭 Dow Jones
          </button>
        </div>

        {/* Overall Score */}
        {currentScore && (
          <div style={{ padding: '20px', background: '#f8f9fa', borderBottom: '1px solid #dee2e6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: '20px' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>Overall Timing Score</div>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#667eea' }}>
                  {currentScore.score}/10
                </div>
                <div style={{ fontSize: '16px', color: '#333', marginTop: '5px' }}>{currentScore.label}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>Downturns Detected</div>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#333' }}>
                  {currentScore.totalOpportunities}
                </div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
                  opportunities
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>Capitalized On</div>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#28a745' }}>
                  {currentScore.capitalizedOpportunities}
                </div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
                  bought during dip
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>Missed</div>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#dc3545' }}>
                  {currentScore.missedOpportunities}
                </div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
                  no activity
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Market Timeline Chart */}
        <div style={{ padding: '20px' }}>
          <h5 style={{ marginBottom: '15px' }}>{currentIndexName} Timeline</h5>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={currentMarketData.slice(-180)} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(date) => format(new Date(date), 'MMM dd')}
                style={{ fontSize: '12px' }}
              />
              <YAxis
                style={{ fontSize: '12px' }}
                domain={['auto', 'auto']}
              />
              <Tooltip
                labelFormatter={(date) => format(new Date(date), 'MMM dd, yyyy')}
                formatter={(value) => [`$${value.toFixed(2)}`, currentIndexName]}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="close"
                stroke="#667eea"
                strokeWidth={2}
                dot={false}
                name={currentIndexName}
              />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', textAlign: 'center' }}>
            Showing last 180 days
          </div>
        </div>

        {/* Downturn Opportunities */}
        <div style={{ padding: '20px', borderTop: '1px solid #dee2e6' }}>
          <h5 style={{ marginBottom: '15px' }}>Downturn Opportunities</h5>

          {currentAnalyzed.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
              <div style={{ fontSize: '48px', marginBottom: '10px' }}>🎉</div>
              <div style={{ fontSize: '18px', marginBottom: '5px' }}>No significant downturns detected</div>
              <div style={{ fontSize: '14px' }}>The market was relatively stable during your trading period</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              {currentAnalyzed.map((downturn, index) => (
                <div
                  key={index}
                  style={{
                    border: `2px solid ${getSeverityColor(downturn.severity)}`,
                    borderRadius: '8px',
                    padding: '15px',
                    background: 'white'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '5px' }}>
                        {getSeverityIcon(downturn.severity)} {downturn.severity.toUpperCase()} Downturn
                      </div>
                      <div style={{ fontSize: '14px', color: '#666' }}>
                        {format(downturn.startDate, 'MMM dd, yyyy')} - {format(downturn.endDate, 'MMM dd, yyyy')} ({downturn.duration} days)
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: getSeverityColor(downturn.severity) }}>
                        {formatPercentage(downturn.change)}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666' }}>market drop</div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '10px' }}>
                    <div style={{ padding: '10px', background: '#f8f9fa', borderRadius: '6px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Your Activity</div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#333' }}>
                        {downturn.analysis.buyCount} buys, {downturn.analysis.sellCount} sells
                      </div>
                    </div>
                    <div style={{ padding: '10px', background: '#f8f9fa', borderRadius: '6px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Shares Bought</div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#333' }}>
                        {downturn.analysis.totalSharesBought}
                      </div>
                    </div>
                    <div style={{ padding: '10px', background: '#f8f9fa', borderRadius: '6px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Timing</div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: downturn.analysis.timing.color }}>
                        {downturn.analysis.timing.label}
                      </div>
                    </div>
                  </div>

                  <div style={{
                    padding: '12px',
                    background: downturn.analysis.timing.score >= 7 ? '#d4edda' : downturn.analysis.timing.score >= 4 ? '#fff3cd' : '#f8d7da',
                    borderRadius: '6px',
                    fontSize: '14px'
                  }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>
                      {downturn.analysis.timing.description}
                    </div>
                    {downturn.analysis.buyCount > 0 && downturn.analysis.additionalShares > 0 && (
                      <div style={{ fontSize: '13px', marginTop: '8px' }}>
                        💡 <strong>Suggestion:</strong> You bought an average of {downturn.analysis.avgSharesBought.toFixed(0)} shares per trade.
                        During a {downturn.severity} downturn, consider buying {downturn.analysis.suggestedShares} shares instead
                        ({downturn.analysis.additionalShares} more per trade).
                        {downturn.analysis.missedOpportunity > 0 && (
                          <div style={{ marginTop: '5px' }}>
                            Potential missed gain: <strong>{formatCurrency(downturn.analysis.missedOpportunity)}</strong>
                          </div>
                        )}
                      </div>
                    )}
                    {downturn.analysis.buyCount === 0 && (
                      <div style={{ fontSize: '13px', marginTop: '8px' }}>
                        💡 <strong>Missed opportunity:</strong> No purchases during this downturn. Consider buying during market dips!
                      </div>
                    )}
                  </div>

                  {/* Symbol Breakdown - Drill Down */}
                  {downturn.analysis.symbolBreakdown && downturn.analysis.symbolBreakdown.length > 0 && (
                    <div style={{ marginTop: '15px' }}>
                      <button
                        onClick={() => toggleDownturnExpanded(index)}
                        style={{
                          background: '#667eea',
                          color: 'white',
                          border: 'none',
                          padding: '8px 16px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          fontWeight: '600',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                      >
                        {expandedDownturns[index] ? '▼' : '▶'} View by Instrument ({downturn.analysis.symbolBreakdown.length} symbols)
                      </button>

                      {expandedDownturns[index] && (
                        <div style={{ marginTop: '10px', background: '#f8f9fa', padding: '15px', borderRadius: '6px' }}>
                          <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ borderBottom: '2px solid #dee2e6' }}>
                                <th style={{ textAlign: 'left', padding: '8px' }}>Symbol</th>
                                <th style={{ textAlign: 'center', padding: '8px' }}>Buys</th>
                                <th style={{ textAlign: 'center', padding: '8px' }}>Sells</th>
                                <th style={{ textAlign: 'right', padding: '8px' }}>Shares Bought</th>
                                <th style={{ textAlign: 'right', padding: '8px' }}>Avg Buy Price</th>
                                <th style={{ textAlign: 'center', padding: '8px' }}>Timing</th>
                              </tr>
                            </thead>
                            <tbody>
                              {downturn.analysis.symbolBreakdown.map((symbolData, symbolIndex) => (
                                <tr key={symbolIndex} style={{ borderBottom: '1px solid #e9ecef' }}>
                                  <td style={{ padding: '8px', fontWeight: 'bold' }}>{symbolData.symbol}</td>
                                  <td style={{ textAlign: 'center', padding: '8px', color: '#28a745' }}>{symbolData.buyCount}</td>
                                  <td style={{ textAlign: 'center', padding: '8px', color: '#dc3545' }}>{symbolData.sellCount}</td>
                                  <td style={{ textAlign: 'right', padding: '8px' }}>{symbolData.sharesBought}</td>
                                  <td style={{ textAlign: 'right', padding: '8px' }}>{formatCurrency(symbolData.avgBuyPrice)}</td>
                                  <td style={{ textAlign: 'center', padding: '8px' }}>
                                    <span style={{
                                      padding: '4px 8px',
                                      borderRadius: '4px',
                                      background: symbolData.timing.color,
                                      color: 'white',
                                      fontSize: '11px',
                                      fontWeight: 'bold'
                                    }}>
                                      {symbolData.timing.label}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info Footer */}
        <div style={{ padding: '15px', background: '#f8f9fa', borderTop: '1px solid #dee2e6', fontSize: '12px', color: '#666' }}>
          <strong>ℹ️ How this works:</strong> This analysis compares major market indices (S&P 500, NASDAQ, and Dow Jones) with your trading activity.
          Buying during downturns (when prices are lower) and holding through recovery typically leads to better returns.
          The suggestions are based on your average position sizes and the severity of each downturn. Switch between indices to see different market perspectives.
        </div>
      </div>
    </>
  )
}

export default MarketAnalysis
