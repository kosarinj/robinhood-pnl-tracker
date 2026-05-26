import React, { useState, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

export default function AverageDownCalculator({ tickers = [] }) {
  const { isDark } = useTheme()
  const [open, setOpen] = useState(false)
  const [selectedTicker, setSelectedTicker] = useState('')
  const [origPrice, setOrigPrice]   = useState('')
  const [origShares, setOrigShares] = useState('')
  const [curPrice, setCurPrice]     = useState('')
  const [netPnL, setNetPnL]         = useState('')   // negative = loss, positive = gain

  const surface  = isDark ? '#1e2130' : '#ffffff'
  const surface2 = isDark ? '#252a3a' : '#f8fafc'
  const border   = isDark ? '#2d3748' : '#e2e8f0'
  const text     = isDark ? '#e2e8f0' : '#1a202c'
  const textMid  = isDark ? '#94a3b8' : '#64748b'
  const green    = '#22c55e'
  const rowBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'

  const handleTickerChange = (ticker) => {
    setSelectedTicker(ticker)
    const t = tickers.find(t => t.ticker === ticker)
    if (!t) return
    if (t.price)   setCurPrice(t.price.toFixed(2))
    if (t.shares)  setOrigShares(String(t.shares))
    if (t.netPnL != null) setNetPnL(t.netPnL.toFixed(2))
  }

  const calc = useMemo(() => {
    const op  = parseFloat(origPrice)
    const os  = parseFloat(origShares)
    const cp  = parseFloat(curPrice)
    const pnl = parseFloat(netPnL)    // signed: negative = loss
    if (!op || !os || !cp || isNaN(pnl)) return null

    const originalInvestment = Math.round(op * os * 100) / 100
    const adjustedCapital    = Math.round((originalInvestment + pnl) * 100) / 100
    const currentValue       = Math.round(cp * os * 100) / 100
    const available          = Math.round((adjustedCapital - currentValue) * 100) / 100
    if (available <= 0) return { originalInvestment, adjustedCapital, currentValue, available, additionalShares: 0, newTotalShares: os, newAvgPrice: cp }
    const additionalShares   = Math.round(available / cp * 100) / 100
    const newTotalShares     = Math.round((os + additionalShares) * 100) / 100
    const newAvgPrice        = Math.round(adjustedCapital / newTotalShares * 100) / 100
    const savedVsOrigAvg     = Math.round((op - newAvgPrice) * 100) / 100

    return { originalInvestment, adjustedCapital, currentValue, available, additionalShares, newTotalShares, newAvgPrice, savedVsOrigAvg }
  }, [origPrice, origShares, curPrice, netPnL])

  const inputStyle = {
    padding: '5px 8px', borderRadius: '6px', border: `1px solid ${border}`,
    background: surface, color: text, fontSize: '13px',
  }

  const Row = ({ label, value, highlight, sub }) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 0', borderBottom: `1px solid ${rowBorder}`,
    }}>
      <span style={{ fontSize: sub ? '11px' : '12px', color: sub ? textMid : textMid, paddingLeft: sub ? '10px' : 0 }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: highlight ? '800' : '600', color: highlight ? '#667eea' : text }}>{value}</span>
    </div>
  )

  const fmt = (n) => n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`

  return (
    <div style={{ marginBottom: '16px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '6px 14px', fontSize: '12px', fontWeight: '700', borderRadius: '6px',
          cursor: 'pointer', border: `1px solid ${border}`,
          background: open ? 'rgba(102,126,234,0.15)' : 'transparent',
          color: open ? '#667eea' : textMid,
        }}
      >
        📉 Average Down Calculator {open ? '▲' : '▼'}
      </button>

      {open && (
        <div style={{
          marginTop: '10px', background: surface, border: `1px solid ${border}`,
          borderRadius: '12px', padding: '18px',
        }}>
          <div style={{ fontSize: '13px', fontWeight: '700', color: text, marginBottom: '14px' }}>
            Average Down Calculator
            <span style={{ fontSize: '11px', fontWeight: '400', color: textMid, marginLeft: '8px' }}>
              how many shares to buy with remaining capital after loss mitigation
            </span>
          </div>

          {/* Inputs */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'flex-end' }}>
            {tickers.length > 0 && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
                TICKER
                <select value={selectedTicker} onChange={e => handleTickerChange(e.target.value)}
                  style={{ ...inputStyle, width: '90px' }}>
                  <option value=''>— pick —</option>
                  {tickers.map(t => <option key={t.ticker} value={t.ticker}>{t.ticker}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              ORIG PRICE
              <input type='number' value={origPrice} onChange={e => setOrigPrice(e.target.value)}
                placeholder='155.50' style={{ ...inputStyle, width: '80px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              SHARES
              <input type='number' value={origShares} onChange={e => setOrigShares(e.target.value)}
                placeholder='105' style={{ ...inputStyle, width: '65px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              CURRENT PRICE
              <input type='number' value={curPrice} onChange={e => setCurPrice(e.target.value)}
                placeholder='141.00' style={{ ...inputStyle, width: '80px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              NET P&amp;L ($)
              <input type='number' value={netPnL} onChange={e => setNetPnL(e.target.value)}
                placeholder='-800' style={{ ...inputStyle, width: '80px' }} />
            </label>
            <div style={{ fontSize: '10px', color: textMid, alignSelf: 'flex-end', paddingBottom: '8px' }}>
              Net P&amp;L = stock loss +<br/>options gain (negative if down)
            </div>
          </div>

          {calc ? (
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              {/* Breakdown */}
              <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Breakdown</div>
                <div style={{ background: surface2, borderRadius: '8px', padding: '10px 14px' }}>
                  <Row label={`Original (${origShares} × $${parseFloat(origPrice).toFixed(2)})`} value={`$${calc.originalInvestment.toFixed(2)}`} />
                  <Row label={`+ Net P&L (loss mitigation)`} value={fmt(parseFloat(netPnL))} sub />
                  <Row label='= Adjusted capital' value={`$${calc.adjustedCapital.toFixed(2)}`} />
                  <Row label={`− Current value (${origShares} × $${parseFloat(curPrice).toFixed(2)})`} value={`− $${calc.currentValue.toFixed(2)}`} sub />
                  <Row label='= Available to deploy' value={fmt(calc.available)} />
                  <Row label={`÷ Current price ($${parseFloat(curPrice).toFixed(2)})`} value='' sub />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', marginTop: '4px', borderTop: `2px solid ${border}` }}>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: text }}>Additional shares</span>
                    <span style={{ fontSize: '18px', fontWeight: '800', color: '#667eea' }}>{calc.additionalShares.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Result summary */}
              <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>New Position</div>
                <div style={{ background: surface2, borderRadius: '8px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '12px', color: textMid }}>Original shares</span>
                    <span style={{ fontWeight: '700', color: text }}>{parseFloat(origShares).toFixed(0)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '12px', color: textMid }}>+ Buy additional</span>
                    <span style={{ fontWeight: '700', color: green }}>+{calc.additionalShares.toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${border}`, paddingTop: '8px' }}>
                    <span style={{ fontSize: '12px', color: textMid }}>New total shares</span>
                    <span style={{ fontWeight: '800', color: text }}>{calc.newTotalShares.toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '12px', color: textMid }}>New avg price</span>
                    <span style={{ fontWeight: '800', color: '#667eea' }}>${calc.newAvgPrice.toFixed(2)}</span>
                  </div>
                  {calc.savedVsOrigAvg > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', color: textMid }}>Avg reduced by</span>
                      <span style={{ fontWeight: '700', color: green }}>−${calc.savedVsOrigAvg.toFixed(2)}/sh</span>
                    </div>
                  )}
                  <div style={{ fontSize: '10px', color: textMid, marginTop: '4px', borderTop: `1px solid ${border}`, paddingTop: '6px' }}>
                    Deploying {fmt(calc.available)} remaining capital at ${parseFloat(curPrice).toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '20px', color: textMid, fontSize: '13px' }}>
              Fill in original price, shares, current price, and net P&L to calculate
            </div>
          )}
        </div>
      )}
    </div>
  )
}
