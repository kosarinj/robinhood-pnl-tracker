import { useState } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { useSettings } from '../contexts/SettingsContext'

const TINTS = [
  { label: 'None', value: 'none' },
  { label: 'Darken', value: 'rgba(0,0,0,0.35)' },
  { label: 'Lighten', value: 'rgba(255,255,255,0.35)' }
]

export default function SettingsPanel() {
  const { theme, themes, setTheme } = useTheme()
  const { bgUrl, setBgUrl, bgOpacity, setBgOpacity, bgTint, setBgTint, bgBlur, setBgBlur } = useSettings()
  const [open, setOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState(bgUrl)

  const themeList = Object.values(themes)

  const label = { display: 'block', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--textSecondary)', margin: '14px 0 6px' }
  const input = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }

  return (
    <>
      <button
        onClick={() => { setUrlDraft(bgUrl); setOpen(true) }}
        title="Settings — theme & background"
        style={{
          position: 'fixed', top: 20, right: 20, width: 48, height: 48, borderRadius: '50%',
          background: 'var(--surface)', border: '2px solid var(--border)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
          boxShadow: '0 2px 8px var(--shadow)', zIndex: 1000
        }}
      >⚙️</button>

      {open && (
        <div onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 16px', overflowY: 'auto' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--surface)', color: 'var(--text)', borderRadius: 12, border: '1px solid var(--border)', width: 420, maxWidth: '100%', padding: 22, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>⚙️ Settings</h2>
              <button onClick={() => setOpen(false)} style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: 'var(--textSecondary)', lineHeight: 1 }}>×</button>
            </div>

            <div style={label}>Theme</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {themeList.map(t => (
                <button key={t.name} onClick={() => setTheme(t.name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
                    border: `2px solid ${theme === t.name ? 'var(--buttonPrimary)' : 'var(--border)'}`,
                    background: theme === t.name ? 'var(--surfaceHover)' : 'transparent', color: 'var(--text)', fontSize: 13, fontWeight: theme === t.name ? 700 : 500
                  }}>
                  <span style={{ width: 16, height: 16, borderRadius: '50%', background: t.background, border: '1px solid var(--border)', display: 'inline-block' }} />
                  {t.label || t.name}
                </button>
              ))}
            </div>

            <div style={label}>Background image URL</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={input} placeholder="https://… (link to an image)" value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setBgUrl(urlDraft.trim()) }} />
              <button onClick={() => setBgUrl(urlDraft.trim())}
                style={{ padding: '8px 12px', borderRadius: 6, border: 'none', background: 'var(--buttonPrimary)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
            </div>
            {bgUrl && (
              <button onClick={() => { setBgUrl(''); setUrlDraft('') }}
                style={{ marginTop: 8, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--textSecondary)', fontSize: 12, cursor: 'pointer' }}>Remove background</button>
            )}

            <div style={label}>Fade — {Math.round(bgOpacity * 100)}%</div>
            <input type="range" min="0" max="1" step="0.01" value={bgOpacity} onChange={e => setBgOpacity(parseFloat(e.target.value))} style={{ width: '100%' }} disabled={!bgUrl} />

            <div style={label}>Blur — {bgBlur}px</div>
            <input type="range" min="0" max="12" step="1" value={bgBlur} onChange={e => setBgBlur(parseInt(e.target.value))} style={{ width: '100%' }} disabled={!bgUrl} />

            <div style={label}>Tint</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {TINTS.map(t => (
                <button key={t.value} onClick={() => setBgTint(t.value)} disabled={!bgUrl}
                  style={{
                    flex: 1, padding: '7px', borderRadius: 8, cursor: bgUrl ? 'pointer' : 'default',
                    border: `2px solid ${bgTint === t.value ? 'var(--buttonPrimary)' : 'var(--border)'}`,
                    background: bgTint === t.value ? 'var(--surfaceHover)' : 'transparent', color: 'var(--text)', fontSize: 13, opacity: bgUrl ? 1 : 0.5
                  }}>{t.label}</button>
              ))}
            </div>

            <p style={{ fontSize: 11, color: 'var(--textSecondary)', marginTop: 16, marginBottom: 0, lineHeight: 1.5 }}>
              Tip: paste a link to any image (right-click an image on the web → Copy Image Address). Lower the fade so it sits softly behind your data.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
