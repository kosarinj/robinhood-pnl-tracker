import { createContext, useContext, useState, useEffect } from 'react'

const SettingsContext = createContext()

const LS = {
  bgUrl: 'pnl-bg_url',
  bgOpacity: 'pnl-bg_opacity',
  bgTint: 'pnl-bg_tint',
  bgBlur: 'pnl-bg_blur'
}

export function SettingsProvider({ children }) {
  const [bgUrl, setBgUrl] = useState(() => localStorage.getItem(LS.bgUrl) || '')
  const [bgOpacity, setBgOpacity] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS.bgOpacity))
    return isNaN(v) ? 0.25 : v
  })
  const [bgTint, setBgTint] = useState(() => localStorage.getItem(LS.bgTint) || 'none')
  const [bgBlur, setBgBlur] = useState(() => {
    const v = parseInt(localStorage.getItem(LS.bgBlur)); return isNaN(v) ? 0 : v
  })

  useEffect(() => { localStorage.setItem(LS.bgUrl, bgUrl) }, [bgUrl])
  useEffect(() => { localStorage.setItem(LS.bgOpacity, String(bgOpacity)) }, [bgOpacity])
  useEffect(() => { localStorage.setItem(LS.bgTint, bgTint) }, [bgTint])
  useEffect(() => { localStorage.setItem(LS.bgBlur, String(bgBlur)) }, [bgBlur])

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
