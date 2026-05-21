import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../contexts/ThemeContext'

const API = '/api/dca-schedule'

export default function DCAAlertPanel() {
  const { isDark } = useTheme()
  const [schedule, setSchedule] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [addSym, setAddSym] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const surface  = isDark ? '#1e2130' : '#ffffff'
  const surface2 = isDark ? '#252a3a' : '#f8fafc'
  const border   = isDark ? '#2d3748' : '#e2e8f0'
  const text     = isDark ? '#e2e8f0' : '#1a202c'
  const textMid  = isDark ? '#94a3b8' : '#64748b'
  const rowAlt   = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)'

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const r = await fetch(API, { credentials: 'include' })
      const j = await r.json()
      if (j.success) {
        setSchedule(j.schedule)
        // Only suggest symbols not already in schedule
        const scheduled = new Set(j.schedule.map(s => s.symbol))
        setSuggestions((j.suggestions || []).filter(s => !scheduled.has(s)))
      }
    } catch (e) {
      setError('Failed to load DCA schedule')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const addSymbol = async (sym) => {
    const symbol = (sym || addSym).trim().toUpperCase()
    if (!symbol) return
    await fetch(API, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    })
    setAddSym('')
    load()
  }

  const markBought = async (id) => {
    await fetch(`${API}/${id}/bought`, { method: 'PUT', credentials: 'include' })
    load()
  }

  const remove = async (id) => {
    await fetch(`${API}/${id}`, { method: 'DELETE', credentials: 'include' })
    load()
  }

  const due = schedule.filter(s => s.isDue)
  const upcoming = schedule.filter(s => !s.isDue)

  const fmtDate = (d) => {
    const [y, m, day] = d.split('-')
    return `${m}/${day}/${y}`
  }

  const btnStyle = (color = '#667eea') => ({
    padding: '4px 12px', fontSize: '12px', fontWeight: '700', borderRadius: '5px',
    cursor: 'pointer', border: 'none', background: color, color: '#fff',
  })

  const SymRow = ({ s, i }) => (
    <tr style={{ background: i % 2 === 1 ? rowAlt : 'transparent', borderBottom: `1px solid ${border}` }}>
      <td style={{ padding: '10px', fontWeight: '700', fontSize: '14px', color: text }}>{s.symbol}</td>
      <td style={{ padding: '10px', textAlign: 'center', color: textMid }}>{s.sharesHeld}</td>
      <td style={{ padding: '10px', textAlign: 'center' }}>
        {s.isDue ? (
          <span style={{ color: '#ef4444', fontWeight: '700' }}>Due now</span>
        ) : (
          <span style={{ color: s.daysUntil <= 3 ? '#f97316' : textMid }}>
            {fmtDate(s.nextAlertDate)} ({s.daysUntil}d)
          </span>
        )}
      </td>
      <td style={{ padding: '10px', textAlign: 'right' }}>
        <span style={{ display: 'inline-flex', gap: '6px' }}>
          <button onClick={() => markBought(s.id)} style={btnStyle('#22c55e')}>Bought!</button>
          <button onClick={() => remove(s.id)} style={{ ...btnStyle(), background: 'transparent', color: textMid, border: `1px solid ${border}` }}>✕</button>
        </span>
      </td>
    </tr>
  )

  if (loading) return null

  return (
    <div style={{ marginBottom: '20px' }}>
      {/* Due now banner */}
      {due.length > 0 && (
        <div style={{
          background: isDark ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: '10px', padding: '14px 18px', marginBottom: '12px',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px',
        }}>
          <span style={{ fontSize: '14px', fontWeight: '700', color: '#ef4444' }}>
            🔔 DCA Due:
          </span>
          {due.map(s => (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: '700', color: text }}>{s.symbol}</span>
              <span style={{ fontSize: '12px', color: textMid }}>{s.sharesHeld} shares</span>
              <button onClick={() => markBought(s.id)} style={btnStyle('#22c55e')}>Bought 1 share!</button>
            </span>
          ))}
        </div>
      )}

      {/* Schedule panel */}
      <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: '12px', padding: '20px', color: text }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>DCA Buy Schedule</h2>
            <div style={{ fontSize: '12px', color: textMid, marginTop: '3px' }}>
              Buy 1 share every 2 weeks — click "Bought!" to reset the 14-day timer
            </div>
          </div>

          {/* Add symbol */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {suggestions.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {suggestions.slice(0, 6).map(sym => (
                  <button key={sym} onClick={() => addSymbol(sym)} style={{
                    padding: '4px 10px', fontSize: '12px', fontWeight: '600', borderRadius: '5px',
                    cursor: 'pointer', border: `1px solid ${border}`, background: surface2, color: textMid,
                  }}>+ {sym}</button>
                ))}
              </div>
            )}
            <input
              value={addSym}
              onChange={e => setAddSym(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addSymbol()}
              placeholder="Add symbol…"
              style={{
                padding: '6px 10px', borderRadius: '6px', border: `1px solid ${border}`,
                background: surface, color: text, fontSize: '13px', width: '110px',
              }}
            />
            <button onClick={() => addSymbol()} style={btnStyle()}>Add</button>
          </div>
        </div>

        {error && <div style={{ color: '#ef4444', marginBottom: '12px', fontSize: '13px' }}>{error}</div>}

        {schedule.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: textMid, fontSize: '14px' }}>
            No stocks scheduled yet — add a symbol above or click a suggestion
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${border}` }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '12px', fontWeight: '700', color: text }}>Symbol</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: text }}>Shares Held</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: text }}>Next Buy</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: '12px', fontWeight: '700', color: text }}></th>
                </tr>
              </thead>
              <tbody>
                {due.map((s, i) => <SymRow key={s.id} s={s} i={i} />)}
                {upcoming.map((s, i) => <SymRow key={s.id} s={s} i={i + due.length} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
