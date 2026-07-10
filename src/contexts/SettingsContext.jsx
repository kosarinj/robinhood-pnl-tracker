import { createContext, useContext, useState, useEffect, useRef } from 'react'

const SettingsContext = createContext()

const LS = {
  bgUrl: 'pnl-bg_url',
  bgOpacity: 'pnl-bg_opacity',
  bgTint: 'pnl-bg_tint',
  bgBlur: 'pnl-bg_blur'
}

// Persist one setting to the server so it syncs to every device.
function putSetting(key, value) {
  fetch('/api/app-settings', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value })
  }).catch(() => {})
}

export function SettingsProvider({ children }) {
  const [bgUrl, setBgUrl] = useState(() => localStorage.getItem(LS.bgUrl) || '')
  const [bgOpacity, setBgOpacity] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS.bgOpacity)); return isNaN(v) ? 0.25 : v
  })
  const [bgTint, setBgTint] = useState(() => localStorage.getItem(LS.bgTint) || 'none')
  const [bgBlur, setBgBlur] = useState(() => {
    const v = parseInt(localStorage.getItem(LS.bgBlur)); return isNaN(v) ? 0 : v
  })

  // Server is the source of truth (syncs across devices). Load once on mount; only start
  // writing back to the server AFTER that, so we never overwrite server values with local defaults.
  const hydrated = useRef(false)
  useEffect(() => {
    fetch('/api/app-settings', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const s = d?.settings || {}
        if (s.bg_url !== undefined) setBgUrl(s.bg_url || '')
        if (s.bg_opacity != null) setBgOpacity(parseFloat(s.bg_opacity))
        if (s.bg_tint !== undefined) setBgTint(s.bg_tint || 'none')
        if (s.bg_blur != null) setBgBlur(parseInt(s.bg_blur))
      })
      .catch(() => {})
      .finally(() => { hydrated.current = true })
  }, [])

  useEffect(() => { localStorage.setItem(LS.bgUrl, bgUrl); if (hydrated.current) putSetting('bg_url', bgUrl) }, [bgUrl])
  useEffect(() => { localStorage.setItem(LS.bgOpacity, String(bgOpacity)); if (hydrated.current) putSetting('bg_opacity', bgOpacity) }, [bgOpacity])
  useEffect(() => { localStorage.setItem(LS.bgTint, bgTint); if (hydrated.current) putSetting('bg_tint', bgTint) }, [bgTint])
  useEffect(() => { localStorage.setItem(LS.bgBlur, String(bgBlur)); if (hydrated.current) putSetting('bg_blur', bgBlur) }, [bgBlur])

  return (
    <SettingsContext.Provider value={{
      bgUrl, setBgUrl,
      bgOpacity, setBgOpacity,
      bgTint, setBgTint,
      bgBlur, setBgBlur
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}
