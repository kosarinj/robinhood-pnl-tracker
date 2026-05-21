import React, { useState, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'

// Inline SVG sparkline: N bars colored by volume classification
function VolumeSparkline({ preBars, isDark }) {
  if (!preBars || preBars.length === 0) return null
  const W = 140, H = 42
  const maxVol = Math.max(...preBars.map(b => b.volume), 1)
  const n = preBars.length
  const gap = 1
  const barW = Math.max(2, Math.floor((W - gap * (n - 1)) / n))

  return (
    <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
      {preBars.map((bar, i) => {
        const x = i * (barW + gap)
        const barH = Math.max(2, Math.round((bar.volume / maxVol) * (H - 2)))
        const y = H - barH
        const fill = bar.isLargeSell
          ? '#ef4444'
          : bar.isLargeBuy
            ? '#22c55e'
            : bar.pct < 0
              ? (isDark ? '#7f1d1d' : '#fca5a5')
              : (isDark ? '#14532d' : '#bbf7d0')
        return <rect key={i} x={x} y={y} width={barW} height={barH} fill={fill} rx={1} />
      })}
      <line x1={W - 1} y1={0} x2={W - 1} y2={H} stroke="#667eea" strokeWidth={2} strokeDasharray="3,2" />
    </svg>
  )
}

const TREND_CFG = {
  uptrend:   { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',   label: '↑ Uptrend',   sub: 'P>50MA>200MA ↑' },
  downtrend: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',   label: '↓ Downtrend', sub: 'P<50MA<200MA ↓' },
  up_mixed:  { color: '#84cc16', bg: 'rgba(132,204,18,0.12)',  label: '↑ Mixed',     sub: 'P>50MA>200MA' },
  down_mixed:{ color: '#f97316', bg: 'rgba(249,115,22,0.12)',  label: '↓ Mixed',     sub: 'P<50MA<200MA' },
  neutral:   { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', label: '→ Neutral',   sub: '' },
  unknown:   { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', label: '—',           sub: '' },
}

function TrendCell({ ev, textMid }) {
  const cfg = TREND_CFG[ev.trend] || TREND_CFG.unknown
  const slopeSign = ev.ma50Slope > 0 ? '+' : ''
  return (
    <div>
      <span style={{
        fontSize: '11px', fontWeight: '600', padding: '2px 7px',
        borderRadius: '4px', background: cfg.bg, color: cfg.color,
        whiteSpace: 'nowrap',
      }}>
        {cfg.label}
      </span>
      {ev.ma50 && (
        <div style={{ fontSize: '10px', color: textMid, marginTop: '3px', lineHeight: 1.5 }}>
          <span>50MA {ev.close > ev.ma50 ? '▲' : '▼'}{ev.ma50.toFixed(0)}</span>
          {ev.ma200 && <span style={{ marginLeft: '6px' }}>200MA {ev.close > ev.ma200 ? '▲' : '▼'}{ev.ma200.toFixed(0)}</span>}
          {ev.ma50Slope != null && <span style={{ marginLeft: '6px', color: ev.ma50Slope > 0 ? '#22c55e' : '#ef4444' }}>{slopeSign}{ev.ma50Slope.toFixed(2)}%/10</span>}
        </div>
      )}
    </div>
  )
}

function TriggerBadges({ triggers, pnlColor }) {
  const downTriggers = triggers.filter(t => t.dir === 'down')
  const upTriggers = triggers.filter(t => t.dir === 'up')
  const worstDown = downTriggers.reduce((m, t) => t.pct < m ? t.pct : m, 0)
  const bestUp = upTriggers.reduce((m, t) => t.pct > m ? t.pct : m, 0)
  const types = [...new Set(triggers.map(t => t.type))]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {downTriggers.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ color: '#ef4444', fontWeight: '700', fontSize: '13px' }}>
            ↓ {Math.abs(worstDown).toFixed(1)}%
          </span>
          {types.includes('single') && downTriggers.some(t => t.type === 'single') && (
            <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>bar</span>
          )}
          {types.includes('multi') && downTriggers.some(t => t.type === 'multi') && (
            <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>{`${triggers[0]?.lookAhead || ''}swing`}</span>
          )}
        </div>
      )}
      {upTriggers.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ color: '#22c55e', fontWeight: '700', fontSize: '13px' }}>
            ↑ {bestUp.toFixed(1)}%
          </span>
          {types.includes('single') && upTriggers.some(t => t.type === 'single') && (
            <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>bar</span>
          )}
          {types.includes('multi') && upTriggers.some(t => t.type === 'multi') && (
            <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(34,197,94,0.1)', color: '#4ade80' }}>swing</span>
          )}
        </div>
      )}
    </div>
  )
}

const NUM_KEYS = ['singleThreshold', 'multiThreshold', 'lookAhead', 'lookBack', 'volMultiple']

export default function PreMoveVolumePanel() {
  const { isDark } = useTheme()

  const [symbolInput, setSymbolInput] = useState('')
  const [tf, setTf] = useState('1d')
  const [period, setPeriod] = useState('1y')
  const [direction, setDirection] = useState('both')
  const [singleOn, setSingleOn] = useState(true)
  const [multiOn, setMultiOn] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [cfg, setCfg] = useState({
    singleThreshold: '3', multiThreshold: '5',
    lookAhead: '5', lookBack: '10', volMultiple: '1.5',
  })
  const [trendFilter, setTrendFilter] = useState('all')
  const [minSells, setMinSells] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const surface = isDark ? '#1e2130' : '#ffffff'
  const surface2 = isDark ? '#252a3a' : '#f8fafc'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const rowAlt = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)'
  const rowBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'

  const setCfgField = (key, val) => setCfg(prev => ({ ...prev, [key]: val }))

  const runSearch = async () => {
    const sym = symbolInput.trim().toUpperCase()
    if (!sym) return
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const params = new URLSearchParams({
        tf, period, dir: direction,
        single: cfg.singleThreshold, multi: cfg.multiThreshold,
        ahead: cfg.lookAhead, back: cfg.lookBack, volX: cfg.volMultiple,
        single_on: singleOn, multi_on: multiOn,
      })
      const res = await fetch(`/api/pre-move-volume/${sym}?${params}`)
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Analysis failed')
      setData(json)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Summary stats (over raw events, not filtered view)
  const downEvents = useMemo(() => (data?.events || []).filter(e => e.triggers.some(t => t.dir === 'down')), [data])
  const upEvents = useMemo(() => (data?.events || []).filter(e => e.triggers.some(t => t.dir === 'up')), [data])
  const avgSellsDown = downEvents.length > 0
    ? (downEvents.reduce((s, e) => s + e.largeSellCount, 0) / downEvents.length).toFixed(1) : null
  const avgBuysUp = upEvents.length > 0
    ? (upEvents.reduce((s, e) => s + e.largeBuyCount, 0) / upEvents.length).toFixed(1) : null
  const avgVolDown = downEvents.length > 0
    ? (downEvents.reduce((s, e) => s + e.avgPreVol, 0) / downEvents.length).toFixed(2) : null

  // Filtered events (trend filter + min sells filter)
  const visibleEvents = useMemo(() => {
    let evs = data?.events || []
    if (trendFilter !== 'all') evs = evs.filter(e => e.trend === trendFilter)
    const ms = parseInt(minSells)
    if (!isNaN(ms) && ms > 0) evs = evs.filter(e => e.largeSellCount >= ms)
    return evs
  }, [data, trendFilter, minSells])

  // Signal strength breakdown: of down events with ≥N sells, what % followed up?
  const signalRows = useMemo(() => {
    if (!downEvents.length) return []
    return [4, 5, 6, 7].map(n => {
      const withN = downEvents.filter(e => e.largeSellCount >= n)
      const uptrend = withN.filter(e => e.trend === 'uptrend' || e.trend === 'up_mixed')
      return { n, count: withN.length, uptrend: uptrend.length }
    }).filter(r => r.count > 0)
  }, [downEvents])

  const btnBase = {
    padding: '5px 12px', fontSize: '12px', fontWeight: '600', borderRadius: '6px',
    cursor: 'pointer', border: `1px solid ${border}`, transition: 'all 0.15s',
  }
  const activeBtn = { ...btnBase, background: 'rgba(102,126,234,0.18)', borderColor: '#667eea', color: '#667eea' }
  const inactiveBtn = { ...btnBase, background: 'transparent', color: textMid }

  const inputStyle = {
    padding: '6px 10px', borderRadius: '6px', border: `1px solid ${border}`,
    background: surface, color: text, fontSize: '13px', width: '52px',
  }

  const fmtDate = (s) => {
    if (!s) return '—'
    const [y, m, d] = s.split('-')
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`
  }

  return (
    <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: '12px', padding: '20px', marginBottom: '20px', color: text }}>
      {/* Title */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>Pre-Move Volume Scanner</h2>
        <div style={{ fontSize: '12px', color: textMid, marginTop: '3px' }}>
          Identify large volume candles before significant price moves
        </div>
      </div>

      {/* Search row */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input
          type="text"
          placeholder="Symbol (e.g. SPY)"
          value={symbolInput}
          onChange={e => setSymbolInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && runSearch()}
          style={{ ...inputStyle, width: '140px', fontSize: '14px', fontWeight: '600', letterSpacing: '0.5px' }}
        />
        <button
          onClick={runSearch}
          disabled={loading || !symbolInput.trim()}
          style={{
            padding: '6px 18px', fontSize: '13px', fontWeight: '700', borderRadius: '6px',
            cursor: loading || !symbolInput.trim() ? 'not-allowed' : 'pointer',
            border: 'none', background: '#667eea', color: '#fff',
            opacity: loading || !symbolInput.trim() ? 0.6 : 1,
          }}
        >
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>

        {/* TF */}
        <div style={{ display: 'flex', gap: '3px' }}>
          {[['4h','4H'],['1d','1D']].map(([v,l]) => (
            <button key={v} style={tf === v ? activeBtn : inactiveBtn} onClick={() => {
              setTf(v)
              if (v === '4h' && period === '5y') setPeriod('2y')
            }}>{l}</button>
          ))}
        </div>

        {/* Period */}
        <div style={{ display: 'flex', gap: '3px' }}>
          {[['1y','1Y'],['2y','2Y'],['5y','5Y']].map(([v,l]) => {
            const disabled = v === '5y' && tf === '4h'
            return (
              <button key={v}
                disabled={disabled}
                style={period === v && !disabled ? activeBtn : { ...inactiveBtn, opacity: disabled ? 0.35 : 1 }}
                onClick={() => !disabled && setPeriod(v)}
              >{l}</button>
            )
          })}
        </div>

        {/* Direction */}
        <div style={{ display: 'flex', gap: '3px' }}>
          {[['both','Both'],['down','↓ Down'],['up','↑ Up']].map(([v,l]) => (
            <button key={v} style={direction === v ? activeBtn : inactiveBtn} onClick={() => setDirection(v)}>{l}</button>
          ))}
        </div>

        <button
          style={{ ...inactiveBtn, fontSize: '11px' }}
          onClick={() => setShowAdvanced(p => !p)}
        >
          {showAdvanced ? '▲ Less' : '▼ More'}
        </button>
      </div>

      {/* Advanced config */}
      {showAdvanced && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center',
          padding: '12px 14px', marginBottom: '12px',
          background: surface2, borderRadius: '8px', border: `1px solid ${border}`,
          fontSize: '12px',
        }}>
          {/* Single candle toggle + threshold */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: text, cursor: 'pointer' }}>
            <input type="checkbox" checked={singleOn} onChange={e => setSingleOn(e.target.checked)} />
            Single bar ≥
            <input
              type="number" min="0.5" max="20" step="0.5"
              value={cfg.singleThreshold}
              onChange={e => setCfgField('singleThreshold', e.target.value)}
              style={{ ...inputStyle, width: '50px' }}
              disabled={!singleOn}
            />
            %
          </label>

          {/* Multi candle toggle + threshold */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: text, cursor: 'pointer' }}>
            <input type="checkbox" checked={multiOn} onChange={e => setMultiOn(e.target.checked)} />
            Swing ≥
            <input
              type="number" min="1" max="30" step="0.5"
              value={cfg.multiThreshold}
              onChange={e => setCfgField('multiThreshold', e.target.value)}
              style={{ ...inputStyle, width: '50px' }}
              disabled={!multiOn}
            />
            % over
            <input
              type="number" min="1" max="20" step="1"
              value={cfg.lookAhead}
              onChange={e => setCfgField('lookAhead', e.target.value)}
              style={{ ...inputStyle, width: '44px' }}
              disabled={!multiOn}
            />
            candles
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: text }}>
            Look back
            <input
              type="number" min="3" max="20" step="1"
              value={cfg.lookBack}
              onChange={e => setCfgField('lookBack', e.target.value)}
              style={{ ...inputStyle, width: '44px' }}
            />
            candles
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: text }}>
            Large vol ≥
            <input
              type="number" min="0.5" max="10" step="0.1"
              value={cfg.volMultiple}
              onChange={e => setCfgField('volMultiple', e.target.value)}
              style={{ ...inputStyle, width: '50px' }}
            />
            × avg
          </label>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '14px', fontSize: '11px', color: textMid }}>
        {[
          { color: '#ef4444', label: `Large sell (vol ≥ ${cfg.volMultiple}× avg, bearish)` },
          { color: '#22c55e', label: `Large buy (vol ≥ ${cfg.volMultiple}× avg, bullish)` },
          { color: isDark ? '#7f1d1d' : '#fca5a5', label: 'Normal sell' },
          { color: isDark ? '#14532d' : '#bbf7d0', label: 'Normal buy' },
          { color: '#667eea', label: 'Event start →' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '10px', height: '10px', background: color, borderRadius: '2px', flexShrink: 0 }} />
            {label}
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '12px', background: isDark ? 'rgba(239,68,68,0.1)' : '#fef2f2', borderRadius: '8px', color: '#ef4444', fontSize: '13px', marginBottom: '14px' }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: textMid, fontSize: '14px' }}>
          Fetching {period.toUpperCase()} of {tf === '4h' ? '4H' : 'daily'} data for {symbolInput}…
        </div>
      )}

      {/* Summary stats */}
      {data && !loading && (
        <>
          {/* Stats bar */}
          <div style={{
            display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'center',
            padding: '10px 14px', marginBottom: '10px',
            background: surface2, borderRadius: '8px', border: `1px solid ${border}`,
            fontSize: '13px',
          }}>
            <span style={{ fontWeight: '700', color: text }}>
              {data.symbol} · {data.period.toUpperCase()} {data.tf === '4h' ? '4H' : '1D'}
            </span>
            <span style={{ color: textMid }}>{data.eventCount} events{data.eventCount > 200 ? ' (showing 200)' : ''}</span>
            {downEvents.length > 0 && avgSellsDown && (
              <span style={{ color: textMid }}>
                Avg <span style={{ color: '#ef4444', fontWeight: '600' }}>{avgSellsDown}</span> large sells before ↓
              </span>
            )}
            {upEvents.length > 0 && avgBuysUp && (
              <span style={{ color: textMid }}>
                Avg <span style={{ color: '#22c55e', fontWeight: '600' }}>{avgBuysUp}</span> large buys before ↑
              </span>
            )}
            {downEvents.length > 0 && avgVolDown && (
              <span style={{ color: textMid }}>
                Pre-vol avg <span style={{ fontWeight: '600', color: text }}>{avgVolDown}×</span>
              </span>
            )}
          </div>

          {/* Signal strength table */}
          {signalRows.length > 0 && (
            <div style={{
              display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px',
              padding: '10px 14px', background: surface2,
              borderRadius: '8px', border: `1px solid ${border}`, alignItems: 'center',
            }}>
              <span style={{ fontSize: '12px', fontWeight: '600', color: textMid, marginRight: '4px' }}>↓ moves with ≥N large sells:</span>
              {signalRows.map(r => (
                <div key={r.n} style={{
                  padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
                  background: r.n >= 6
                    ? 'rgba(239,68,68,0.18)'
                    : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${r.n >= 6 ? 'rgba(239,68,68,0.4)' : 'transparent'}`,
                  color: r.n >= 6 ? '#ef4444' : textMid,
                }}>
                  ≥{r.n} sells: <span style={{ color: r.n >= 6 ? '#ef4444' : text }}>{r.count}</span>
                  {r.uptrend > 0 && (
                    <span style={{ color: '#22c55e', marginLeft: '6px' }}>
                      {r.uptrend} uptrend ({Math.round(r.uptrend / r.count * 100)}%)
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Filters row */}
          <div style={{
            display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center',
            marginBottom: '12px', fontSize: '12px',
          }}>
            <span style={{ color: textMid, fontWeight: '600' }}>Filter:</span>
            {/* Trend filter */}
            <div style={{ display: 'flex', gap: '3px' }}>
              {[
                ['all', 'All trends'],
                ['uptrend', '↑ Uptrend'],
                ['up_mixed', '↑ Mixed'],
                ['neutral', '→ Neutral'],
                ['down_mixed', '↓ Mixed'],
                ['downtrend', '↓ Downtrend'],
              ].map(([v, l]) => (
                <button key={v}
                  style={trendFilter === v ? activeBtn : inactiveBtn}
                  onClick={() => setTrendFilter(v)}
                >{l}</button>
              ))}
            </div>
            {/* Min sells filter */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', color: textMid }}>
              Min sells
              <input
                type="number" min="0" max="20"
                value={minSells}
                onChange={e => setMinSells(e.target.value)}
                placeholder="any"
                style={{ ...inputStyle, width: '48px' }}
              />
            </label>
            {(trendFilter !== 'all' || minSells) && (
              <span style={{ color: textMid, fontSize: '12px' }}>
                {visibleEvents.length} matching
                <button
                  onClick={() => { setTrendFilter('all'); setMinSells('') }}
                  style={{ ...inactiveBtn, marginLeft: '6px', padding: '2px 8px', fontSize: '11px' }}
                >Clear</button>
              </span>
            )}
          </div>

          {visibleEvents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
              No events match the current filters
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${border}` }}>
                    {[
                      ['Date', 'left'],
                      ['Move', 'left'],
                      ['Lg Sells Prior', 'center'],
                      ['Lg Buys Prior', 'center'],
                      ['Avg Vol', 'center'],
                      ['Trend at Event', 'left'],
                      [`Vol (${cfg.lookBack} bars before → event)`, 'left'],
                    ].map(([h, align]) => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: align, color: text, fontWeight: '700', fontSize: '12px', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((ev, i) => {
                    const highSignal = ev.largeSellCount >= 6
                    const medSignal = ev.largeSellCount >= 4
                    return (
                      <tr key={i} style={{
                        background: highSignal
                          ? (isDark ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.04)')
                          : i % 2 === 1 ? rowAlt : 'transparent',
                        borderBottom: `1px solid ${rowBorder}`,
                        outline: highSignal ? `1px solid rgba(239,68,68,0.2)` : 'none',
                      }}>
                        <td style={{ padding: '10px', whiteSpace: 'nowrap', color: textMid, fontSize: '12px' }}>
                          {fmtDate(ev.date)}
                        </td>
                        <td style={{ padding: '10px' }}>
                          <TriggerBadges triggers={ev.triggers} />
                        </td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <span style={{
                            fontWeight: '700', fontSize: '14px',
                            color: ev.largeSellCount >= 6 ? '#ef4444'
                              : ev.largeSellCount >= 4 ? '#f97316'
                              : ev.largeSellCount >= 1 ? textMid : textMid,
                          }}>
                            {ev.largeSellCount >= 6 ? '🔴' : ev.largeSellCount >= 4 ? '🟠' : ''}{ev.largeSellCount}
                          </span>
                        </td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <span style={{
                            fontWeight: '700', fontSize: '14px',
                            color: ev.largeBuyCount >= 3 ? '#22c55e' : ev.largeBuyCount >= 1 ? '#84cc16' : textMid
                          }}>
                            {ev.largeBuyCount}
                          </span>
                        </td>
                        <td style={{ padding: '10px', textAlign: 'center', color: textMid, fontSize: '12px' }}>
                          {ev.avgPreVol}×
                        </td>
                        <td style={{ padding: '10px' }}>
                          <TrendCell ev={ev} textMid={textMid} />
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <VolumeSparkline preBars={ev.preBars} isDark={isDark} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!data && !loading && !error && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: textMid, fontSize: '14px' }}>
          Enter a symbol and click Analyze to scan for pre-move volume patterns
        </div>
      )}
    </div>
  )
}
