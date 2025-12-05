import React, { useState, useEffect, useRef } from 'react'

function TradesTable({ data, allData, trades, manualPrices, splitAdjustments, visiblePnlColumns, tradingSignals, showChartsInHistory, onManualPriceUpdate, onClearManualPrice, onSplitAdjustment, onClearSplitAdjustment, onTotalsUpdate }) {
  const [sortConfig, setSortConfig] = useState({ key: 'symbol', direction: 'asc' })
  const [expandedSymbol, setExpandedSymbol] = useState(null)
  const [editingPrice, setEditingPrice] = useState(null)
  const [priceInput, setPriceInput] = useState('')
  const [editingSplit, setEditingSplit] = useState(null)
  const [splitInput, setSplitInput] = useState('')
  const [hoveredSignal, setHoveredSignal] = useState(null)
  const [popupPosition, setPopupPosition] = useState({ top: 0, left: 0 })
  const hideTimeoutRef = useRef(null)
  const chartContainerRef = useRef({})
  const [whatIfSymbol, setWhatIfSymbol] = useState(null)
  const [whatIfShares, setWhatIfShares] = useState('')
  const [whatIfPrice, setWhatIfPrice] = useState('')
  const [whatIfMethod, setWhatIfMethod] = useState('real')
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

  const getSignalForSymbol = (symbol) => {
    if (!tradingSignals || tradingSignals.length === 0) return null
    return tradingSignals.find(s => s.symbol === symbol)
  }

  const getSignalColor = (signal) => {
    if (signal === 'BUY') return '#28a745'
    if (signal === 'SELL') return '#dc3545'
    return '#6c757d'
  }

  const getSignalIcon = (signal) => {
    if (signal === 'BUY') return '🟢'
    if (signal === 'SELL') return '🔴'
    return '⚪'
  }

  const handleSort = (key) => {
    let direction = 'asc'
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc'
    }
    setSortConfig({ key, direction })
  }

  const getSortedData = (dataToSort) => {
    if (!sortConfig.key) return dataToSort

    return [...dataToSort].sort((a, b) => {
      let aValue, bValue

      // Handle nested properties
      if (sortConfig.key.includes('.')) {
        const keys = sortConfig.key.split('.')
        aValue = keys.reduce((obj, key) => obj[key], a)
        bValue = keys.reduce((obj, key) => obj[key], b)
      } else {
        aValue = a[sortConfig.key]
        bValue = b[sortConfig.key]
      }

      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1
      }
      return 0
    })
  }

  const getSortIcon = (columnKey) => {
    if (sortConfig.key !== columnKey) {
      return ' ⇅'
    }
    return sortConfig.direction === 'asc' ? ' ▲' : ' ▼'
  }

  const toggleExpand = (symbol) => {
    setExpandedSymbol(expandedSymbol === symbol ? null : symbol)
  }

  const startEditingPrice = (symbol, currentPrice) => {
    setEditingPrice(symbol)
    setPriceInput(currentPrice.toString())
  }

  const savePrice = (symbol) => {
    if (priceInput && !isNaN(priceInput)) {
      onManualPriceUpdate(symbol, priceInput)
    }
    setEditingPrice(null)
    setPriceInput('')
  }

  const cancelEditingPrice = () => {
    setEditingPrice(null)
    setPriceInput('')
  }

  const getTradesForSymbol = (symbol) => {
    if (!trades) return []
    return trades.filter(t => t.symbol === symbol).sort((a, b) => a.date - b.date)
  }

  const startEditingSplit = (symbol, currentRatio) => {
    setEditingSplit(symbol)
    setSplitInput(currentRatio ? currentRatio.toString() : '')
  }

  const saveSplit = (symbol) => {
    if (splitInput && !isNaN(splitInput) && parseFloat(splitInput) > 0) {
      onSplitAdjustment(symbol, splitInput)
    }
    setEditingSplit(null)
    setSplitInput('')
  }

  const cancelEditingSplit = () => {
    setEditingSplit(null)
    setSplitInput('')
  }

  const openWhatIf = (symbol, currentPrice) => {
    setWhatIfSymbol(symbol)
    setWhatIfShares('')
    setWhatIfPrice(currentPrice.toString())
    setWhatIfMethod('real')
  }

  const closeWhatIf = () => {
    setWhatIfSymbol(null)
    setWhatIfShares('')
    setWhatIfPrice('')
    setWhatIfMethod('real')
  }

  const calculateWhatIfAvgCost = (row) => {
    if (!whatIfShares || !whatIfPrice || isNaN(whatIfShares) || isNaN(whatIfPrice)) {
      return null
    }

    // Get data based on selected method
    let currentPosition, currentAvgCost
    if (whatIfMethod === 'real') {
      currentPosition = row.real.position
      currentAvgCost = row.real.avgCostBasis
    } else if (whatIfMethod === 'fifo') {
      currentPosition = row.fifo.position
      currentAvgCost = row.fifo.avgCostBasis
    } else if (whatIfMethod === 'lifo') {
      currentPosition = row.lifo.position
      currentAvgCost = row.lifo.avgCostBasis
    }

    const newShares = parseFloat(whatIfShares)
    const newPrice = parseFloat(whatIfPrice)

    if (newShares <= 0 || newPrice <= 0 || currentPosition <= 0) {
      return null
    }

    const newAvgCost = (currentPosition * currentAvgCost + newShares * newPrice) / (currentPosition + newShares)
    const newPosition = currentPosition + newShares
    const costDifference = newAvgCost - currentAvgCost

    return {
      newAvgCost,
      newPosition,
      costDifference
    }
  }

  useEffect(() => {
    if (expandedSymbol && !expandedSymbol.includes('Put') && !expandedSymbol.includes('Call')) {
      // Load TradingView widget for stocks only (not options)
      const containerId = `tradingview_${expandedSymbol.replace(/[^a-zA-Z0-9]/g, '_')}`

      if (chartContainerRef.current[expandedSymbol]) {
        // Already loaded
        return
      }

      // Load TradingView script if not already loaded
      if (!window.TradingView) {
        const script = document.createElement('script')
        script.src = 'https://s3.tradingview.com/tv.js'
        script.async = true
        script.onload = () => createWidget(containerId, expandedSymbol)
        document.body.appendChild(script)
      } else {
        createWidget(containerId, expandedSymbol)
      }

      chartContainerRef.current[expandedSymbol] = true
    }
  }, [expandedSymbol])

  const createWidget = (containerId, symbol) => {
    const container = document.getElementById(containerId)
    if (container && window.TradingView) {
      new window.TradingView.widget({
        width: '100%',
        height: 500,
        symbol: symbol,
        interval: '10',
        timezone: 'Etc/UTC',
        theme: 'light',
        style: '1',
        locale: 'en',
        toolbar_bg: '#f1f3f6',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        save_image: false,
        container_id: containerId,
        studies: [
          {
            id: 'MAExp@tv-basicstudies',
            inputs: { length: 9 }
          },
          {
            id: 'MAExp@tv-basicstudies',
            inputs: { length: 21 }
          }
        ]
      })
    }
  }

  const sortedData = getSortedData(data)

  // Calculate totals from filtered data
  const totals = data.reduce(
    (acc, row) => ({
      realRealized: acc.realRealized + row.real.realizedPnL,
      realUnrealized: acc.realUnrealized + row.real.unrealizedPnL,
      realTotal: acc.realTotal + row.real.totalPnL,
      avgCostUnrealized: acc.avgCostUnrealized + row.avgCost.unrealizedPnL,
      fifoRealized: acc.fifoRealized + row.fifo.realizedPnL,
      fifoUnrealized: acc.fifoUnrealized + row.fifo.unrealizedPnL,
      fifoTotal: acc.fifoTotal + row.fifo.totalPnL,
      lifoRealized: acc.lifoRealized + row.lifo.realizedPnL,
      lifoUnrealized: acc.lifoUnrealized + row.lifo.unrealizedPnL,
      lifoTotal: acc.lifoTotal + row.lifo.totalPnL
    }),
    {
      realRealized: 0,
      realUnrealized: 0,
      realTotal: 0,
      avgCostUnrealized: 0,
      fifoRealized: 0,
      fifoUnrealized: 0,
      fifoTotal: 0,
      lifoRealized: 0,
      lifoUnrealized: 0,
      lifoTotal: 0
    }
  )

  // Update parent component with totals
  useEffect(() => {
    if (onTotalsUpdate) {
      onTotalsUpdate(totals)
    }
  }, [totals, onTotalsUpdate])

  return (
    <>
      {data.length !== allData?.length && (
        <div style={{
          padding: '10px 15px',
          background: '#e7f3ff',
          borderRadius: '8px',
          marginBottom: '15px',
          fontSize: '14px',
          color: '#0056b3'
        }}>
          Showing {data.length} of {allData?.length} positions (totals above reflect filtered data)
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
          <tr>
            <th rowSpan="2" onClick={() => handleSort('symbol')} className="sortable">
              Instrument{getSortIcon('symbol')}
            </th>
            <th rowSpan="2" onClick={() => handleSort('currentPrice')} className="sortable">
              Current Price{getSortIcon('currentPrice')}
            </th>
            <th rowSpan="2" onClick={() => handleSort('avgCost.position')} className="sortable">
              Position{getSortIcon('avgCost.position')}
            </th>
            {visiblePnlColumns.real && (
              <th colSpan="6" style={{ textAlign: 'center', borderBottom: '1px solid #dee2e6' }}>Real P&L</th>
            )}
            {visiblePnlColumns.avgCost && (
              <th colSpan="4" style={{ textAlign: 'center', borderBottom: '1px solid #dee2e6' }}>Average Cost</th>
            )}
            {visiblePnlColumns.fifo && (
              <th colSpan="4" style={{ textAlign: 'center', borderBottom: '1px solid #dee2e6' }}>FIFO</th>
            )}
            {visiblePnlColumns.lifo && (
              <th colSpan="4" style={{ textAlign: 'center', borderBottom: '1px solid #dee2e6' }}>LIFO</th>
            )}
          </tr>
          <tr>
            {visiblePnlColumns.real && (
              <>
                <th onClick={() => handleSort('real.avgCostBasis')} className="sortable" style={{ minWidth: '90px', maxWidth: '90px' }}>
                  Avg Cost{getSortIcon('real.avgCostBasis')}
                </th>
                <th onClick={() => handleSort('real.lowestOpenBuyPrice')} className="sortable" style={{ minWidth: '100px', maxWidth: '100px' }}>
                  Lowest Buy{getSortIcon('real.lowestOpenBuyPrice')}
                </th>
                <th onClick={() => handleSort('real.realizedPnL')} className="sortable">
                  Realized P&L{getSortIcon('real.realizedPnL')}
                </th>
                <th onClick={() => handleSort('real.unrealizedPnL')} className="sortable">
                  Unrealized P&L{getSortIcon('real.unrealizedPnL')}
                </th>
                <th onClick={() => handleSort('real.totalPnL')} className="sortable">
                  Total P&L{getSortIcon('real.totalPnL')}
                </th>
                <th onClick={() => handleSort('real.percentageReturn')} className="sortable">
                  %{getSortIcon('real.percentageReturn')}
                </th>
              </>
            )}
            {visiblePnlColumns.avgCost && (
              <>
                <th onClick={() => handleSort('avgCost.avgCostBasis')} className="sortable">
                  Avg Cost{getSortIcon('avgCost.avgCostBasis')}
                </th>
                <th>Cost Basis</th>
                <th>Current Value</th>
                <th onClick={() => handleSort('avgCost.unrealizedPnL')} className="sortable">
                  Unrealized P&L{getSortIcon('avgCost.unrealizedPnL')}
                </th>
              </>
            )}
            {visiblePnlColumns.fifo && (
              <>
                <th onClick={() => handleSort('fifo.avgCostBasis')} className="sortable">
                  Avg Cost{getSortIcon('fifo.avgCostBasis')}
                </th>
                <th onClick={() => handleSort('fifo.realizedPnL')} className="sortable">
                  Realized P&L{getSortIcon('fifo.realizedPnL')}
                </th>
                <th onClick={() => handleSort('fifo.unrealizedPnL')} className="sortable">
                  Unrealized P&L{getSortIcon('fifo.unrealizedPnL')}
                </th>
                <th onClick={() => handleSort('fifo.totalPnL')} className="sortable">
                  Total P&L{getSortIcon('fifo.totalPnL')}
                </th>
              </>
            )}
            {visiblePnlColumns.lifo && (
              <>
                <th onClick={() => handleSort('lifo.avgCostBasis')} className="sortable">
                  Avg Cost{getSortIcon('lifo.avgCostBasis')}
                </th>
                <th onClick={() => handleSort('lifo.realizedPnL')} className="sortable">
                  Realized P&L{getSortIcon('lifo.realizedPnL')}
                </th>
                <th onClick={() => handleSort('lifo.unrealizedPnL')} className="sortable">
                  Unrealized P&L{getSortIcon('lifo.unrealizedPnL')}
                </th>
                <th onClick={() => handleSort('lifo.totalPnL')} className="sortable">
                  Total P&L{getSortIcon('lifo.totalPnL')}
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row, index) => (
            <React.Fragment key={index}>
              <tr className="main-row" onClick={() => toggleExpand(row.symbol)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span className="expand-icon" onClick={() => toggleExpand(row.symbol)} style={{ cursor: 'pointer' }}>
                        {expandedSymbol === row.symbol ? '▼' : '▶'}
                      </span>
                      <span>{row.symbol}</span>
                      {row.isOption && <span style={{ fontSize: '0.8em', color: '#6c757d' }}>(Option)</span>}
                      {!row.isOption && getSignalForSymbol(row.symbol) && (
                        <span
                          className="grid-signal-badge"
                          style={{
                            background: getSignalColor(getSignalForSymbol(row.symbol).signal)
                          }}
                          onMouseEnter={(e) => {
                            // Clear any pending hide timeout
                            if (hideTimeoutRef.current) {
                              clearTimeout(hideTimeoutRef.current)
                              hideTimeoutRef.current = null
                            }

                            const signal = getSignalForSymbol(row.symbol)
                            const rect = e.currentTarget.getBoundingClientRect()
                            const position = {
                              top: rect.bottom + 8,
                              left: rect.left
                            }
                            setPopupPosition(position)
                            setHoveredSignal(signal)
                          }}
                          onMouseLeave={() => {
                            // Delay hiding to allow user to move to popup
                            hideTimeoutRef.current = setTimeout(() => {
                              setHoveredSignal(null)
                            }, 200)
                          }}
                        >
                          {getSignalIcon(getSignalForSymbol(row.symbol).signal)} {getSignalForSymbol(row.symbol).signal} ({getSignalForSymbol(row.symbol).strengthLabel})
                        </span>
                      )}
                    </div>
                    {!row.isOption && (
                      <div className="split-controls">
                        {editingSplit === row.symbol ? (
                          <div className="split-edit">
                            <input
                              type="number"
                              step="0.1"
                              placeholder="Split ratio (e.g., 10)"
                              value={splitInput}
                              onChange={(e) => setSplitInput(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && saveSplit(row.symbol)}
                              className="split-input"
                              autoFocus
                            />
                            <button onClick={() => saveSplit(row.symbol)} className="btn-small btn-save">✓</button>
                            <button onClick={cancelEditingSplit} className="btn-small btn-cancel">✗</button>
                          </div>
                        ) : (
                          <div className="split-display">
                            {splitAdjustments && splitAdjustments[row.symbol] ? (
                              <>
                                <span className="split-indicator" title={`${splitAdjustments[row.symbol]}:1 split adjustment applied`}>
                                  Split: {splitAdjustments[row.symbol]}:1
                                </span>
                                <button
                                  onClick={() => onClearSplitAdjustment(row.symbol)}
                                  className="btn-small btn-clear"
                                >
                                  Clear Split
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => startEditingSplit(row.symbol, null)}
                                className="btn-small btn-split"
                              >
                                Add Split
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </td>
                <td>
                  {editingPrice === row.symbol ? (
                    <div className="price-edit" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        step="0.01"
                        value={priceInput}
                        onChange={(e) => setPriceInput(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && savePrice(row.symbol)}
                        className="price-input"
                        autoFocus
                      />
                      <button onClick={() => savePrice(row.symbol)} className="btn-small btn-save">✓</button>
                      <button onClick={cancelEditingPrice} className="btn-small btn-cancel">✗</button>
                    </div>
                  ) : (
                    <div className="price-display" onClick={(e) => e.stopPropagation()}>
                      {formatCurrency(row.currentPrice)}
                      {manualPrices && manualPrices[row.symbol] && (
                        <span className="manual-indicator" title="Manual price">✎</span>
                      )}
                      <button
                        onClick={() => startEditingPrice(row.symbol, row.currentPrice)}
                        className="btn-small btn-edit"
                      >
                        Edit
                      </button>
                      {manualPrices && manualPrices[row.symbol] && (
                        <button
                          onClick={() => onClearManualPrice(row.symbol)}
                          className="btn-small btn-clear"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td>{row.avgCost.position}</td>

                {/* Real P&L columns */}
                {visiblePnlColumns.real && (
                  <>
                    <td style={{ minWidth: '90px', maxWidth: '90px' }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <span>{formatCurrency(row.real.avgCostBasis)}</span>
                        {row.real.position > 0 && (
                          <button
                            onClick={() => openWhatIf(row.symbol, row.currentPrice)}
                            className="btn-small btn-edit"
                            style={{ fontSize: '10px', padding: '2px 6px' }}
                            title="What-if calculator"
                          >
                            📊
                          </button>
                        )}
                      </div>
                    </td>
                    <td style={{ minWidth: '100px', maxWidth: '100px' }}>
                      {row.real.lowestOpenBuyPrice > 0 ? formatCurrency(row.real.lowestOpenBuyPrice) : '-'}
                    </td>
                    <td className={getClassName(row.real.realizedPnL)}>
                      {formatCurrency(row.real.realizedPnL)}
                    </td>
                    <td className={getClassName(row.real.unrealizedPnL)}>
                      {formatCurrency(row.real.unrealizedPnL)}
                    </td>
                    <td className={getClassName(row.real.totalPnL)}>
                      {formatCurrency(row.real.totalPnL)}
                    </td>
                    <td className={getClassName(row.real.percentageReturn)}>
                      {row.real.percentageReturn.toFixed(2)}%
                    </td>
                  </>
                )}

                {/* Average Cost columns */}
                {visiblePnlColumns.avgCost && (
                  <>
                    <td>{formatCurrency(row.avgCost.avgCostBasis)}</td>
                    <td>{formatCurrency(row.avgCost.avgCostBasis * row.avgCost.position)}</td>
                    <td>{formatCurrency(row.currentPrice * row.avgCost.position)}</td>
                    <td className={getClassName(row.avgCost.unrealizedPnL)}>
                      {formatCurrency(row.avgCost.unrealizedPnL)}
                    </td>
                  </>
                )}

                {/* FIFO columns */}
                {visiblePnlColumns.fifo && (
                  <>
                    <td>{formatCurrency(row.fifo.avgCostBasis)}</td>
                    <td className={getClassName(row.fifo.realizedPnL)}>
                      {formatCurrency(row.fifo.realizedPnL)}
                    </td>
                    <td className={getClassName(row.fifo.unrealizedPnL)}>
                      {formatCurrency(row.fifo.unrealizedPnL)}
                    </td>
                    <td className={getClassName(row.fifo.totalPnL)}>
                      {formatCurrency(row.fifo.totalPnL)}
                    </td>
                  </>
                )}

                {/* LIFO columns */}
                {visiblePnlColumns.lifo && (
                  <>
                    <td>{formatCurrency(row.lifo.avgCostBasis)}</td>
                    <td className={getClassName(row.lifo.realizedPnL)}>
                      {formatCurrency(row.lifo.realizedPnL)}
                    </td>
                    <td className={getClassName(row.lifo.unrealizedPnL)}>
                      {formatCurrency(row.lifo.unrealizedPnL)}
                    </td>
                    <td className={getClassName(row.lifo.totalPnL)}>
                      {formatCurrency(row.lifo.totalPnL)}
                    </td>
                  </>
                )}
              </tr>

            {/* Expanded row showing individual trades */}
            {expandedSymbol === row.symbol && (
              <tr className="expanded-row">
                <td colSpan={3 + (visiblePnlColumns.real ? 6 : 0) + (visiblePnlColumns.avgCost ? 4 : 0) + (visiblePnlColumns.fifo ? 4 : 0) + (visiblePnlColumns.lifo ? 4 : 0)}>
                  <div className="trades-detail">
                    <h4>{row.symbol} - Trade History{showChartsInHistory && !row.isOption ? ' & Chart' : ''}</h4>

                    {/* TradingView Chart for stocks only */}
                    {showChartsInHistory && !row.isOption && (
                      <div className="chart-container">
                        <div className="alert-instructions">
                          <strong>📊 Chart with EMA 9 (Blue) & EMA 21 (Yellow)</strong>
                          <span style={{ marginLeft: '20px', fontSize: '13px', color: '#666' }}>
                            💡 To set crossover alerts: Click the alarm icon 🔔 in the chart toolbar →
                            Create Alert → Choose "EMA 9" crossing "EMA 21" → Set as "Crossing Up" (buy) or "Crossing Down" (sell)
                          </span>
                        </div>
                        <div
                          id={`tradingview_${row.symbol.replace(/[^a-zA-Z0-9]/g, '_')}`}
                          style={{ height: '500px', width: '100%' }}
                        />
                      </div>
                    )}

                    <h4>Trade History</h4>
                    <div style={{ maxHeight: '400px', overflowY: 'auto', overflowX: 'auto', width: '100%' }}>
                    <table className="detail-table" style={{ minWidth: '600px' }}>
                      <thead>
                        <tr>
                          <th style={{ width: '90px', position: 'sticky', left: 0, background: '#667eea', zIndex: 10 }}>Date</th>
                          <th style={{ width: '60px' }}>Type</th>
                          <th style={{ width: '70px' }}>Quantity</th>
                          <th style={{ width: '100px' }}>Price</th>
                          <th style={{ width: '100px' }}>Amount</th>
                          <th style={{ width: '110px' }}>Realized P&L</th>
                          <th style={{ width: '110px' }}>Running Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const symbolTrades = getTradesForSymbol(row.symbol)

                          // Calculate overall average buy price (Real P&L method)
                          let totalBuyCost = 0
                          let totalBought = 0

                          symbolTrades.forEach((trade) => {
                            if (trade.isBuy) {
                              totalBuyCost += trade.quantity * trade.price
                              totalBought += trade.quantity
                            }
                          })

                          const avgBuyPrice = totalBought > 0 ? totalBuyCost / totalBought : 0
                          let runningTotal = 0

                          return symbolTrades.map((trade, idx) => {
                            let realizedPnL = null

                            if (!trade.isBuy) {
                              // Calculate realized P&L for this sell using overall average buy price
                              realizedPnL = (trade.price - avgBuyPrice) * trade.quantity
                              runningTotal += realizedPnL
                            }

                            return (
                              <tr key={idx}>
                                <td style={{ position: 'sticky', left: 0, background: 'white', zIndex: 5 }}>{trade.date.toLocaleDateString()}</td>
                                <td className={trade.isBuy ? 'positive' : 'negative'}>
                                  {trade.isBuy ? 'BUY' : 'SELL'}
                                </td>
                                <td>{trade.quantity}</td>
                                <td>{formatCurrency(trade.price)}</td>
                                <td>{formatCurrency(trade.amount)}</td>
                                <td className={realizedPnL ? getClassName(realizedPnL) : ''}>
                                  {realizedPnL !== null ? formatCurrency(realizedPnL) : '-'}
                                </td>
                                <td className={!trade.isBuy ? getClassName(runningTotal) : ''}>
                                  {!trade.isBuy ? formatCurrency(runningTotal) : '-'}
                                </td>
                              </tr>
                            )
                          })
                        })()}
                      </tbody>
                    </table>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="totals-row">
            <td colSpan="3"><strong>TOTALS</strong></td>

            {/* Real P&L totals */}
            {visiblePnlColumns.real && (
              <>
                <td></td>
                <td></td>
                <td className={getClassName(totals.realRealized)}>
                  <strong>{formatCurrency(totals.realRealized)}</strong>
                </td>
                <td className={getClassName(totals.realUnrealized)}>
                  <strong>{formatCurrency(totals.realUnrealized)}</strong>
                </td>
                <td className={getClassName(totals.realTotal)}>
                  <strong>{formatCurrency(totals.realTotal)}</strong>
                </td>
                <td></td>
              </>
            )}

            {/* Average Cost totals */}
            {visiblePnlColumns.avgCost && (
              <>
                <td></td>
                <td><strong>{formatCurrency(data.reduce((sum, row) => sum + (row.avgCost.avgCostBasis * row.avgCost.position), 0))}</strong></td>
                <td><strong>{formatCurrency(data.reduce((sum, row) => sum + (row.currentPrice * row.avgCost.position), 0))}</strong></td>
                <td className={getClassName(totals.avgCostUnrealized)}>
                  <strong>{formatCurrency(totals.avgCostUnrealized)}</strong>
                </td>
              </>
            )}

            {/* FIFO totals */}
            {visiblePnlColumns.fifo && (
              <>
                <td></td>
                <td className={getClassName(totals.fifoRealized)}>
                  <strong>{formatCurrency(totals.fifoRealized)}</strong>
                </td>
                <td className={getClassName(totals.fifoUnrealized)}>
                  <strong>{formatCurrency(totals.fifoUnrealized)}</strong>
                </td>
                <td className={getClassName(totals.fifoTotal)}>
                  <strong>{formatCurrency(totals.fifoTotal)}</strong>
                </td>
              </>
            )}

            {/* LIFO totals */}
            {visiblePnlColumns.lifo && (
              <>
                <td></td>
                <td className={getClassName(totals.lifoRealized)}>
                  <strong>{formatCurrency(totals.lifoRealized)}</strong>
                </td>
                <td className={getClassName(totals.lifoUnrealized)}>
                  <strong>{formatCurrency(totals.lifoUnrealized)}</strong>
                </td>
                <td className={getClassName(totals.lifoTotal)}>
                  <strong>{formatCurrency(totals.lifoTotal)}</strong>
                </td>
              </>
            )}
          </tr>
        </tfoot>
        </table>
      </div>

      {/* Signal Popup */}
      {hoveredSignal && (
        <div
          className="signal-popup"
          style={{
            position: 'fixed',
            top: `${popupPosition.top}px`,
            left: `${popupPosition.left}px`,
            zIndex: 999999,
            borderLeftColor: getSignalColor(hoveredSignal.signal)
          }}
          onMouseEnter={() => {
            // Clear hide timeout when entering popup
            if (hideTimeoutRef.current) {
              clearTimeout(hideTimeoutRef.current)
              hideTimeoutRef.current = null
            }
          }}
          onMouseLeave={() => {
            // Hide immediately when leaving popup
            setHoveredSignal(null)
          }}
        >
          <div className="signal-popup-header">
            <h4>{hoveredSignal.symbol}</h4>
            <div className="signal-badge" style={{ background: getSignalColor(hoveredSignal.signal) }}>
              {getSignalIcon(hoveredSignal.signal)} {hoveredSignal.signal}
            </div>
          </div>

          <div className="signal-strength">
            Strength: <strong>{hoveredSignal.strengthLabel}</strong> ({hoveredSignal.strength}/7)
          </div>

          <div className="signal-price-info">
            <div>Current: ${hoveredSignal.currentPrice?.toFixed(2)}</div>
            <div>Cost Basis: ${hoveredSignal.costBasis?.toFixed(2)}</div>
            <div>Position: {hoveredSignal.position} shares</div>
          </div>

          <div className="signal-indicators">
            <div className="indicator-row">
              <span>EMA 9:</span> <span className="indicator-value">${hoveredSignal.indicators.ema9}</span>
            </div>
            <div className="indicator-row">
              <span>EMA 21:</span> <span className="indicator-value">${hoveredSignal.indicators.ema21}</span>
            </div>
            <div className="indicator-row">
              <span>RSI:</span> <span className="indicator-value">{hoveredSignal.indicators.rsi}</span>
            </div>
            <div className="indicator-row">
              <span>MACD:</span> <span className="indicator-value">{hoveredSignal.indicators.macd}</span>
            </div>
          </div>

          <div className="signal-reasons">
            <strong>Analysis:</strong>
            <ul>
              {hoveredSignal.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* What-If Popup */}
      {whatIfSymbol && (
        <div
          className="signal-popup"
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 999999,
            borderLeftColor: '#667eea',
            maxWidth: '400px',
            width: '90%'
          }}
        >
          <div className="signal-popup-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4>📊 What-If Calculator: {whatIfSymbol}</h4>
            <button onClick={closeWhatIf} className="btn-small btn-cancel" style={{ fontSize: '16px', padding: '4px 8px' }}>✗</button>
          </div>

          {(() => {
            const row = data.find(r => r.symbol === whatIfSymbol)
            if (!row) return null

            // Get current values based on selected method
            let currentPosition, currentAvgCost
            if (whatIfMethod === 'real') {
              currentPosition = row.real.position
              currentAvgCost = row.real.avgCostBasis
            } else if (whatIfMethod === 'fifo') {
              currentPosition = row.fifo.position
              currentAvgCost = row.fifo.avgCostBasis
            } else if (whatIfMethod === 'lifo') {
              currentPosition = row.lifo.position
              currentAvgCost = row.lifo.avgCostBasis
            }

            return (
              <>
                <div style={{ marginBottom: '15px', padding: '10px', background: '#f0f0f0', borderRadius: '6px' }}>
                  <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>Calculation Method:</div>
                  <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="whatIfMethod"
                        value="real"
                        checked={whatIfMethod === 'real'}
                        onChange={(e) => setWhatIfMethod(e.target.value)}
                      />
                      Real P&L
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="whatIfMethod"
                        value="fifo"
                        checked={whatIfMethod === 'fifo'}
                        onChange={(e) => setWhatIfMethod(e.target.value)}
                      />
                      FIFO
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="whatIfMethod"
                        value="lifo"
                        checked={whatIfMethod === 'lifo'}
                        onChange={(e) => setWhatIfMethod(e.target.value)}
                      />
                      LIFO
                    </label>
                  </div>
                </div>

                <div style={{ marginBottom: '15px', padding: '10px', background: '#f8f9fa', borderRadius: '6px' }}>
                  <div style={{ marginBottom: '5px' }}>
                    <strong>Current Position:</strong> {currentPosition} shares
                  </div>
                  <div>
                    <strong>Current Avg Cost:</strong> {formatCurrency(currentAvgCost)}
                  </div>
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                    Shares to Buy:
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    placeholder="Number of shares"
                    value={whatIfShares}
                    onChange={(e) => setWhatIfShares(e.target.value)}
                    className="price-input"
                    style={{ width: '100%', padding: '8px', fontSize: '14px' }}
                    autoFocus
                  />
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                    Buy Price per Share:
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Price per share"
                    value={whatIfPrice}
                    onChange={(e) => setWhatIfPrice(e.target.value)}
                    className="price-input"
                    style={{ width: '100%', padding: '8px', fontSize: '14px' }}
                  />
                </div>

                {(() => {
                  const result = calculateWhatIfAvgCost(row)
                  if (!result) return null

                  const methodLabel = whatIfMethod === 'real' ? 'Real P&L' : whatIfMethod === 'fifo' ? 'FIFO' : 'LIFO'

                  return (
                    <div style={{ padding: '15px', background: '#e7f3ff', borderRadius: '8px', border: '2px solid #667eea' }}>
                      <div style={{ marginBottom: '10px', fontSize: '16px', fontWeight: 'bold', color: '#0056b3' }}>
                        📈 Results ({methodLabel}):
                      </div>
                      <div style={{ marginBottom: '8px' }}>
                        <strong>New Position:</strong> {result.newPosition.toFixed(2)} shares
                      </div>
                      <div style={{ marginBottom: '8px' }}>
                        <strong>New Avg Cost:</strong> {formatCurrency(result.newAvgCost)}
                      </div>
                      <div className={getClassName(result.costDifference)}>
                        <strong>Change:</strong> {formatCurrency(result.costDifference)} ({result.costDifference > 0 ? '↑' : '↓'} {((result.costDifference / currentAvgCost) * 100).toFixed(2)}%)
                      </div>
                      <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
                        Total Investment: {formatCurrency(parseFloat(whatIfShares) * parseFloat(whatIfPrice))}
                      </div>
                    </div>
                  )
                })()}
              </>
            )
          })()}
        </div>
      )}

      {/* Backdrop for What-If popup */}
      {whatIfSymbol && (
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
          onClick={closeWhatIf}
        />
      )}
    </>
  )
}

export default TradesTable
