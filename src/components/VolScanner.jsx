import React, { useState, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const pct = (v, d = 1) => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(d)}%`
const num = (v, d = 2) => (v == null || isNaN(v)) ? '—' : v.toFixed(d)

// IV vs HV: options are "rich" (good to SELL premium) when implied vol sits well
// above the stock's recent realized (historical) vol. Ratio ≥ 1.3 = rich, ≤ 0.9 = cheap.
export default function VolScanner() {
  const { isDark } = useTheme()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [tickers, setTickers] = useState('')
  const [cachedAt, setCachedAt] = useState(null)
  const [view, setView] = useState('mine') // 'mine' | 'sp500' | 'custom'
  const [scanInfo, setScanInfo] = useState(null)

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const headerBg = isDark ? '#151929' : '#f8fafc'

  const fetchData = async ({ tk = '', uni = '', refresh = false, quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    setError(null); if (!uni) setCachedAt(null)
    try {
      let q = ''
      if (uni) q = `?universe=${uni}${refresh ? '&refresh=1' : ''}`
      else if (tk.trim()) q = `?tickers=${encodeURIComponent(tk.trim().toUpperCase())}`
      const res = await fetch(`/api/vol-scan${q}`, { credentials: 'include' })
      const json = await res.json()
      if (json.success) {
        setRows(Array.isArray(json.results) ? json.results : [])
        setCachedAt(json.cachedAt || null)
        setScanInfo(uni ? { running: json.scanRunning, progress: json.scanProgress, universeSize: json.universeSize, count: json.count } : null)
      } else setError(json.error || 'Failed to load')
    } catch (e) { setError(e.message) }
    finally { if (!quiet) setLoading(false) }
  }

  useEffect(() => { fetchData() }, [])

  // While the S&P/NASDAQ background scan is running, poll to show it filling in.
  useEffect(() => {
    if (view === 'sp500' && scanInfo?.running) {
      const t = setTimeout(() => fetchData({ uni: 'sp500', quiet: true }), 15000)
      return () => clearTimeout(t)
    }
  }, [view, scanInfo])

  const signalStyle = (s) => {
    if (s === 'rich') return { bg: '#22c55e22', color: '#22c55e', label: '🔥 Rich' }
    if (s === 'cheap') return { bg: '#ef444422', color: '#ef4444', label: '🧊 Cheap' }
    if (s === 'normal') return { bg: '#94a3b822', color: textMid, label: '— Normal' }
    return { bg: 'transparent', color: textMid, label: '—' }
  }

  // IV Rank builds over time; show the day-count until there's enough history.
  const rankCell = (val, days) => {
    if (val == null) return <span style={{ fontSize: '11px', color: textMid }} title={`Building — ${days || 0} day(s) of history so far`}>{days ? `${days}d` : '—'}</span>
    const c = val >= 50 ? '#22c55e' : val <= 20 ? '#ef4444' : textMid
    return <span style={{ color: c, fontWeight: 700 }} title={`Today's IV is at the ${val.toFixed(0)}th %-of-range vs the past year`}>{val.toFixed(0)}%</span>
  }

  const th = { padding: '8px 10px', textAlign: 'right', fontSize: '11px', fontWeight: 700, color: textMid,
    textTransform: 'uppercase', letterSpacing: '0.04em', background: headerBg, borderBottom: `2px solid ${border}`, whiteSpace: 'nowrap' }

  return (
    <div style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: text }}>📊 Volatility Scanner</h3>
        <span style={{ fontSize: '12px', color: textMid }}>IV vs realized (HV) — which options are rich to sell</span>
        {cachedAt != null && (
          <span style={{ fontSize: '11px', color: textMid }} title="S&P/NASDAQ is served from a background scan that refreshes daily">
            (as of {new Date(cachedAt).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
          </span>
        )}
        <div style={{ flex: 1 }} />
        {[['mine', 'My Short Calls'], ['sp500', 'S&P + NASDAQ']].map(([v, label]) => (
          <button key={v} disabled={loading}
            onClick={() => { setView(v); fetchData(v === 'sp500' ? { uni: 'sp500' } : {}) }}
            style={{ padding: '6px 12px', borderRadius: '6px', border: `1px solid ${view === v ? '#3b82f6' : border}`,
              background: view === v ? '#3b82f6' : surface, color: view === v ? '#fff' : text, fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
        {view === 'sp500' && (
          <button disabled={loading || scanInfo?.running} onClick={() => fetchData({ uni: 'sp500', refresh: true })}
            title="Re-run the S&P/NASDAQ background scan now"
            style={{ padding: '6px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px', cursor: 'pointer' }}>
            ↻ Refresh
          </button>
        )}
        <input
          value={tickers}
          onChange={e => setTickers(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setView('custom'); fetchData({ tk: tickers }) } }}
          placeholder="or type tickers e.g. MRVL,HOOD"
          style={{ padding: '6px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px', width: '220px', maxWidth: '45vw' }}
        />
        <button onClick={() => { setView('custom'); fetchData({ tk: tickers }) }} disabled={loading || !tickers.trim()}
          style={{ padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', opacity: (!tickers.trim() ? 0.5 : 1) }}>
          {loading ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: '13px', marginBottom: '8px' }}>{error}</div>}

      {view === 'sp500' && scanInfo && (scanInfo.running || (scanInfo.count || 0) < (scanInfo.universeSize || 0)) && (
        <div style={{ marginBottom: '8px', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${border}`,
          background: isDark ? '#1a2035' : '#f8fafc', fontSize: '12px', color: textMid, display: 'flex', alignItems: 'center', gap: '8px' }}>
          {scanInfo.running ? (
            <>
              <span style={{ fontSize: '14px' }}>⏳</span>
              <span>
                Building the S&amp;P/NASDAQ scan in the background —{' '}
                <strong style={{ color: text }}>
                  {scanInfo.progress ? `${scanInfo.progress.done} of ${scanInfo.progress.total}` : `${scanInfo.count || 0} of ~${scanInfo.universeSize || '?'}`}
                </strong>{' '}
                names processed ({scanInfo.count || 0} ready). This list fills in automatically over the next few minutes.
              </span>
            </>
          ) : (
            <span>
              Showing <strong style={{ color: text }}>{scanInfo.count || 0}</strong> of ~{scanInfo.universeSize} names. Click ↻ Refresh to rescan the rest.
            </span>
          )}
        </div>
      )}

      <div className="floating-panel" style={{ overflowX: 'auto', borderRadius: '10px', border: `1px solid ${border}` }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '13px', background: surface }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
              <th style={th} title="Current stock price">Stock</th>
              <th style={th} title="30-day annualized realized (historical) volatility">HV 30d</th>
              <th style={th} title="Implied volatility of the ~30–45 DTE at-the-money call">IV (ATM)</th>
              <th style={th} title="IV ÷ HV — above ~1.3 means options are expensive vs how much the stock actually moves">IV / HV</th>
              <th style={th} title="Where today's IV sits in its own past-year range (0 = year low, 100 = year high). Builds up over time as daily snapshots accumulate.">IV Rank</th>
              <th style={th} title="% of the past year's days that IV was below today's. Builds up over time.">IV %ile</th>
              <th style={th} title="IV minus HV, in volatility points">Spread</th>
              <th style={th} title="Days to expiry of the sampled option">DTE</th>
              <th style={{ ...th, textAlign: 'center' }}>Signal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const sig = signalStyle(r.signal)
              return (
                <tr key={r.ticker} style={{ borderBottom: `1px solid ${border}`, background: i % 2 ? (isDark ? '#1a2035' : '#fafbff') : surface }}>
                  <td style={{ padding: '8px 10px', fontWeight: 700, color: text }}>{r.ticker}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: text }}>{r.stock != null ? `$${num(r.stock)}` : '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: textMid }}>{pct(r.hv30)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: text, fontWeight: 600 }}
                      title={r.ivSource ? `IV source: ${r.ivSource}` : ''}>{pct(r.iv)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: sig.color }}>{r.ivHvRatio != null ? num(r.ivHvRatio, 2) : '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{rankCell(r.ivRank, r.ivHistoryDays)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: textMid }}>{r.ivPercentile != null ? `${r.ivPercentile.toFixed(0)}%` : '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: textMid }}>{r.ivHvSpread != null ? `${r.ivHvSpread > 0 ? '+' : ''}${num(r.ivHvSpread, 1)}` : '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: textMid }}>{r.ivDte != null ? r.ivDte : '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    {r.signal
                      ? <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: sig.bg, color: sig.color }}>{sig.label}</span>
                      : (r.ivError || r.barsError)
                        ? <span style={{ fontSize: '11px', color: '#ef4444' }} title={r.ivError || r.barsError}>error</span>
                        : <span style={{ fontSize: '11px', color: textMid }}>—</span>}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={10} style={{ padding: '28px', textAlign: 'center', color: textMid }}>No data yet — enter tickers and Scan, or leave blank to scan your short‑call names.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '8px', fontSize: '11px', color: textMid, lineHeight: 1.5 }}>
        <strong style={{ color: '#22c55e' }}>🔥 Rich</strong> = IV well above realized vol → options relatively expensive, better odds when <em>selling</em> premium (covered calls / CSPs).{' '}
        <strong style={{ color: '#ef4444' }}>🧊 Cheap</strong> = IV below realized → options underpricing recent movement.{' '}
        HV is the stock's own recent realized volatility. <strong>IV Rank</strong> (where today's IV sits in its own past‑year range) starts as a day‑count and fills in as daily snapshots accumulate — high IV Rank + 🔥 Rich is the strongest sell‑premium setup. This flags relative richness only; high‑IV names are volatile for real reasons, so size for the tail. Not investment advice.
      </div>
    </div>
  )
}
