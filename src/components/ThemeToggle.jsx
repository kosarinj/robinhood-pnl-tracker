import { useTheme } from '../contexts/ThemeContext'

export default function ThemeToggle() {
  const { theme, toggleTheme, isDark } = useTheme()

  return (
    <button
      onClick={toggleTheme}
      style={{
        position: 'fixed',
        top: '20px',
        right: '20px',
        background: 'var(--surface)',
        border: `2px solid var(--border)`,
        borderRadius: '50%',
        width: '48px',
        height: '48px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '24px',
        transition: 'all 0.3s ease',
        boxShadow: `0 2px 8px var(--shadow)`,
        zIndex: 1000
      }}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.1)'
        e.currentTarget.style.boxShadow = `0 4px 12px var(--shadow)`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)'
        e.currentTarget.style.boxShadow = `0 2px 8px var(--shadow)`
      }}
    >
      {isDark ? '☀️' : '🌙'}
    </button>
  )
}
