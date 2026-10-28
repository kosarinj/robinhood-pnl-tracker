import React, { useState, useEffect, useRef } from 'react'
import { getPref, setPref } from '../services/prefs'
import { brokerQuery, withQuery } from '../services/dashData'

/**
 * A slim scrolling strip of headlines under the tabs -- stories on the names
 * you hold and macro (Fed, CPI, jobs, yields, tariffs) -- and a flash in the
 * corner when something new lands.
 *
 * "New" means published in the last 30 minutes and not flashed before on this
 * device, so a reload doesn't replay the same alerts. Hovering the strip
 * pauses it; clicking a headline opens the story.
 */

const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}
const SENT = { positive: 'var(--positive)', negative: 'var(--negative)', neutral: 'var(--textSecondary)' }

const SEEN_KEY = 'newsFlashSeen'
const readSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) } catch { return new Set() } }
const writeSeen = (set) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-300))) } catch { /* private mode */ } }

const Tag = ({ item }) => (
  <>
    {item.tickers.slice(0, 3).map(t => (
      <b key={t} style={{ color: SENT[item.sentiment[t]] || 'var(--accent)', marginRight: 4 }}>{t}</b>
    ))}
    {!item.tickers.length && item.macro && <b style={{ color: 'var(--warning)', marginRight: 4 }}>MACRO</b>}
  </>
)

export default function NewsTicker({ broker = 'all' }) {
  const [items, setItems] = useState(null)
  const [note, setNote] = useState(null)
  const [filter, setFilter] = useState(() => getPref('newsFilter', 'all'))
  const [flashOn, setFlashOn] = useState(() => getPref('newsFlash', true) !== false)
  const [hidden, setHidden] = useState(() => getPref('newsHidden', false) === true)
  const [flashes, setFlashes] = useState([])
  const [paused, setPaused] = useState(false)
  const flashOnRef = useRef(flashOn)
  flashOnRef.current = flashOn

  useEffect(() => {
    let alive = true
    const load = () => fetch(withQuery('/api/news', brokerQuery(broker)), { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        if (!d?.success) { setNote(d?.error || 'news unavailable'); return }
        setNote(d.unavailable || null)
        setItems(d.items || [])
        // Flash what's fresh and unseen.
        const seen = readSeen()
        const fresh = (d.items || []).filter(i => !seen.has(i.id) && Date.now() - new Date(i.published).getTime() < 30 * 60000)
        ;(d.items || []).forEach(i => seen.add(i.id))
        writeSeen(seen)
        if (fresh.length && flashOnRef.current) {
          setFlashes(f => [...fresh.slice(0, 3).map(i => ({ ...i, at: Date.now() })), ...f].slice(0, 3))
        }
      })
      .catch(e => alive && setNote(e.message))
    load()
    const iv = setInterval(load, 3 * 60000)
    return () => { alive = false; clearInterval(iv) }
  }, [broker])

  // Each flash leaves on its own after 15 seconds.
  useEffect(() => {
    if (!flashes.length) return
    const t = setTimeout(() => setFlashes(f => f.filter(x => Date.now() - x.at < 15000)), 15500)
    return () => clearTimeout(t)
  }, [flashes])

  const shown = (items || []).filter(i => filter === 'all' || (filter === 'mine' ? i.tickers.length : i.macro)).slice(0, 40)
  const setF = (f) => { setFilter(f); setPref('newsFilter', f) }
  const btn = (active) => ({
    background: 'none', border: 'none', boxShadow: 'none', padding: '2px 6px', minHeight: 0, minWidth: 0,
    fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', borderRadius: 6,
    color: active ? 'var(--accent)' : 'var(--textSecondary)',
  })

  if (hidden) {
    return (
      <div style={{ textAlign: 'right', margin: '4px 0' }}>
        <button style={btn(false)} onClick={() => { setHidden(false); setPref('newsHidden', false) }}>Show news</button>
      </div>
    )
  }

  // Duration scales with length so the read speed stays the same.
  const duration = Math.max(40, shown.length * 7)
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 8px', padding: '4px 6px',
        background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12.5, minWidth: 0,
      }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--textSecondary)', padding: '0 4px', flexShrink: 0 }}>NEWS</span>
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onTouchStart={() => setPaused(p => !p)}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', maskImage: 'linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent)', WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent)' }}>
          {items == null ? <span style={{ color: 'var(--textSecondary)' }}>loading headlines…</span>
            : !shown.length ? <span style={{ color: 'var(--textSecondary)' }}>{note || 'No recent headlines.'}</span>
            : (
              <div style={{ display: 'inline-block', animation: `newsScroll ${duration}s linear infinite`, animationPlayState: paused ? 'paused' : 'running' }}>
                {[0, 1].map(copy => (
                  <span key={copy} aria-hidden={copy === 1}>
                    {shown.map(i => (
                      <a key={`${copy}-${i.id}`} href={i.url} target="_blank" rel="noopener noreferrer" title={`${i.publisher} · ${new Date(i.published).toLocaleString()}`}
                        style={{ color: 'var(--text)', textDecoration: 'none', marginRight: 28 }}>
                        <Tag item={i} />{i.title}
                        <span style={{ color: 'var(--textSecondary)', marginLeft: 6, fontSize: 11 }}>{ago(i.published)}</span>
                      </a>
                    ))}
                  </span>
                ))}
              </div>
            )}
        </div>
        <div style={{ display: 'flex', flexShrink: 0 }}>
          {[['all', 'All'], ['mine', 'Mine'], ['macro', 'Macro']].map(([k, l]) => (
            <button key={k} style={btn(filter === k)} onClick={() => setF(k)}>{l}</button>
          ))}
          <button style={btn(flashOn)} title={flashOn ? 'Pop-ups on for new stories — click to mute' : 'Pop-ups muted — click to turn on'}
            onClick={() => { setFlashOn(!flashOn); setPref('newsFlash', !flashOn) }}>{flashOn ? '🔔' : '🔕'}</button>
          <button style={btn(false)} title="Hide the news strip" onClick={() => { setHidden(true); setPref('newsHidden', true) }}>✕</button>
        </div>
      </div>

      {flashes.length > 0 && (
        <div style={{ position: 'fixed', top: 72, right: 16, zIndex: 3000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(380px, calc(100vw - 32px))' }}>
          {flashes.map(f => (
            <div key={f.id} className="news-flash" style={{
              background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
              borderLeft: `4px solid ${f.tickers.length ? (SENT[f.sentiment[f.tickers[0]]] || 'var(--accent)') : 'var(--warning)'}`,
              borderRadius: 10, padding: '10px 12px', boxShadow: '0 8px 28px var(--shadow)', fontSize: 13,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--textSecondary)', marginBottom: 3 }}>
                <span><Tag item={f} /> {f.publisher} · {ago(f.published)} ago</span>
                <button style={btn(false)} onClick={() => setFlashes(x => x.filter(y => y.id !== f.id))}>✕</button>
              </div>
              <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)', fontWeight: 600, textDecoration: 'none', lineHeight: 1.35 }}>{f.title}</a>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
