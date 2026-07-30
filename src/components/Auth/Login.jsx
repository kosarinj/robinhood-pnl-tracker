import React, { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useTheme } from '../../contexts/ThemeContext'

function Login({ onSwitchToSignup }) {
  const { login } = useAuth()
  const { isDark } = useTheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Admin password reset (gated by the ADMIN_RESET_KEY set in the server env).
  const [showReset, setShowReset] = useState(false)
  const [resetUsername, setResetUsername] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [resetKey, setResetKey] = useState('')
  const [resetMsg, setResetMsg] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const result = await login(username, password)

    if (!result.success) {
      setError(result.error)
      setLoading(false)
    }
  }

  const handleReset = async (e) => {
    e.preventDefault()
    setResetMsg(null)
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: resetUsername, newPassword: resetPassword, resetKey })
      })
      const d = await r.json()
      setResetMsg(d.success
        ? { ok: true, text: 'Password reset. Log in with your new password above.' }
        : { ok: false, text: d.error || 'Reset failed' })
    } catch (err) {
      setResetMsg({ ok: false, text: err.message })
    }
  }

  const resetInput = {
    width: '100%', padding: '10px', borderRadius: '8px', marginBottom: '8px',
    border: isDark ? '1px solid #444' : '1px solid #ddd',
    background: isDark ? '#1e1e1e' : 'white', color: isDark ? '#e0e0e0' : '#333',
    fontSize: '14px', boxSizing: 'border-box'
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: isDark
        ? 'linear-gradient(135deg, #1e1e2e 0%, #2a2a3e 100%)'
        : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: '20px'
    }}>
      <div style={{
        background: isDark ? '#2a2a2a' : 'white',
        borderRadius: '16px',
        padding: '40px',
        maxWidth: '400px',
        width: '100%',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)'
      }}>
        <h1 style={{
          margin: '0 0 30px 0',
          fontSize: '32px',
          fontWeight: '700',
          color: isDark ? '#e0e0e0' : '#333',
          textAlign: 'center'
        }}>
          Welcome Back
        </h1>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: '500',
              color: isDark ? '#b0b0b0' : '#666'
            }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                border: isDark ? '1px solid #444' : '1px solid #ddd',
                background: isDark ? '#1e1e1e' : 'white',
                color: isDark ? '#e0e0e0' : '#333',
                fontSize: '16px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: '500',
              color: isDark ? '#b0b0b0' : '#666'
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                border: isDark ? '1px solid #444' : '1px solid #ddd',
                background: isDark ? '#1e1e1e' : 'white',
                color: isDark ? '#e0e0e0' : '#333',
                fontSize: '16px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: '12px',
              marginBottom: '20px',
              background: '#f8d7da',
              color: '#721c24',
              borderRadius: '8px',
              fontSize: '14px'
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              background: loading ? '#999' : '#667eea',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: '600',
              cursor: loading ? 'not-allowed' : 'pointer',
              marginBottom: '16px'
            }}
          >
            {loading ? 'Logging in...' : 'Log In'}
          </button>

          <div style={{
            textAlign: 'center',
            fontSize: '14px',
            color: isDark ? '#b0b0b0' : '#666'
          }}>
            Don't have an account?{' '}
            <button
              type="button"
              onClick={onSwitchToSignup}
              style={{
                background: 'none',
                border: 'none',
                color: '#667eea',
                cursor: 'pointer',
                fontWeight: '600',
                textDecoration: 'underline'
              }}
            >
              Sign up
            </button>
          </div>
        </form>

        <div style={{ textAlign: 'center', marginTop: '14px' }}>
          <button
            type="button"
            onClick={() => { setShowReset(v => !v); setResetMsg(null) }}
            style={{ background: 'none', border: 'none', color: isDark ? '#8a8a9a' : '#94a3b8', cursor: 'pointer', fontSize: '13px', textDecoration: 'underline' }}
          >
            {showReset ? 'Cancel reset' : 'Reset password'}
          </button>
        </div>

        {showReset && (
          <form onSubmit={handleReset} style={{ marginTop: '10px', paddingTop: '14px', borderTop: isDark ? '1px solid #444' : '1px solid #eee' }}>
            <div style={{ fontSize: '12px', color: isDark ? '#b0b0b0' : '#666', marginBottom: '10px' }}>
              Resets a password using the server's <strong>ADMIN_RESET_KEY</strong> (set it in your Railway environment variables first).
            </div>
            <input style={resetInput} type="text" placeholder="Username" value={resetUsername} onChange={e => setResetUsername(e.target.value)} autoComplete="off" />
            <input style={resetInput} type="password" placeholder="New password (min 6 chars)" value={resetPassword} onChange={e => setResetPassword(e.target.value)} autoComplete="new-password" />
            <input style={resetInput} type="password" placeholder="Admin reset key" value={resetKey} onChange={e => setResetKey(e.target.value)} autoComplete="off" />
            {resetMsg && (
              <div style={{ padding: '10px', marginBottom: '8px', borderRadius: '8px', fontSize: '13px', background: resetMsg.ok ? '#d1e7dd' : '#f8d7da', color: resetMsg.ok ? '#0f5132' : '#721c24' }}>
                {resetMsg.text}
              </div>
            )}
            <button type="submit" style={{ width: '100%', padding: '12px', background: '#64748b', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>
              Reset Password
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export default Login
