import React, { useState, useEffect, useRef } from 'react'

function TradesTable({ data, allData, trades, manualPrices, splitAdjustments, visiblePnlColumns, realPnlColumnOrder, tradingSignals, showChartsInHistory, showRiskManagement, riskAllocations, onManualPriceUpdate, onClearManualPrice, onSplitAdjustment, onClearSplitAdjustment, onTotalsUpdate, onRiskAllocationUpdate }) {
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
  const [editingRisk, setEditingRisk] = useState(null)
  const [riskInput, setRiskInput] = useState('')
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

  const getTradesForSymbol = (symbol, isRollup = true, options = []) => {
    if (!trades) return []

    // For rolled-up parent instruments, get trades for both the stock AND all underlying options
    if (isRollup && options && options.length > 0) {
      const optionSymbols = options.map(opt => opt.symbol)
      // Include trades for the parent symbol AND all option symbols
      const matchedTrades = trades.filter(t => t.symbol === symbol || optionSymbols.includes(t.symbol))
      return matchedTrades.sort((a, b) => {
        const dateA = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime()
        const dateB = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime()
        // First sort by date
        if (dateA !== dateB) return dateA - dateB
        // If same date, process buys before sells
        if (a.isBuy && !b.isBuy) return -1
        if (!a.isBuy && b.isBuy) return 1
        return 0
      })
    }

    // For regular symbols, filter by exact symbol match
    return trades.filter(t => t.symbol === symbol).sort((a, b) => {
      const dateA = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime()
      const dateB = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime()
      // First sort by date
      if (dateA !== dateB) return dateA - dateB
      // If same date, process buys before sells
      if (a.isBuy && !b.isBuy) return -1
      if (!a.isBuy && b.isBuy) return 1
      return 0
    })
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

  const startEditingRisk = (symbol, currentAllocation) => {
    setEditingRisk(symbol)
    setRiskInput(currentAllocation ? currentAllocation.toString() : '')
  }

  const saveRiskAllocation = (symbol) => {
    if (riskInput && !isNaN(riskInput) && parseFloat(riskInput) >= 0) {
      onRiskAllocationUpdate(symbol, parseFloat(riskInput))
    }
    setEditingRisk(null)
    setRiskInput('')
  }

  const cancelEditingRisk = () => {
    setEditingRisk(null)
    setRiskInput('')
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
    if (expandedSymbol && showChartsInHistory && !expandedSymbol.includes('Put') && !expandedSymbol.includes('Call')) {
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
  }, [expandedSymbol, showChartsInHistory])

  const createWidget = (containerId, symbol) => {
    try {
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
    } catch (error) {
      console.error('Error creating TradingView widget:', error)
      // Widget creation failed, but don't break the page
    }
  }

  const sortedData = getSortedData(data)

  // Column definitions for Real P&L
  const realPnlColumns = {
    avgCost: {
      header: () => (
        <th onClick={() => handleSort('real.avgCostBasis')} className="sortable" style={{ minWidth: '90px', maxWidth: '90px' }}>
          Avg Cost{getSortIcon('real.avgCostBasis')}
        </th>
      ),
      cell: (row) => (
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
      ),
      footer: () => <td></td>
    },
    lowestBuy: {
      header: () => (
        <th onClick={() => handleSort('real.lowestOpenBuyPrice')} className="sortable" style={{ minWidth: '100px', maxWidth: '100px' }}>
          Lowest Buy{getSortIcon('real.lowestOpenBuyPrice')}
        </th>
      ),
      cell: (row) => (
        <td style={{ minWidth: '100px', maxWidth: '100px' }}>
          {row.real.lowestOpenBuyPrice > 0 ? formatCurrency(row.real.lowestOpenBuyPrice) : '-'}
        </td>
      ),
      footer: () => <td></td>
    },
    realized: {
      header: () => (
        <th onClick={() => handleSort('real.realizedPnL')} className="sortable">
          Realized P&L{getSortIcon('real.realizedPnL')}
        </th>
      ),
      cell: (row) => (
        <td className={getClassName(row.real.realizedPnL)}>
          {formatCurrency(row.real.realizedPnL)}
        </td>
      ),
      footer: () => (
        <td className={getClassName(totals.realRealized)}>
          <strong>{formatCurrency(totals.realRealized)}</strong>
        </td>
      )
    },
    currentValue: {
      header: () => <th style={{ minWidth: '120px' }}>Current Value</th>,
      cell: (row) => (
        <td>
          {formatCurrency(rowCurrentValues[row.symbol] || 0)}
        </td>
      ),
      footer: () => (
        <td>
          <strong>{formatCurrency(Object.values(rowCurrentValues).reduce((sum, val) => sum + val, 0))}</strong>
        </td>
      )
    },
    unrealized: {
      header: () => (
        <th onClick={() => handleSort('real.unrealizedPnL')} className="sortable">
          Unrealized P&L{getSortIcon('real.unrealizedPnL')}
        </th>
      ),
      cell: (row) => (
        <td className={getClassName(row.real.unrealizedPnL)}>
          {formatCurrency(row.real.unrealizedPnL)}
        </td>
      ),
      footer: () => (
        <td className={getClassName(totals.realUnrealized)}>
          <strong>{formatCurrency(totals.realUnrealized)}</strong>
        </td>
      )
    },
    total: {
      header: () => (
        <th onClick={() => handleSort('real.totalPnL')} className="sortable">
          Total P&L{getSortIcon('real.totalPnL')}
        </th>
      ),
      cell: (row) => (
        <td className={getClassName(row.real.totalPnL + (row.optionsPnL || 0))}>
          {formatCurrency(row.real.totalPnL + (row.optionsPnL || 0))}
        </td>
      ),
      footer: () => (
        <td className={getClassName(totals.realTotal)}>
          <strong>{formatCurrency(totals.realTotal)}</strong>
        </td>
      )
    },
    buySellTotal: {
      header: () => <th style={{ minWidth: '120px' }}>Buy/Sell Total</th>,
      cell: (row) => (
        <td className={getClassName(rowBuySellTotals[row.symbol])}>
          {formatCurrency(rowBuySellTotals[row.symbol] || 0)}
        </td>
      ),
      footer: () => (
        <td className={getClassName(Object.values(rowBuySellTotals).reduce((sum, val) => sum + val, 0))}>
          <strong>{formatCurrency(Object.values(rowBuySellTotals).reduce((sum, val) => sum + val, 0))}</strong>
        </td>
      )
    },
    dailyPnL: {
      header: () => (
        <th onClick={() => handleSort('dailyPnL')} className="sortable" style={{ minWidth: '110px' }}>
          Daily P&L{getSortIcon('dailyPnL')}
        </th>
      ),
      cell: (row) => (
        <td className={getClassName((row.dailyPnL || 0) + (row.optionsDailyPnL || 0))}>
          {formatCurrency((row.dailyPnL || 0) + (row.optionsDailyPnL || 0))}
        </td>
      ),
      footer: () => (
        <td className={getClassName(data.reduce((sum, row) => sum + (row.dailyPnL || 0) + (row.optionsDailyPnL || 0), 0))}>
          <strong>{formatCurrency(data.reduce((sum, row) => sum + (row.dailyPnL || 0) + (row.optionsDailyPnL || 0), 0))}</strong>
        </td>
      )
    },
    optionsPnL: {
      header: () => (
        <th onClick={() => handleSort('optionsPnL')} className="sortable" style={{ minWidth: '110px' }}>
          Options P&L{getSortIcon('optionsPnL')}
        </th>
      ),
      cell: (row) => (
        <td className={getClassName(row.optionsPnL || 0)} style={{ fontWeight: (row.optionsCount || 0) > 0 ? 'bold' : 'normal' }}>
          {formatCurrency(row.optionsPnL || 0)}
          {(row.optionsCount || 0) > 0 && <span style={{ fontSize: '0.7em', marginLeft: '4px' }}>({row.optionsCount})</span>}
        </td>
      ),
      footer: () => (
        <td className={getClassName(data.reduce((sum, row) => sum + (row.optionsPnL || 0), 0))}>
          <strong>{formatCurrency(data.reduce((sum, row) => sum + (row.optionsPnL || 0), 0))}</strong>
        </td>
      )
    },
    percentage: {
      header: () => (
        <th onClick={() => handleSort('real.percentageReturn')} className="sortable">
          %{getSortIcon('real.percentageReturn')}
        </th>
      ),
      cell: (row) => (
        <td className={getClassName(row.real.percentageReturn)}>
          {row.real.percentageReturn.toFixed(2)}%
        </td>
      ),
      footer: () => <td></td>
    }
  }

  // Calculate buy/sell totals and current values for each row
  const rowBuySellTotals = {}
  const rowCurrentValues = {}

  sortedData.forEach(row => {
    // For Buy/Sell Total, only get stock trades (not options)
    // Options P&L is shown separately in its own column
    let symbolTrades = getTradesForSymbol(row.symbol, false, []) // Don't include options

    // Apply split adjustments (matching App.jsx logic)
    symbolTrades = symbolTrades.map(trade => {
      if (splitAdjustments[trade.symbol]) {
        const ratio = splitAdjustments[trade.symbol]
        return {
          ...trade,
          price: trade.price / ratio,
          quantity: trade.quantity * ratio
        }
      }
      return trade
    })

    // Simple calculation: sum all buy and sell amounts (stock trades only)
    let totalBuyAmount = 0
    let totalSellAmount = 0
    let position = 0

    symbolTrades.forEach((trade) => {
      if (trade.isBuy) {
        totalBuyAmount += trade.quantity * trade.price
        position += trade.quantity
      } else {
        totalSellAmount += trade.quantity * trade.price
        position -= trade.quantity
      }
    })

    // Buy/Sell Total = Sell amounts - Buy amounts (realized P&L)
    rowBuySellTotals[row.symbol] = totalSellAmount - totalBuyAmount

    // Current Value = Outstanding shares * current price
    rowCurrentValues[row.symbol] = position * row.currentPrice

  })

  // Calculate totals from filtered data
  const totals = data.reduce(
    (acc, row) => {
      // Calculate options realized and unrealized P&L separately
      const optionsRealized = (row.options || []).reduce((sum, opt) => sum + (opt.real.realizedPnL || 0), 0)
      const optionsUnrealized = (row.options || []).reduce((sum, opt) => sum + (opt.real.unrealizedPnL || 0), 0)

      return {
        realRealized: acc.realRealized + row.real.realizedPnL + optionsRealized,
        realUnrealized: acc.realUnrealized + row.real.unrealizedPnL + optionsUnrealized,
        realTotal: acc.realTotal + row.real.totalPnL + (row.optionsPnL || 0),
        dailyPnL: acc.dailyPnL + (row.dailyPnL || 0) + (row.optionsDailyPnL || 0),
        avgCostUnrealized: acc.avgCostUnrealized + row.avgCost.unrealizedPnL,
        fifoRealized: acc.fifoRealized + row.fifo.realizedPnL,
        fifoUnrealized: acc.fifoUnrealized + row.fifo.unrealizedPnL,
        fifoTotal: acc.fifoTotal + row.fifo.totalPnL,
        lifoRealized: acc.lifoRealized + row.lifo.realizedPnL,
        lifoUnrealized: acc.lifoUnrealized + row.lifo.unrealizedPnL,
        lifoTotal: acc.lifoTotal + row.lifo.totalPnL
      }
    },
    {
      realRealized: 0,
      realUnrealized: 0,
      realTotal: 0,
      dailyPnL: 0,
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
            {showRiskManagement && (
              <th colSpan="3" style={{ textAlign: 'center', borderBottom: '1px solid #dee2e6', background: '#fff4e6' }}>Risk Management</th>
            )}
            {visiblePnlColumns.real && (
              <th colSpan="10" style={{ textAlign: 'center', borderBottom: '1px solid #dee2e6' }}>Real P&L</th>
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
            {showRiskManagement && (
              <>
                <th style={{ background: '#fff4e6' }}>Risk Allocated</th>
                <th style={{ background: '#fff4e6' }}>Risk Used</th>
                <th style={{ background: '#fff4e6' }}>Used %</th>
              </>
            )}
            {visiblePnlColumns.real && realPnlColumnOrder && realPnlColumnOrder.map(columnId => {
              const column = realPnlColumns[columnId]
              return column ? <React.Fragment key={columnId}>{column.header()}</React.Fragment> : null
            })}
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
                      {row.isRollup && <span style={{ fontSize: '0.8em', color: '#667eea', fontWeight: 'bold' }}>(Options Rollup: {row.options?.length || 0} options)</span>}
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

                {/* Risk Management columns */}
                {showRiskManagement && (() => {
                  const allocation = (riskAllocations && riskAllocations[row.symbol]) || 0
                  const costBasis = row.real.avgCostBasis * row.real.position
                  const riskUsed = costBasis
                  const usedPercent = allocation > 0 ? (riskUsed / allocation) * 100 : 0
                  const isOverAllocated = usedPercent > 100

                  return (
                    <>
                      <td onClick={(e) => e.stopPropagation()} style={{ background: '#fffbf0' }}>
                        {editingRisk === row.symbol ? (
                          <div className="price-edit">
                            <input
                              type="number"
                              step="100"
                              min="0"
                              value={riskInput}
                              onChange={(e) => setRiskInput(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && saveRiskAllocation(row.symbol)}
                              className="price-input"
                              autoFocus
                            />
                            <button onClick={() => saveRiskAllocation(row.symbol)} className="btn-small btn-save">✓</button>
                            <button onClick={cancelEditingRisk} className="btn-small btn-cancel">✗</button>
                          </div>
                        ) : (
                          <div className="price-display">
                            {allocation > 0 ? formatCurrency(allocation) : '-'}
                            <button
                              onClick={() => startEditingRisk(row.symbol, allocation)}
                              className="btn-small btn-edit"
                            >
                              {allocation > 0 ? 'Edit' : 'Set'}
                            </button>
                          </div>
                        )}
                      </td>
                      <td style={{ background: '#fffbf0' }}>
                        {formatCurrency(riskUsed)}
                      </td>
                      <td style={{ background: isOverAllocated ? '#ffe6e6' : '#fffbf0', fontWeight: isOverAllocated ? 'bold' : 'normal' }}>
                        {allocation > 0 ? `${usedPercent.toFixed(1)}%` : '-'}
                        {isOverAllocated && <span style={{ color: '#dc3545', marginLeft: '5px' }}>⚠</span>}
                      </td>
                    </>
                  )
                })()}

                {/* Real P&L columns */}
                {visiblePnlColumns.real && realPnlColumnOrder && realPnlColumnOrder.map(columnId => {
                  const column = realPnlColumns[columnId]
                  return column ? <React.Fragment key={columnId}>{column.cell(row)}</React.Fragment> : null
                })}

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

            {/* Expanded row showing individual trades or options */}
            {expandedSymbol === row.symbol && (
              <tr className="expanded-row">
                <td colSpan={3 + (showRiskManagement ? 3 : 0) + (visiblePnlColumns.real ? 10 : 0) + (visiblePnlColumns.avgCost ? 4 : 0) + (visiblePnlColumns.fifo ? 4 : 0) + (visiblePnlColumns.lifo ? 4 : 0)} style={{ background: 'white', padding: '0' }}>
                  <div className="trades-detail" style={{ background: 'white', padding: '20px' }}>
                    {row.isRollup ? (
                      // Display individual options for rolled-up parent instruments
                      <>
                        <h4 style={{ color: '#667eea', marginBottom: '15px' }}>{row.symbol} - Options Breakdown</h4>
                        <div style={{ maxHeight: '600px', overflowY: 'auto', overflowX: 'auto', width: '100%', background: 'white' }}>
                          <table className="detail-table" style={{ minWidth: '800px', background: 'white', width: '100%' }}>
                            <thead>
                              <tr>
                                <th>Option</th>
                                {visiblePnlColumns.real && (
                                  <>
                                    <th>Real Realized</th>
                                    <th>Real Unrealized</th>
                                    <th>Real Total</th>
                                  </>
                                )}
                                {visiblePnlColumns.avgCost && (
                                  <>
                                    <th>Avg Cost Unrealized</th>
                                  </>
                                )}
                                {visiblePnlColumns.fifo && (
                                  <>
                                    <th>FIFO Realized</th>
                                    <th>FIFO Unrealized</th>
                                    <th>FIFO Total</th>
                                  </>
                                )}
                                {visiblePnlColumns.lifo && (
                                  <>
                                    <th>LIFO Realized</th>
                                    <th>LIFO Unrealized</th>
                                    <th>LIFO Total</th>
                                  </>
                                )}
                              </tr>
                            </thead>
                            <tbody style={{ background: 'white' }}>
                              {row.options && row.options.map((option, idx) => (
                                <tr key={idx} style={{ background: 'white' }}>
                                  <td style={{ background: 'white', fontSize: '0.9em' }}>{option.symbol}</td>
                                  {visiblePnlColumns.real && (
                                    <>
                                      <td className={getClassName(option.real.realizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.real.realizedPnL)}
                                      </td>
                                      <td className={getClassName(option.real.unrealizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.real.unrealizedPnL)}
                                      </td>
                                      <td className={getClassName(option.real.totalPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.real.totalPnL)}
                                      </td>
                                    </>
                                  )}
                                  {visiblePnlColumns.avgCost && (
                                    <>
                                      <td className={getClassName(option.avgCost.unrealizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.avgCost.unrealizedPnL)}
                                      </td>
                                    </>
                                  )}
                                  {visiblePnlColumns.fifo && (
                                    <>
                                      <td className={getClassName(option.fifo.realizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.fifo.realizedPnL)}
                                      </td>
                                      <td className={getClassName(option.fifo.unrealizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.fifo.unrealizedPnL)}
                                      </td>
                                      <td className={getClassName(option.fifo.totalPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.fifo.totalPnL)}
                                      </td>
                                    </>
                                  )}
                                  {visiblePnlColumns.lifo && (
                                    <>
                                      <td className={getClassName(option.lifo.realizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.lifo.realizedPnL)}
                                      </td>
                                      <td className={getClassName(option.lifo.unrealizedPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.lifo.unrealizedPnL)}
                                      </td>
                                      <td className={getClassName(option.lifo.totalPnL)} style={{ background: 'white' }}>
                                        {formatCurrency(option.lifo.totalPnL)}
                                      </td>
                                    </>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : (
                      // Display trade history for regular stocks and options
                      <>
                        <h4 style={{ color: '#667eea', marginBottom: '15px' }}>{row.symbol} - Trade History{showChartsInHistory && !row.isOption ? ' & Chart' : ''}</h4>

                        {/* Debug Info */}
                        <div style={{
                          background: '#e3f2fd',
                          padding: '10px',
                          marginBottom: '15px',
                          border: '2px solid #2196f3',
                          borderRadius: '4px',
                          fontFamily: 'monospace',
                          fontSize: '12px'
                        }}>
                          <strong>DEBUG INFO:</strong><br/>
                          Symbol: {row.symbol}<br/>
                          Is Rollup: {row.isRollup ? 'YES' : 'NO'}<br/>
                          Options Array Length: {row.options ? row.options.length : 0}<br/>
                          {row.options && row.options.length > 0 && (
                            <>
                              Option Symbols: {row.options.map(o => o.symbol).join(', ')}<br/>
                            </>
                          )}
                          Trades for this symbol: {getTradesForSymbol(row.symbol, true, row.options).length}
                        </div>

                    {/* TradingView Chart for stocks only */}
                    {showChartsInHistory && !row.isOption && (
                      <div className="chart-container" style={{ marginBottom: '20px' }}>
                        <div className="alert-instructions">
                          <strong>📊 Chart with EMA 9 (Blue) & EMA 21 (Yellow)</strong>
                          <span style={{ marginLeft: '20px', fontSize: '13px', color: '#666' }}>
                            💡 To set crossover alerts: Click the alarm icon 🔔 in the chart toolbar →
                            Create Alert → Choose "EMA 9" crossing "EMA 21" → Set as "Crossing Up" (buy) or "Crossing Down" (sell)
                          </span>
                        </div>
                        <div
                          id={`tradingview_${row.symbol.replace(/[^a-zA-Z0-9]/g, '_')}`}
                          style={{ height: '500px', width: '100%', background: 'white' }}
                        />
                      </div>
                    )}

                    <h4 style={{ color: '#667eea', marginBottom: '15px' }}>Trade History</h4>
                    <div style={{ maxHeight: '400px', overflowY: 'auto', overflowX: 'auto', width: '100%', background: 'white' }}>
                    <table className="detail-table" style={{ minWidth: '800px', background: 'white' }}>
                      <thead>
                        <tr>
                          <th style={{ width: '90px', position: 'sticky', left: 0, background: '#667eea', zIndex: 10 }}>Date</th>
                          <th style={{ width: '200px' }}>Description</th>
                          <th style={{ width: '60px' }}>Type</th>
                          <th style={{ width: '70px' }}>Quantity</th>
                          <th style={{ width: '100px' }}>Price</th>
                          <th style={{ width: '100px' }}>Amount</th>
                          <th style={{ width: '110px' }}>Cost Basis Used</th>
                          <th style={{ width: '110px' }}>Realized P&L</th>
                          <th style={{ width: '110px' }}>Running Total</th>
                          <th style={{ width: '150px' }}>Matched Buys</th>
                        </tr>
                      </thead>
                      <tbody style={{ background: 'white' }}>
                        {(() => {
                          try {
                          let symbolTrades = getTradesForSymbol(row.symbol, true, row.options)

                          // Apply split adjustments (matching App.jsx logic)
                          symbolTrades = symbolTrades.map(trade => {
                            if (splitAdjustments[trade.symbol]) {
                              const ratio = splitAdjustments[trade.symbol]
                              return {
                                ...trade,
                                price: trade.price / ratio,
                                quantity: trade.quantity * ratio
                              }
                            }
                            return trade
                          })

                          if (!symbolTrades || symbolTrades.length === 0) {
                            return (
                              <tr>
                                <td colSpan="10" style={{ padding: '20px', textAlign: 'center', background: 'white' }}>
                                  No trades found for {row.symbol}
                                </td>
                              </tr>
                            )
                          }

                          // Implement the hybrid cost basis calculation (matching Real P&L logic)
                          const buyQueue = []
                          let totalBought = 0
                          let totalBuyCost = 0
                          let runningTotal = 0

                          const tradeRows = symbolTrades.map((trade, idx) => {
                            if (!trade) return null

                            const tradeDate = trade.date instanceof Date ? trade.date : new Date(trade.date)
                            let realizedPnL = null
                            let costBasisUsed = null
                            let matchedBuys = []

                            if (trade.isBuy) {
                              // Add to buy queue
                              totalBought += trade.quantity
                              totalBuyCost += trade.quantity * trade.price
                              buyQueue.push({
                                quantity: trade.quantity,
                                price: trade.price,
                                date: tradeDate,
                                index: idx
                              })
                              // Keep sorted by price (lowest first)
                              buyQueue.sort((a, b) => a.price - b.price)
                            } else {
                              // Selling - apply EXACT Real P&L hybrid logic from pnlCalculator.js
                              const sellPrice = trade.price
                              const sellQuantity = trade.quantity
                              const avgBuyPrice = totalBought > 0 ? totalBuyCost / totalBought : 0

                              // Determine cost basis (matching pnlCalculator.js exactly)
                              if (sellPrice < avgBuyPrice) {
                                if (buyQueue.length > 0) {
                                  costBasisUsed = buyQueue[0].price
                                } else {
                                  costBasisUsed = avgBuyPrice
                                }
                              } else {
                                costBasisUsed = avgBuyPrice
                              }

                              realizedPnL = (sellPrice - costBasisUsed) * sellQuantity
                              runningTotal += realizedPnL

                              // Track which buys were matched
                              let remainingSellQty = sellQuantity
                              if (sellPrice < avgBuyPrice) {
                                // Match with lowest priced lots
                                for (let i = 0; i < buyQueue.length && remainingSellQty > 0; i++) {
                                  const buy = buyQueue[i]
                                  const qtyMatched = Math.min(buy.quantity, remainingSellQty)
                                  matchedBuys.push({
                                    date: buy.date,
                                    price: buy.price,
                                    quantity: qtyMatched
                                  })
                                  remainingSellQty -= qtyMatched
                                }
                              } else {
                                // Match with FIFO
                                for (let i = 0; i < buyQueue.length && remainingSellQty > 0; i++) {
                                  const buy = buyQueue[i]
                                  const qtyMatched = Math.min(buy.quantity, remainingSellQty)
                                  matchedBuys.push({
                                    date: buy.date,
                                    price: buy.price,
                                    quantity: qtyMatched
                                  })
                                  remainingSellQty -= qtyMatched
                                }
                              }

                              // Remove sold shares from queue (matching pnlCalculator.js)
                              remainingSellQty = sellQuantity
                              while (remainingSellQty > 0 && buyQueue.length > 0) {
                                if (sellPrice < avgBuyPrice) {
                                  // When selling below average, remove from lowest priced lots first
                                  const lowestBuy = buyQueue[0]
                                  if (lowestBuy.quantity <= remainingSellQty) {
                                    totalBought -= lowestBuy.quantity
                                    totalBuyCost -= lowestBuy.quantity * lowestBuy.price
                                    remainingSellQty -= lowestBuy.quantity
                                    buyQueue.shift()
                                  } else {
                                    lowestBuy.quantity -= remainingSellQty
                                    totalBought -= remainingSellQty
                                    totalBuyCost -= remainingSellQty * lowestBuy.price
                                    remainingSellQty = 0
                                  }
                                } else {
                                  // When selling at or above average, remove FIFO (oldest first)
                                  const oldestBuy = buyQueue[0]
                                  if (oldestBuy.quantity <= remainingSellQty) {
                                    totalBought -= oldestBuy.quantity
                                    totalBuyCost -= oldestBuy.quantity * oldestBuy.price
                                    remainingSellQty -= oldestBuy.quantity
                                    buyQueue.shift()
                                  } else {
                                    oldestBuy.quantity -= remainingSellQty
                                    totalBought -= remainingSellQty
                                    totalBuyCost -= remainingSellQty * oldestBuy.price
                                    remainingSellQty = 0
                                  }
                                }
                              }
                            }

                            // Determine description to display
                            const displayDescription = trade.isOption ? trade.description : trade.instrument

                            return (
                              <tr key={idx} style={{ background: 'white' }}>
                                <td style={{ position: 'sticky', left: 0, background: 'white', zIndex: 5 }}>{tradeDate.toLocaleDateString()}</td>
                                <td style={{ background: 'white', fontSize: '0.85em' }}>{displayDescription}</td>
                                <td className={trade.isBuy ? 'positive' : 'negative'} style={{ background: 'white' }}>
                                  {trade.isBuy ? 'BUY' : 'SELL'}
                                </td>
                                <td style={{ background: 'white' }}>{trade.quantity}</td>
                                <td style={{ background: 'white' }}>{formatCurrency(trade.price)}</td>
                                <td style={{ background: 'white' }}>{formatCurrency(trade.amount)}</td>
                                <td style={{ background: 'white', fontSize: '0.85em' }}>
                                  {costBasisUsed !== null ? formatCurrency(costBasisUsed) : '-'}
                                </td>
                                <td className={realizedPnL ? getClassName(realizedPnL) : ''} style={{ background: 'white' }}>
                                  {realizedPnL !== null ? formatCurrency(realizedPnL) : '-'}
                                </td>
                                <td className={!trade.isBuy ? getClassName(runningTotal) : ''} style={{ background: 'white' }}>
                                  {!trade.isBuy ? formatCurrency(runningTotal) : '-'}
                                </td>
                                <td style={{ background: 'white', fontSize: '0.75em' }}>
                                  {matchedBuys.length > 0 ? (
                                    <div>
                                      {matchedBuys.map((mb, mbIdx) => (
                                        <div key={mbIdx} style={{ whiteSpace: 'nowrap' }}>
                                          {mb.date.toLocaleDateString()}: {mb.quantity} @ {formatCurrency(mb.price)}
                                        </div>
                                      ))}
                                    </div>
                                  ) : '-'}
                                </td>
                              </tr>
                            )
                          })

                          // Calculate expected realized P&L from main grid
                          const expectedRealizedPnL = row.real.realizedPnL
                          const difference = Math.abs(runningTotal - expectedRealizedPnL)
                          const isMatch = difference < 0.01 // Allow for tiny rounding differences

                          // Log verification for debugging
                          if (!isMatch) {
                            console.warn(`[${row.symbol}] Realized P&L Mismatch:`, {
                              tradeHistoryTotal: runningTotal,
                              mainGridRealized: expectedRealizedPnL,
                              difference: difference,
                              numberOfTrades: symbolTrades.length
                            })
                          }

                          // Add verification row after all trades
                          return [
                            ...tradeRows,
                            <tr key="verification" style={{
                              background: isMatch ? '#d4edda' : '#fff3cd',
                              borderTop: '2px solid #667eea',
                              fontWeight: 'bold'
                            }}>
                              <td colSpan="7" style={{ textAlign: 'right', padding: '12px' }}>
                                {isMatch ? '✓ Verified:' : '⚠ Mismatch:'}
                              </td>
                              <td style={{ padding: '12px' }}>
                                {formatCurrency(runningTotal)}
                              </td>
                              <td colSpan="2" style={{ padding: '12px', fontSize: '0.85em' }}>
                                {isMatch ? (
                                  <span style={{ color: '#155724' }}>Matches main grid Realized P&L</span>
                                ) : (
                                  <span style={{ color: '#856404' }}>
                                    Expected: {formatCurrency(expectedRealizedPnL)} (Diff: {formatCurrency(difference)})
                                  </span>
                                )}
                              </td>
                            </tr>
                          ]
                        } catch (error) {
                          console.error('Error rendering trade history:', error)
                          return (
                            <tr>
                              <td colSpan="10" style={{ padding: '20px', textAlign: 'center', background: '#f8d7da', color: '#721c24' }}>
                                Error loading trade history. Please try again.
                              </td>
                            </tr>
                          )
                        }
                        })()}
                      </tbody>
                    </table>
                    </div>
                      </>
                    )}
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

            {/* Risk Management totals */}
            {showRiskManagement && (() => {
              const totalAllocated = data.reduce((sum, row) => sum + ((riskAllocations && riskAllocations[row.symbol]) || 0), 0)
              const totalUsed = data.reduce((sum, row) => sum + (row.real.avgCostBasis * row.real.position), 0)
              const avgUsedPercent = totalAllocated > 0 ? (totalUsed / totalAllocated) * 100 : 0

              return (
                <>
                  <td style={{ background: '#fff4e6' }}>
                    <strong>{formatCurrency(totalAllocated)}</strong>
                  </td>
                  <td style={{ background: '#fff4e6' }}>
                    <strong>{formatCurrency(totalUsed)}</strong>
                  </td>
                  <td style={{ background: '#fff4e6' }}>
                    <strong>{totalAllocated > 0 ? `${avgUsedPercent.toFixed(1)}%` : '-'}</strong>
                  </td>
                </>
              )
            })()}

            {/* Real P&L totals */}
            {visiblePnlColumns.real && realPnlColumnOrder && realPnlColumnOrder.map(columnId => {
              const column = realPnlColumns[columnId]
              return column ? <React.Fragment key={columnId}>{column.footer()}</React.Fragment> : null
            })}

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
