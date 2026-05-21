import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { socketService } from '../services/socketService'

const TREND_CFG = {
  uptrend:    { color: '#22c55e', label: '↑ Uptrend' },
  up_mixed:   { color: '#84cc16', label: '↑ Mixed' },
  neutral:    { color: '#94a3b8', label: '→ Neutral' },
  down_mixed: { color: '#f97316', label: '↓ Mixed' },
  downtrend:  { color: '#ef4444', label: '↓ Downtrend' },
  unknown:    { color: '#94a3b8', label: '—' },
}

const SIGNAL_CFG = {
  BUY:  { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',  label: '▲ BUY' },
  SELL: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',  label: '▼ SELL' },
  BOTH: { color: '#a855f7', bg: 'rgba(168,85,247,0.15)', label: '↕ BOTH' },
}

export default function ScreenerPanel() {
  const { isDark } = useTheme()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ processed: 0, total: 0 })
  const [hits, setHits] = useState([])
  const [signalFilter, setSignalFilter] = useState('all')
  const [sortBy, setSortBy] = useState('signal')
  const [lookBack, setLookBack] = useState('10')
  const [volMultiple, setVolMultiple] = useState('1.5')
  const [minCount, setMinCount] = useState('6')
  const listenersRef = useRef(false)

  const surface = isDark ? '#1e2130' : '#ffffff'
  const surface2 = isDark ? '#252a3a' : '#f8fafc'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const rowAlt = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)'
  const rowBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'

  useEffect(() => {
    if (listenersRef.current) return
    listenersRef.current = true

    const onHit = (r) => setHits(prev => [...prev, r])
    const onProg = (p) => setProgress(p)
    const onDone = () => setRunning(false)

    socketService.onScreenerHit(onHit)
    socketService.onScreenerProgress(onProg)
    socketService.onScreenerDone(onDone)

    return () => {
      socketService.offScreenerHit(onHit)
      socketService.offScreenerProgress(onProg)
      socketService.offScreenerDone(onDone)
    }
  }, [])

  const startScan = () => {
    setHits([])
    setProgress({ processed: 0, total: 0 })
    setRunning(true)
    socketService.runScreener({
      lookBack: parseInt(lookBack) || 10,
      volMultiple: parseFloat(volMultiple) || 1.5,
      minCount: parseInt(minCount) || 6,
    })
  }

  const stopScan = () => {
    socketService.stopScreener()
    setRunning(false)
  }

  const pct = progress.total > 0 ? Math.round(progress.processed / progress.total * 100) : 0

  const filtered = useMemo(() => {
    let evs = hits
    if (signalFilter !== 'all') evs = evs.filter(h => h.signal === signalFilter)
    return [...evs].sort((a, b) => {
      if (sortBy === 'signal') {
        if (a.signal !== b.signal) return a.signal === 'BUY' ? -1 : b.signal === 'BUY' ? 1 : 0
        return b.largeSellCount + b.largeBuyCount - (a.largeSellCount + a.largeBuyCount)
      }
      if (sortBy === 'sells') return b.largeSellCount - a.largeSellCount
      if (sortBy === 'buys') return b.largeBuyCount - a.largeBuyCount
      if (sortBy === 'sym') return a.sym.localeCompare(b.sym)
      return 0
    })
  }, [hits, signalFilter, sortBy])

  const buys = hits.filter(h => h.signal === 'BUY' || h.signal === 'BOTH').length
  const sells = hits.filter(h => h.signal === 'SELL' || h.signal === 'BOTH').length

  const btnBase = {
    padding: '5px 12px', fontSize: '12px', fontWeight: '600', borderRadius: '6px',
    cursor: 'pointer', border: `1px solid ${border}`, transition: 'all 0.15s',
  }
  const activeBtn = (on) => on
    ? { ...btnBase, background: 'rgba(102,126,234,0.18)', borderColor: '#667eea', color: '#667eea' }
    : { ...btnBase, background: 'transparent', color: textMid }

  const inputStyle = {
    padding: '5px 8px', borderRadius: '6px', border: `1px solid ${border}`,
    background: surface, color: text, fontSize: '13px', width: '52px',
  }

  const SortTh = ({ col, label, align = 'center' }) => (
    <th
      onClick={() => setSortBy(col)}
      style={{
        padding: '8px 10px', textAlign: align, fontSize: '12px', fontWeight: '700',
        cursor: 'pointer', whiteSpace: 'nowrap',
        color: sortBy === col ? '#667eea' : text,
        userSelect: 'none',
      }}
    >
      {label}{sortBy === col ? ' ↓' : ''}
    </th>
  )

  return (
    <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: '12px', padding: '20px', marginBottom: '20px', color: text }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>S&amp;P 500 Volume Screener</h2>
        <div style={{ fontSize: '12px', color: textMid, marginTop: '3px' }}>
          Scans ~200 S&amp;P 500 stocks · BUY = seller exhaustion in downtrend · SELL = buyer exhaustion in uptrend/neutral
        </div>
      </div>

      {/* Config + Run */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: textMid }}>
          Look back
          <input type="number" min="5" max="20" value={lookBack} onChange={e => setLookBack(e.target.value)}
            style={inputStyle} disabled={running} />
          days
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: textMid }}>
          Large vol ≥
          <input type="number" min="1" max="5" step="0.1" value={volMultiple} onChange={e => setVolMultiple(e.target.value)}
            style={inputStyle} disabled={running} />
          × avg
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: textMid }}>
          Min candles
          <input type="number" min="3" max="15" value={minCount} onChange={e => setMinCount(e.target.value)}
            style={inputStyle} disabled={running} />
        </label>

        {!running ? (
          <button onClick={startScan} style={{
            padding: '7px 22px', fontSize: '13px', fontWeight: '700', borderRadius: '6px',
            cursor: 'pointer', border: 'none', background: '#667eea', color: '#fff',
          }}>
            Scan S&amp;P 500
          </button>
        ) : (
          <button onClick={stopScan} style={{
            padding: '7px 22px', fontSize: '13px', fontWeight: '700', borderRadius: '6px',
            cursor: 'pointer', border: 'none', background: '#ef4444', color: '#fff',
          }}>
            Stop
          </button>
        )}
      </div>

      {/* Progress bar */}
      {(running || progress.total > 0) && (
        <div style={{ marginBottom: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: textMid, marginBottom: '4px' }}>
            <span>{running ? `Scanning… ${progress.processed}/${progress.total}` : `Complete — ${progress.processed} stocks scanned`}</span>
            <span>{pct}%</span>
          </div>
          <div style={{ height: '6px', background: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: '3px', transition: 'width 0.3s',
              width: `${pct}%`,
              background: running ? '#667eea' : '#22c55e',
            }} />
          </div>
        </div>
      )}

      {/* Summary */}
      {hits.length > 0 && (
        <div style={{
          display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center',
          padding: '10px 14px', marginBottom: '12px',
          background: surface2, borderRadius: '8px', border: `1px solid ${border}`,
          fontSize: '13px',
        }}>
          <span style={{ color: textMid }}>{hits.length} signal{hits.length !== 1 ? 's' : ''} found</span>
          {buys > 0 && (
            <span style={{ color: '#22c55e', fontWeight: '700' }}>▲ {buys} BUY</span>
          )}
          {sells > 0 && (
            <span style={{ color: '#ef4444', fontWeight: '700' }}>▼ {sells} SELL</span>
          )}
          <span style={{ color: textMid, fontSize: '11px' }}>
            Signal: seller/buyer exhaustion with ≥{minCount} large volume candles in last {lookBack} days
          </span>
        </div>
      )}

      {/* Filters */}
      {hits.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', color: textMid, fontWeight: '600' }}>Filter:</span>
          {[['all','All'],['BUY','▲ BUY'],['SELL','▼ SELL']].map(([v,l]) => (
            <button key={v} style={activeBtn(signalFilter === v)} onClick={() => setSignalFilter(v)}>{l}</button>
          ))}
          <span style={{ fontSize: '12px', color: textMid, fontWeight: '600', marginLeft: '8px' }}>Sort:</span>
          {[['signal','Signal'],['sells','Sells'],['buys','Buys'],['sym','Symbol']].map(([v,l]) => (
            <button key={v} style={activeBtn(sortBy === v)} onClick={() => setSortBy(v)}>{l}</button>
          ))}
        </div>
      )}

      {/* Results table */}
      {filtered.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${border}` }}>
                <SortTh col="sym" label="Symbol" align="left" />
                <SortTh col="signal" label="Signal" align="center" />
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '12px', fontWeight: '700', color: text }}>Trend</th>
                <SortTh col="sells" label="Lg Sells" />
                <SortTh col="buys" label="Lg Buys" />
                <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: '12px', fontWeight: '700', color: text, whiteSpace: 'nowrap' }}>Price</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: '12px', fontWeight: '700', color: text, whiteSpace: 'nowrap' }}>50MA</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: '12px', fontWeight: '700', color: text, whiteSpace: 'nowrap' }}>200MA</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((h, i) => {
                const sc = SIGNAL_CFG[h.signal] || SIGNAL_CFG.BUY
                const tc = TREND_CFG[h.trend] || TREND_CFG.unknown
                return (
                  <tr key={h.sym} style={{ background: i % 2 === 1 ? rowAlt : 'transparent', borderBottom: `1px solid ${rowBorder}` }}>
                    <td style={{ padding: '10px', fontWeight: '700', fontSize: '14px', color: text }}>
                      {h.sym}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <span style={{
                        fontSize: '12px', fontWeight: '700', padding: '3px 10px',
                        borderRadius: '5px', background: sc.bg, color: sc.color,
                        whiteSpace: 'nowrap',
                      }}>
                        {sc.label}
                      </span>
                    </td>
                    <td style={{ padding: '10px' }}>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: tc.color }}>{tc.label}</span>
                      {h.slope != null && (
                        <span style={{
                          fontSize: '10px', marginLeft: '6px',
                          color: h.slope > 0 ? '#22c55e' : '#ef4444',
                        }}>
                          {h.slope > 0 ? '+' : ''}{h.slope.toFixed(2)}%
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <span style={{
                        fontWeight: '700', fontSize: '14px',
                        color: h.largeSellCount >= 6 ? '#ef4444' : h.largeSellCount >= 4 ? '#f97316' : textMid,
                      }}>
                        {h.largeSellCount >= 6 ? '🔴' : ''}{h.largeSellCount}
                      </span>
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <span style={{
                        fontWeight: '700', fontSize: '14px',
                        color: h.largeBuyCount >= 6 ? '#22c55e' : h.largeBuyCount >= 4 ? '#84cc16' : textMid,
                      }}>
                        {h.largeBuyCount >= 6 ? '🟢' : ''}{h.largeBuyCount}
                      </span>
                    </td>
                    <td style={{ padding: '10px', textAlign: 'right', color: text, fontWeight: '600' }}>
                      ${h.price.toFixed(2)}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'right', fontSize: '12px' }}>
                      {h.ma50 ? (
                        <span style={{ color: h.price > h.ma50 ? '#22c55e' : '#ef4444' }}>
                          {h.price > h.ma50 ? '▲' : '▼'}${h.ma50.toFixed(2)}
                        </span>
                      ) : <span style={{ color: textMid }}>—</span>}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'right', fontSize: '12px' }}>
                      {h.ma200 ? (
                        <span style={{ color: h.price > h.ma200 ? '#22c55e' : '#ef4444' }}>
                          {h.price > h.ma200 ? '▲' : '▼'}${h.ma200.toFixed(2)}
                        </span>
                      ) : <span style={{ color: textMid }}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : hits.length === 0 && !running && progress.total === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: textMid, fontSize: '14px' }}>
          Click "Scan S&amp;P 500" to find volume exhaustion signals
        </div>
      ) : hits.length === 0 && !running ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
          No signals found with current settings
        </div>
      ) : null}
    </div>
  )
}
