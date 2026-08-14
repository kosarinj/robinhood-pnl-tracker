import React, { useState } from 'react'

/**
 * Fibonacci retracement + RSI screener.
 *
 * The pairing is the point. RSI alone fires constantly; a retracement level
 * alone is just a line on a chart. Together they say momentum is stretched AND
 * price has reached a level people actually watch — much rarer, and the reason
 * the two looked good together on the price chart.
 *
 * Retracement is measured from the swing high of the lookback:
 *   0% = at the highs, 100% = back at the lows.
 */

const LEVEL_COLOR = (atLevel) => atLevel ? 'var(--accent)' : 'var(--textSecondary)'

export default function FibRsiScreener() {
  const [range, setRange] = useState('6mo')
  const [rows, setRows] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [scanned, setScanned] = useState(0)

  const run = async () => {
    setRunning(true); setError(''); setRows(null)
    try {
      const r = await fetch(`/api/screener/fib-rsi?range=${range}`, { credentials: 'include' })
      const d = await r.json()
      if (!d?.success) throw new Error(d?.error || 'Scan failed')
      setRows(d.hits || [])
      setScanned(d.scanned || 0)
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const card = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '16px', marginBottom: 20, color: 'var(--text)',
  }
  // Was 10px uppercase in the muted secondary colour on no background, which is
  // about as hard as small text gets: low contrast, and wide tracking on tiny
  // capitals separates the letters faster than it helps. Matches the other
  // panels now — full-strength text on the table-header fill, which every theme
  // defines, so it stays readable in dark and light alike.
  const th = {
    textAlign: 'right', padding: '8px 10px', fontSize: 11, fontWeight: 700,
    color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.05em',
    background: 'var(--tableHeader)',
    borderBottom: `2px solid var(--border)`, whiteSpace: 'nowrap',
  }
  const td = {
    textAlign: 'right', padding: '8px 10px', fontSize: 12.5,
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }

  const oversold = (rows || []).filter(r => r.signal === 'oversold')
  const overbought = (rows || []).filter(r => r.signal === 'overbought')

  return (
    <div className="floating-panel" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Fibonacci + RSI</h3>
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {['3mo', '6mo', '1y'].map(r => (
            <button key={r} onClick={() => setRange(r)}
              style={{
                padding: '3px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                borderRadius: 4, fontFamily: 'inherit',
                border: `1px solid ${range === r ? 'var(--accent)' : 'var(--border)'}`,
                background: range === r ? 'var(--accent)' : 'transparent',
                color: range === r ? 'var(--accentText)' : 'var(--textSecondary)',
              }}>{r.replace('mo', 'M').replace('1y', '1Y')}</button>
          ))}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={run} disabled={running}
          style={{
            padding: '6px 14px', fontSize: 12.5, fontWeight: 600, borderRadius: 6,
            cursor: running ? 'default' : 'pointer', fontFamily: 'inherit',
            border: '1px solid var(--accent)',
            background: running ? 'transparent' : 'var(--accent)',
            color: running ? 'var(--textSecondary)' : 'var(--accentText)',
          }}>
          {running ? 'Scanning…' : 'Run scan'}
        </button>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--textSecondary)', marginBottom: 12, lineHeight: 1.5, maxWidth: '72ch' }}>
        Names where momentum and price level agree. <strong style={{ color: 'var(--text)' }}>Oversold</strong> = retraced
        past 61.8% of the {range} range with RSI ≤ 35. <strong style={{ color: 'var(--text)' }}>Overbought</strong> = within
        23.6% of the highs with RSI ≥ 65. Your holdings are checked too and sort first.
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: 'var(--severity)' }}>Scan failed: {error}</div>
      )}

      {running && (
        <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>
          Fetching daily bars for ~320 names — this takes a minute.
        </div>
      )}

      {rows && !running && (
        rows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--textSecondary)' }}>
            Nothing matched across {scanned} names. Both conditions have to hold at once,
            so an empty result is normal — try a longer range.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--textSecondary)', marginBottom: 6 }}>
              {oversold.length} oversold · {overbought.length} overbought · {scanned} scanned
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
                    <th style={{ ...th, textAlign: 'left' }}>Signal</th>
                    <th style={th}>Price</th>
                    <th style={th}>RSI</th>
                    <th style={th}>Retrace</th>
                    <th style={th}>Level</th>
                    <th style={th}>Range low</th>
                    <th style={th}>Range high</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.ticker}>
                      <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>
                        {r.ticker}
                        {r.held && (
                          <span title="You hold this"
                            style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 4px',
                              borderRadius: 3, border: '1px solid var(--border)', color: 'var(--textSecondary)',
                            }}>HELD</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'left' }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px',
                          borderRadius: 3, textTransform: 'uppercase',
                          color: r.signal === 'oversold' ? 'var(--chartPositive)' : 'var(--chartNegative)',
                          border: `1px solid ${r.signal === 'oversold' ? 'var(--chartPositive)' : 'var(--chartNegative)'}`,
                        }}>{r.signal}</span>
                      </td>
                      <td style={td}>${r.price.toFixed(2)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{r.rsi.toFixed(1)}</td>
                      <td style={td}>{r.retracePct.toFixed(1)}%</td>
                      <td style={{ ...td, color: LEVEL_COLOR(r.atLevel), fontWeight: r.atLevel ? 700 : 400 }}
                          title={r.atLevel ? 'Sitting on a Fibonacci level' : 'Between levels'}>
                        {r.fibLevel}%{r.atLevel ? ' ●' : ''}
                      </td>
                      <td style={{ ...td, color: 'var(--textSecondary)' }}>${r.low.toFixed(2)}</td>
                      <td style={{ ...td, color: 'var(--textSecondary)' }}>${r.high.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--textSecondary)', marginTop: 10, lineHeight: 1.45 }}>
              A filled dot means price is within 4% of the level rather than merely past it.
              This is a screen, not a signal — it says where to look, not what to do.
            </div>
          </>
        )
      )}
    </div>
  )
}
