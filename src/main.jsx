import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/ThemeContext'
import { SettingsProvider } from './contexts/SettingsContext'
import { AuthProvider } from './contexts/AuthContext'
import BackgroundLayer from './components/BackgroundLayer'
import './index.css'
import { startAutoUpdate } from './autoUpdate'

// Reload automatically when a newer build is deployed (esp. for the iOS Home Screen app)
startAutoUpdate()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <SettingsProvider>
        <AuthProvider>
          <BackgroundLayer />
          <App />
        </AuthProvider>
      </SettingsProvider>
    </ThemeProvider>
  </React.StrictMode>
)
