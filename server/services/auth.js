import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Use the same database connection - import the shared database
let db
try {
  // Try to import the shared database connection
  const { getDatabase } = await import('./database.js')
  db = getDatabase()
  console.log('✓ Using shared database connection')
} catch (error) {
  // Fallback to creating own connection if import fails
  console.log('⚠ Creating separate database connection for auth')
  const dbPath = process.env.DATABASE_PATH || join(__dirname, '..', 'trading_data.db')
  db = new Database(dbPath)
}

const SALT_ROUNDS = 10
const SESSION_DURATION_DAYS = 30 // 30 days

export class AuthService {
  // Create a new user
  async createUser(username, password, email = null) {
    try {
      console.log('📝 Creating user:', { username, emailProvided: !!email })

      // Validate input
      if (!username || username.length < 3) {
        throw new Error('Username must be at least 3 characters')
      }
      if (!password || password.length < 6) {
        throw new Error('Password must be at least 6 characters')
      }

      console.log('✓ Input validation passed')

      // Check if username already exists
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
      if (existing) {
        throw new Error('Username already exists')
      }

      console.log('✓ Username is available')

      // Hash password
      console.log('🔐 Hashing password...')
      const password_hash = await bcrypt.hash(password, SALT_ROUNDS)
      console.log('✓ Password hashed successfully')

      // Insert user
      console.log('💾 Inserting user into database...')
      const stmt = db.prepare(`
        INSERT INTO users (username, password_hash, email)
        VALUES (?, ?, ?)
      `)
      const result = stmt.run(username, password_hash, email || null)

      console.log(`✅ Created user: ${username} (ID: ${result.lastInsertRowid})`)
      return {
        id: result.lastInsertRowid,
        username,
        email
      }
    } catch (error) {
      console.error('❌ Error creating user:', error.message)
      console.error('Stack:', error.stack)
      throw error
    }
  }

  // Login user and create session
  async login(username, password) {
    try {
      // Get user
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
      if (!user) {
        throw new Error('Invalid username or password')
      }

      // Verify password
      const valid = await bcrypt.compare(password, user.password_hash)
      if (!valid) {
        throw new Error('Invalid username or password')
      }

      // Create session token
      const sessionToken = crypto.randomBytes(32).toString('hex')
      const expiresAt = Math.floor(Date.now() / 1000) + (SESSION_DURATION_DAYS * 24 * 60 * 60)

      // Save session
      const stmt = db.prepare(`
        INSERT INTO sessions (user_id, session_token, expires_at)
        VALUES (?, ?, ?)
      `)
      stmt.run(user.id, sessionToken, expiresAt)

      // Update last login
      db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), user.id)

      console.log(`✅ User logged in: ${username}`)
      return {
        sessionToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email
        }
      }
    } catch (error) {
      console.error('Error during login:', error)
      throw error
    }
  }

  // Logout user (delete session)
  logout(sessionToken) {
    try {
      const stmt = db.prepare('DELETE FROM sessions WHERE session_token = ?')
      const result = stmt.run(sessionToken)
      console.log(`✅ User logged out (deleted ${result.changes} session(s))`)
      return result.changes > 0
    } catch (error) {
      console.error('Error during logout:', error)
      throw error
    }
  }

  // Verify session and get user
  verifySession(sessionToken) {
    try {
      if (!sessionToken) {
        return null
      }

      const stmt = db.prepare(`
        SELECT s.*, u.username, u.email
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.session_token = ? AND s.expires_at > ?
      `)
      const now = Math.floor(Date.now() / 1000)
      const session = stmt.get(sessionToken, now)

      if (!session) {
        return null
      }

      return {
        userId: session.user_id,
        username: session.username,
        email: session.email
      }
    } catch (error) {
      console.error('Error verifying session:', error)
      return null
    }
  }

  // Clean up expired sessions
  cleanupExpiredSessions() {
    try {
      const now = Math.floor(Date.now() / 1000)
      const stmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
      const result = stmt.run(now)
      if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} expired session(s)`)
      }
      return result.changes
    } catch (error) {
      console.error('Error cleaning up sessions:', error)
      return 0
    }
  }

  // Get all users (admin only - for debugging)
  getAllUsers() {
    try {
      const stmt = db.prepare('SELECT id, username, email, created_at, last_login FROM users ORDER BY id')
      return stmt.all()
    } catch (error) {
      console.error('Error getting all users:', error)
      return []
    }
  }
}

export const authService = new AuthService()

// Clean up expired sessions on startup and every hour
authService.cleanupExpiredSessions()
setInterval(() => authService.cleanupExpiredSessions(), 60 * 60 * 1000)
