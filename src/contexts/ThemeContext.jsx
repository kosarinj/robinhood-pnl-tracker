import { createContext, useContext, useState, useEffect } from 'react'
import { themes, applyTheme } from '../styles/themes'

const ThemeContext = createContext()

export function ThemeProvider({ children }) {
  const [currentTheme, setCurrentTheme] = useState(() => {
    // Load theme from localStorage or default to light
    const saved = localStorage.getItem('pnl-theme')
    return saved || 'light'
  })

  useEffect(() => {
    // Apply theme when it changes
    applyTheme(themes[currentTheme])
    localStorage.setItem('pnl-theme', currentTheme)
  }, [currentTheme])

  // Kept for callers that just want to flip. With more than two themes it steps
  // between this theme's light and dark counterpart rather than snapping back to
  // the stock pair, so switching brightness doesn't silently change your theme.
  const toggleTheme = () => {
    setCurrentTheme(prev => {
      const cur = themes[prev]
      if (!cur) return 'light'
      const want = !cur.dark
      const partner = Object.values(themes).find(t =>
        t.dark === want && (t.name.startsWith(prev.replace(/Dark$/, '')) || prev.startsWith(t.name.replace(/Dark$/, '')))
      )
      return partner ? partner.name : (cur.dark ? 'light' : 'dark')
    })
  }

  const setTheme = (themeName) => {
    if (themes[themeName]) {
      setCurrentTheme(themeName)
    }
  }

  return (
    <ThemeContext.Provider value={{
      theme: currentTheme,
      themes,
      toggleTheme,
      setTheme,
      isDark: themes[currentTheme]?.dark ?? (currentTheme === 'dark'),
      // The resolved token values. Prefer `var(--token)` in styles — it follows
      // a theme switch without a re-render. Use this only where a real JS value
      // is needed, e.g. passing colours to Recharts or building an rgba().
      tokens: themes[currentTheme] || themes.light
    }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
