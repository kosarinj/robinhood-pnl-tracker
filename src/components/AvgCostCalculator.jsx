import React, { useState, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const fmt = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`)

// Blended average-cost calculator. Type a symbol: if it's a position you hold,
// current shares + avg cost auto-fill; otherwise you enter them manually.
export default function AvgCostCalculator({ pnlData = [] }) {
  const { isDark } = useTheme()
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [curShares, setCurShares] = useState('')
  const [curAvg, setCurAvg] = useState('')
  const [buyShares, setBuyShares] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [known, setKnown] = useState(false)

  const surface = isDark ? '#1e2130' : '#ffffff'
  const surface2 = isDark ? '#252a3a' : '#f8fafc'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'

  // Held stock positions keyed by symbol → { position, avgCost }.
  const positions = useMemo(() => {
    const m = {}
    for (const p of pnlData) {
      if (!p || p.isOption || !p.symbol) continue
      const r = p.real || p.avgCost || {}
      if ((r.position || 0) > 0) m[String(p.symbol).toUpperCase()] = { position: r.position, avgCost: r.avgCostBasis }
    }
    return m
  }, [pnlData])
  const knownSymbols = useMemo(() => Object.keys(positions).sort(), [positions])

  const onSymbol = (raw) => {
    const sym = (raw || '').toUpperCase()
    setSymbol(sym)
    const pos = positions[sym]
    if (pos) {
      setCurShares(String(round2(pos.position)))
      setCurAvg(pos.avgCost != null ? String(round2(pos.avgCost)) : '')
      setKnown(true)
    } else {
      // Only clear values we auto-filled; don't wipe out manual entry.
      if (known) { setCurShares(''); setCurAvg('') }
      setKnown(false)
    }
  }

  const result = useMemo(() => {
    const cs = parseFloat(curShares), ca = parseFloat(curAvg), bs = parseFloat(buyShares), bp = parseFloat(buyPrice)
    if (!(cs > 0) || !(ca > 0) || !(bs > 0) || !(bp > 0)) return null
    const newAvg = (cs * ca + bs * bp) / (cs + bs)
    return { newAvg: round2(newAvg), newShares: round2(cs + bs), diff: round2(newAvg - ca), invested: round2(bs * bp) }
  }, [curShares, curAvg, buyShares, buyPrice])

  const inputStyle = { padding: '7px 9px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px', width: '100%', boxSizing: 'border-box' }
  const labelStyle = { fontSize: '11px', color: textMid, fontWeight: 600, marginBottom: '3px', display: 'block' }
  const field = (w) => ({ flex: `1 1 ${w}px`, minWidth: `${w}px` })

  return (
    <div style={{ marginBottom: '16px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ padding: '7px 14px', fontSize: '13px', fontWeight: 700, borderRadius: '6px', cursor: 'pointer', border: `1px solid ${open ? '#667eea' : border}`, background: open ? 'rgba(102,126,234,0.12)' : 'transparent', color: open ? '#667eea' : textMid }}
      >
        🧮 Avg Cost Calculator {open ? '▲' : '▼'}
      </button>

      {open && (
        <div style={{ marginTop: '10px', background: surface, border: `1px solid ${border}`, borderRadius: '12px', padding: '16px' }}>
          <div style={{ fontSize: '12px', color: textMid, marginBottom: '12px' }}>
            Type a symbol — if you hold it, current shares &amp; avg cost fill in automatically; otherwise enter them yourself.
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '14px' }}>
            <div style={field(110)}>
              <label style={labelStyle}>SYMBOL</label>
              <input list="avgcost-symbols" value={symbol} onChange={e => onSymbol(e.target.value)} placeholder="e.g. AAPL" style={{ ...inputStyle, textTransform: 'uppercase' }} />
              <datalist id="avgcost-symbols">
                {knownSymbols.map(s => <option key={s} value={s} />)}
              </datalist>
              {symbol && (
                <div style={{ fontSize: '10px', marginTop: '3px', color: known ? '#22c55e' : '#f59e0b' }}>
                  {known ? '✓ position found — prefilled' : 'not a held position — enter details'}
                </div>
              )}
            </div>
            <div style={field(110)}>
              <label style={labelStyle}>CURRENT SHARES</label>
              <input type="number" value={curShares} onChange={e => setCurShares(e.target.value)} placeholder="0" style={inputStyle} />
            </div>
            <div style={field(120)}>
              <label style={labelStyle}>CURRENT AVG COST</label>
              <input type="number" value={curAvg} onChange={e => setCurAvg(e.target.value)} placeholder="0.00" style={inputStyle} />
            </div>
            <div style={field(110)}>
              <label style={labelStyle}>SHARES TO BUY</label>
              <input type="number" value={buyShares} onChange={e => setBuyShares(e.target.value)} placeholder="0" style={inputStyle} />
            </div>
            <div style={field(110)}>
              <label style={labelStyle}>BUY PRICE</label>
              <input type="number" value={buyPrice} onChange={e => setBuyPrice(e.target.value)} placeholder="0.00" style={inputStyle} />
            </div>
          </div>

          {result ? (
            <div style={{ background: surface2, borderRadius: '8px', padding: '12px 16px', display: 'flex', gap: '28px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '11px', color: textMid, fontWeight: 600 }}>NEW AVG COST</div>
                <div style={{ fontSize: '22px', fontWeight: 800, color: '#667eea' }}>{fmt(result.newAvg)}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: textMid, fontWeight: 600 }}>NEW TOTAL SHARES</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: text }}>{result.newShares.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: textMid, fontWeight: 600 }}>CHANGE / SHARE</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: result.diff > 0 ? '#ef4444' : result.diff < 0 ? '#22c55e' : text }}>
                  {result.diff > 0 ? '↑ ' : result.diff < 0 ? '↓ ' : ''}{fmt(Math.abs(result.diff))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: textMid, fontWeight: 600 }}>INVESTED</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: text }}>{fmt(result.invested)}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '13px', color: textMid, padding: '4px 2px' }}>
              Fill in current shares, current avg cost, shares to buy, and buy price to see the new average.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
