import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Initialize database
const dbPath = process.env.DATABASE_PATH || join(__dirname, '..', 'trading_data.db')
const db = new Database(dbPath)

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL')

// Create tables
db.exec(`
  -- Table to store signal snapshots
  CREATE TABLE IF NOT EXISTS signal_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    signal TEXT NOT NULL,
    strength REAL,
    strength_label TEXT,
    price REAL,
    ema9 REAL,
    ema21 REAL,
    rsi REAL,
    trend TEXT,
    volume INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store price snapshots
  CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    price REAL NOT NULL,
    volume INTEGER,
    change_percent REAL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store signal performance tracking
  CREATE TABLE IF NOT EXISTS signal_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    signal_timestamp INTEGER NOT NULL,
    signal_type TEXT NOT NULL,
    signal_price REAL NOT NULL,
    check_timestamp INTEGER NOT NULL,
    check_price REAL NOT NULL,
    time_elapsed_minutes INTEGER NOT NULL,
    price_change_percent REAL NOT NULL,
    was_correct INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store P&L snapshots
  CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asof_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    position REAL NOT NULL,
    avg_cost REAL,
    current_price REAL,
    current_value REAL,
    realized_pnl REAL,
    unrealized_pnl REAL,
    total_pnl REAL,
    daily_pnl REAL,
    options_pnl REAL,
    percentage REAL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(asof_date, symbol)
  );

  -- Indexes for faster queries
  CREATE INDEX IF NOT EXISTS idx_signal_snapshots_symbol_timestamp
    ON signal_snapshots(symbol, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_price_snapshots_symbol_timestamp
    ON price_snapshots(symbol, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_signal_performance_symbol
    ON signal_performance(symbol, signal_timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_asof_date
    ON pnl_snapshots(asof_date DESC, symbol);
`)

console.log(`Database initialized at: ${dbPath}`)

// Prepared statements for better performance
const insertSignalSnapshot = db.prepare(`
  INSERT INTO signal_snapshots (symbol, timestamp, signal, strength, strength_label, price, ema9, ema21, rsi, trend, volume)
  VALUES (@symbol, @timestamp, @signal, @strength, @strengthLabel, @price, @ema9, @ema21, @rsi, @trend, @volume)
`)

const insertPriceSnapshot = db.prepare(`
  INSERT INTO price_snapshots (symbol, timestamp, price, volume, change_percent)
  VALUES (@symbol, @timestamp, @price, @volume, @changePercent)
`)

const insertSignalPerformance = db.prepare(`
  INSERT INTO signal_performance (symbol, signal_timestamp, signal_type, signal_price, check_timestamp, check_price, time_elapsed_minutes, price_change_percent, was_correct)
  VALUES (@symbol, @signalTimestamp, @signalType, @signalPrice, @checkTimestamp, @checkPrice, @timeElapsedMinutes, @priceChangePercent, @wasCorrect)
`)

const upsertPnLSnapshot = db.prepare(`
  INSERT INTO pnl_snapshots (asof_date, symbol, position, avg_cost, current_price, current_value, realized_pnl, unrealized_pnl, total_pnl, daily_pnl, options_pnl, percentage)
  VALUES (@asofDate, @symbol, @position, @avgCost, @currentPrice, @currentValue, @realizedPnl, @unrealizedPnl, @totalPnl, @dailyPnl, @optionsPnl, @percentage)
  ON CONFLICT(asof_date, symbol) DO UPDATE SET
    position = excluded.position,
    avg_cost = excluded.avg_cost,
    current_price = excluded.current_price,
    current_value = excluded.current_value,
    realized_pnl = excluded.realized_pnl,
    unrealized_pnl = excluded.unrealized_pnl,
    total_pnl = excluded.total_pnl,
    daily_pnl = excluded.daily_pnl,
    options_pnl = excluded.options_pnl,
    percentage = excluded.percentage,
    created_at = strftime('%s', 'now')
`)

export class DatabaseService {
  // Record a signal snapshot
  recordSignal(signal) {
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      insertSignalSnapshot.run({
        symbol: signal.symbol,
        timestamp,
        signal: signal.signal,
        strength: signal.strength || null,
        strengthLabel: signal.strengthLabel || null,
        price: signal.currentPrice || null,
        ema9: signal.ema9 || null,
        ema21: signal.ema21 || null,
        rsi: signal.rsi || null,
        trend: signal.trend || null,
        volume: signal.volume || null
      })
    } catch (error) {
      console.error('Error recording signal:', error)
    }
  }

  // Record multiple signals in a transaction
  recordSignals(signals) {
    const recordMany = db.transaction((signals) => {
      for (const signal of signals) {
        this.recordSignal(signal)
      }
    })
    recordMany(signals)
  }

  // Record a price snapshot
  recordPrice(symbol, price, volume = null, changePercent = null) {
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      insertPriceSnapshot.run({
        symbol,
        timestamp,
        price,
        volume,
        changePercent
      })
    } catch (error) {
      console.error('Error recording price:', error)
    }
  }

  // Record multiple prices in a transaction
  recordPrices(priceData) {
    const recordMany = db.transaction((priceData) => {
      for (const [symbol, data] of Object.entries(priceData)) {
        this.recordPrice(
          symbol,
          data.price || data,
          data.volume || null,
          data.changePercent || null
        )
      }
    })
    recordMany(priceData)
  }

  // Analyze signal performance
  analyzeSignalPerformance() {
    try {
      // Get all signals from the last 24 hours
      const signals = db.prepare(`
        SELECT * FROM signal_snapshots
        WHERE timestamp > strftime('%s', 'now', '-24 hours')
        ORDER BY timestamp DESC
      `).all()

      const performance = []

      for (const signal of signals) {
        // Get price movements after the signal
        const laterPrices = db.prepare(`
          SELECT timestamp, price
          FROM price_snapshots
          WHERE symbol = ? AND timestamp > ?
          ORDER BY timestamp ASC
          LIMIT 50
        `).all(signal.symbol, signal.timestamp)

        // Check performance at 15min, 30min, 1hr, 4hr intervals
        const intervals = [15, 30, 60, 240] // minutes

        for (const minutes of intervals) {
          const targetTimestamp = signal.timestamp + (minutes * 60)
          const closestPrice = laterPrices.find(p => p.timestamp >= targetTimestamp)

          if (closestPrice && signal.price) {
            const priceChange = ((closestPrice.price - signal.price) / signal.price) * 100
            const timeElapsed = Math.floor((closestPrice.timestamp - signal.timestamp) / 60)

            // Determine if signal was correct
            let wasCorrect = 0
            if (signal.signal === 'BUY' && priceChange > 0) wasCorrect = 1
            if (signal.signal === 'SELL' && priceChange < 0) wasCorrect = 1

            insertSignalPerformance.run({
              symbol: signal.symbol,
              signalTimestamp: signal.timestamp,
              signalType: signal.signal,
              signalPrice: signal.price,
              checkTimestamp: closestPrice.timestamp,
              checkPrice: closestPrice.price,
              timeElapsedMinutes: timeElapsed,
              priceChangePercent: priceChange,
              wasCorrect
            })

            performance.push({
              symbol: signal.symbol,
              signal: signal.signal,
              interval: minutes,
              priceChange,
              wasCorrect: wasCorrect === 1
            })
          }
        }
      }

      return performance
    } catch (error) {
      console.error('Error analyzing signal performance:', error)
      return []
    }
  }

  // Get signal accuracy statistics
  getSignalAccuracy(symbol = null, timeRangeHours = 168) { // Default 7 days
    try {
      const query = symbol
        ? db.prepare(`
            SELECT
              signal_type,
              time_elapsed_minutes,
              COUNT(*) as total,
              SUM(was_correct) as correct,
              AVG(price_change_percent) as avg_change,
              MIN(price_change_percent) as min_change,
              MAX(price_change_percent) as max_change
            FROM signal_performance
            WHERE symbol = ? AND created_at > strftime('%s', 'now', '-${timeRangeHours} hours')
            GROUP BY signal_type, time_elapsed_minutes
            ORDER BY signal_type, time_elapsed_minutes
          `)
        : db.prepare(`
            SELECT
              signal_type,
              time_elapsed_minutes,
              COUNT(*) as total,
              SUM(was_correct) as correct,
              AVG(price_change_percent) as avg_change,
              MIN(price_change_percent) as min_change,
              MAX(price_change_percent) as max_change
            FROM signal_performance
            WHERE created_at > strftime('%s', 'now', '-${timeRangeHours} hours')
            GROUP BY signal_type, time_elapsed_minutes
            ORDER BY signal_type, time_elapsed_minutes
          `)

      const results = symbol ? query.all(symbol) : query.all()

      return results.map(r => ({
        signalType: r.signal_type,
        interval: r.time_elapsed_minutes,
        total: r.total,
        correct: r.correct,
        accuracy: r.total > 0 ? (r.correct / r.total * 100).toFixed(2) : 0,
        avgChange: r.avg_change?.toFixed(2),
        minChange: r.min_change?.toFixed(2),
        maxChange: r.max_change?.toFixed(2)
      }))
    } catch (error) {
      console.error('Error getting signal accuracy:', error)
      return []
    }
  }

  // Get recent signals for a symbol
  getRecentSignals(symbol, limit = 50) {
    try {
      return db.prepare(`
        SELECT * FROM signal_snapshots
        WHERE symbol = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(symbol, limit)
    } catch (error) {
      console.error('Error getting recent signals:', error)
      return []
    }
  }

  // Get recent prices for a symbol
  getRecentPrices(symbol, limit = 288) { // 24 hours at 5min intervals
    try {
      return db.prepare(`
        SELECT * FROM price_snapshots
        WHERE symbol = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(symbol, limit)
    } catch (error) {
      console.error('Error getting recent prices:', error)
      return []
    }
  }

  // Clean up old data (keep last 30 days)
  cleanup() {
    try {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)

      db.prepare('DELETE FROM signal_snapshots WHERE timestamp < ?').run(thirtyDaysAgo)
      db.prepare('DELETE FROM price_snapshots WHERE timestamp < ?').run(thirtyDaysAgo)
      db.prepare('DELETE FROM signal_performance WHERE created_at < ?').run(thirtyDaysAgo)

      db.prepare('VACUUM').run()

      console.log('Database cleanup completed')
    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  }

  // Save P&L snapshot for a specific date
  savePnLSnapshot(asofDate, pnlData) {
    try {
      const saveSnapshot = db.transaction((asofDate, pnlData) => {
        for (const item of pnlData) {
          upsertPnLSnapshot.run({
            asofDate,
            symbol: item.symbol,
            position: item.real?.position || 0,
            avgCost: item.real?.avgCostBasis || null,
            currentPrice: item.currentPrice || null,
            currentValue: item.real?.currentValue || null,
            realizedPnl: item.real?.realized || null,
            unrealizedPnl: item.real?.unrealized || null,
            totalPnl: item.real?.total || null,
            dailyPnl: item.real?.dailyPnL || null,
            optionsPnl: item.real?.optionsPnL || null,
            percentage: item.real?.percentage || null
          })
        }
      })
      saveSnapshot(asofDate, pnlData)
      console.log(`✅ Saved P&L snapshot for ${asofDate}: ${pnlData.length} symbols`)
    } catch (error) {
      console.error('Error saving P&L snapshot:', error)
      throw error
    }
  }

  // Get P&L snapshot for a specific date
  getPnLSnapshot(asofDate) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM pnl_snapshots
        WHERE asof_date = ?
        ORDER BY symbol
      `)
      return stmt.all(asofDate)
    } catch (error) {
      console.error('Error getting P&L snapshot:', error)
      return []
    }
  }

  // Get all available snapshot dates
  getSnapshotDates() {
    try {
      const stmt = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        ORDER BY asof_date DESC
      `)
      return stmt.all().map(row => row.asof_date)
    } catch (error) {
      console.error('Error getting snapshot dates:', error)
      return []
    }
  }

  // Close database connection
  close() {
    db.close()
  }
}

export const databaseService = new DatabaseService()
