import React, { useState, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

// Round to nearest strike increment (2.5 or 5 depending on price level)
function nearestStrikes(target, price) {
  const inc = price >= 200 ? 2.5 : price >= 50 ? 2.5 : 1
  const base = Math.floor(target / inc) * inc
  const strikes = []
  for (let i = -2; i <= 3; i++) {
    const s = Math.round((base + i * inc) * 100) / 100
    if (s > 0) strikes.push(s)
  }
  return strikes
}

export default function PutStrikeCalculator({ tickers = [] }) {
  const { isDark } = useTheme()
  const [open, setOpen] = useState(false)
  const [selectedTicker, setSelectedTicker] = useState('')
  const [price, setPrice]           = useState('')
  const [totalGain, setTotalGain]   = useState('')
  const [shares, setShares]         = useState('100')
  const [callPrem, setCallPrem]     = useState('')
  const [allowedLoss, setAllowedLoss] = useState('2.50')

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
    if (t.price)     setPrice(t.price.toFixed(2))
    if (t.shares)    setShares(String(t.shares))
    if (t.totalGain != null) setTotalGain(t.totalGain.toFixed(2))
  }

  const calc = useMemo(() => {
    const p   = parseFloat(price)
    const g   = parseFloat(totalGain)
    const sh  = parseFloat(shares) || 100
    const cp  = parseFloat(callPrem)
    const al  = parseFloat(allowedLoss) || 2.5
    if (!p || isNaN(g) || isNaN(cp)) return null
    const gainPerShare  = Math.round(g / sh * 100) / 100
    const afterGain     = Math.round((p - gainPerShare) * 100) / 100
    const afterCall     = Math.round((afterGain - cp) * 100) / 100
    const target        = Math.round((afterCall - al) * 100) / 100
    const strikes       = nearestStrikes(target, p)
    return { gainPerShare, afterGain, afterCall, target, strikes, sh }
  }, [price, totalGain, shares, callPrem, allowedLoss])

  const inputStyle = {
    padding: '5px 8px', borderRadius: '6px', border: `1px solid ${border}`,
    background: surface, color: text, fontSize: '13px',
  }

  const Row = ({ label, value, highlight, indent }) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 0', borderBottom: `1px solid ${rowBorder}`,
      paddingLeft: indent ? '12px' : 0,
    }}>
      <span style={{ fontSize: '12px', color: textMid }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: highlight ? '800' : '600', color: highlight ? '#667eea' : text }}>
        {value}
      </span>
    </div>
  )

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
        🧮 Put Strike Calculator {open ? '▲' : '▼'}
      </button>

      {open && (
        <div style={{
          marginTop: '10px', background: surface, border: `1px solid ${border}`,
          borderRadius: '12px', padding: '18px',
        }}>
          <div style={{ fontSize: '13px', fontWeight: '700', color: text, marginBottom: '14px' }}>
            Put Strike Calculator
            <span style={{ fontSize: '11px', fontWeight: '400', color: textMid, marginLeft: '8px' }}>
              price − gain/sh − call premium − allowed loss = target put
            </span>
          </div>

          {/* Inputs */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'flex-end' }}>
            {tickers.length > 0 && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
                TICKER
                <select
                  value={selectedTicker}
                  onChange={e => handleTickerChange(e.target.value)}
                  style={{ ...inputStyle, width: '90px' }}
                >
                  <option value=''>— pick —</option>
                  {tickers.map(t => <option key={t.ticker} value={t.ticker}>{t.ticker}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              STOCK PRICE
              <input type='number' value={price} onChange={e => setPrice(e.target.value)}
                placeholder='319.00' style={{ ...inputStyle, width: '80px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              TOTAL GAIN ($)
              <input type='number' value={totalGain} onChange={e => setTotalGain(e.target.value)}
                placeholder='600' style={{ ...inputStyle, width: '80px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              SHARES
              <input type='number' value={shares} onChange={e => setShares(e.target.value)}
                placeholder='100' style={{ ...inputStyle, width: '65px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              NEW CALL PREM
              <input type='number' value={callPrem} onChange={e => setCallPrem(e.target.value)}
                placeholder='4.00' style={{ ...inputStyle, width: '80px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: textMid, fontWeight: '600' }}>
              ALLOWED LOSS/SH
              <input type='number' value={allowedLoss} onChange={e => setAllowedLoss(e.target.value)}
                placeholder='2.50' style={{ ...inputStyle, width: '80px' }} />
            </label>
          </div>

          {calc ? (
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              {/* Formula breakdown */}
              <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Breakdown</div>
                <div style={{ background: surface2, borderRadius: '8px', padding: '10px 14px' }}>
                  <Row label='Current price' value={`$${parseFloat(price).toFixed(2)}`} />
                  <Row label={`− Gain/share ($${Math.abs(parseFloat(totalGain)).toFixed(0)} ÷ ${calc.sh})`} value={`− $${calc.gainPerShare.toFixed(2)}`} indent />
                  <Row label='= Break-even' value={`$${calc.afterGain.toFixed(2)}`} />
                  <Row label={`− New call premium`} value={`− $${parseFloat(callPrem).toFixed(2)}`} indent />
                  <Row label='= After call' value={`$${calc.afterCall.toFixed(2)}`} />
                  <Row label={`− Allowed loss/share`} value={`− $${parseFloat(allowedLoss).toFixed(2)}`} indent />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', marginTop: '4px', borderTop: `2px solid ${border}` }}>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: text }}>Target put strike</span>
                    <span style={{ fontSize: '18px', fontWeight: '800', color: '#667eea' }}>${calc.target.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Nearby strikes */}
              <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Nearest Put Strikes</div>
                <div style={{ background: surface2, borderRadius: '8px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {calc.strikes.map(s => {
                    const diff = Math.round((s - calc.target) * 100) / 100
                    const isBelow = s < calc.target
                    const isNearest = Math.abs(diff) === Math.min(...calc.strikes.map(x => Math.abs(x - calc.target)))
                    return (
                      <div key={s} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '6px 10px', borderRadius: '6px',
                        background: isNearest ? 'rgba(102,126,234,0.12)' : 'transparent',
                        border: `1px solid ${isNearest ? '#667eea' : border}`,
                      }}>
                        <span style={{ fontWeight: '700', fontSize: '14px', color: text }}>${s.toFixed(2)}</span>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          {isBelow && (
                            <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: green, fontWeight: '700' }}>
                              cheaper
                            </span>
                          )}
                          {isNearest && (
                            <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: 'rgba(102,126,234,0.15)', color: '#667eea', fontWeight: '700' }}>
                              nearest
                            </span>
                          )}
                          <span style={{ fontSize: '11px', color: diff > 0 ? '#f59e0b' : textMid }}>
                            {diff > 0 ? '+' : ''}{diff.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                  <div style={{ fontSize: '10px', color: textMid, marginTop: '4px' }}>
                    Cheaper = lower strike = less premium spent
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '20px', color: textMid, fontSize: '13px' }}>
              Fill in stock price, total gain, and new call premium to calculate
            </div>
          )}
        </div>
      )}
    </div>
  )
}
