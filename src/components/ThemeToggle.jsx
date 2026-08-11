import { useState, useRef, useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'

/**
 * Theme picker.
 *
 * Was a light/dark toggle, which couldn't reach the themes beyond those two —
 * from any other theme it just jumped to dark. Now it lists them all, with a
 * swatch of each one's own surface, accent and semantic colours so the choice
 * is made by looking rather than by reading a name.
 */
export default function ThemeToggle() {
  const { theme, themes, setTheme, isDark } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click and on Escape — a menu that traps you is worse than
  // no menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const entries = Object.values(themes)

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Theme: ${themes[theme]?.label || theme}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8, padding: '5px 10px', cursor: 'pointer',
          color: 'var(--text)', fontSize: 12.5, fontWeight: 600,
          fontFamily: 'inherit',
        }}
      >
        <Swatch t={themes[theme]} />
        <span>{themes[theme]?.label || theme}</span>
        <span aria-hidden="true" style={{ color: 'var(--textSecondary)', fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 1000,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 10, padding: 5, minWidth: 190,
            boxShadow: '0 8px 24px var(--shadow)',
            display: 'flex', flexDirection: 'column', gap: 1,
          }}
        >
          {entries.map(t => {
            const active = t.name === theme
            return (
              <button
                key={t.name}
                role="option"
                aria-selected={active}
                onClick={() => { setTheme(t.name); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '7px 9px', borderRadius: 6, cursor: 'pointer',
                  border: '1px solid transparent',
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--accentText)' : 'var(--text)',
                  fontSize: 13, fontWeight: active ? 700 : 500,
                  fontFamily: 'inherit', textAlign: 'left', width: '100%',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surfaceHover)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                <Swatch t={t} />
                <span style={{ flex: 1 }}>{t.label}</span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{t.dark ? 'dark' : 'light'}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Three bands: the theme's own surface, accent and positive/negative pair. */
function Swatch({ t }) {
  if (!t) return null
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex', width: 30, height: 14, borderRadius: 3,
        overflow: 'hidden', border: '1px solid var(--border)', flexShrink: 0,
      }}
    >
      <span style={{ flex: 1, background: t.surface }} />
      <span style={{ flex: 1, background: t.accent }} />
      <span style={{ flex: 1, background: t.positive }} />
      <span style={{ flex: 1, background: t.negative }} />
    </span>
  )
}
