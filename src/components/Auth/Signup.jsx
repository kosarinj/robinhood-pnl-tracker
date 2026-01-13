import React, { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useTheme } from '../../contexts/ThemeContext'

function Signup({ onSwitchToLogin }) {
  const { signup } = useAuth()
  const { isDark } = useTheme()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      setLoading(false)
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      setLoading(false)
      return
    }

    // Send null instead of empty string for email if not provided
    const emailValue = email.trim() === '' ? null : email.trim()
    const result = await signup(username, password, emailValue)

    if (!result.success) {
      setError(result.error)
      setLoading(false)
    }
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
          Create Account
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
              minLength={3}
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
              Email (optional)
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
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
              minLength={6}
              autoComplete="new-password"
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
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
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
            {loading ? 'Creating account...' : 'Sign Up'}
          </button>

          <div style={{
            textAlign: 'center',
            fontSize: '14px',
            color: isDark ? '#b0b0b0' : '#666'
          }}>
            Already have an account?{' '}
            <button
              type="button"
              onClick={onSwitchToLogin}
              style={{
                background: 'none',
                border: 'none',
                color: '#667eea',
                cursor: 'pointer',
                fontWeight: '600',
                textDecoration: 'underline'
              }}
            >
              Log in
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default Signup
