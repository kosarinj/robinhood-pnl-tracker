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

  const toggleTheme = () => {
    setCurrentTheme(prev => prev === 'light' ? 'dark' : 'light')
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
      isDark: currentTheme === 'dark'
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
