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
    lowest_open_buy_price REAL,
    lowest_open_buy_days_ago INTEGER,
    recent_lowest_buy_price REAL,
    recent_lowest_buy_days_ago INTEGER,
    recent_lowest_sell_price REAL,
    recent_lowest_sell_days_ago INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(asof_date, symbol)
  );

  -- Table to store raw trades from CSV
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_date TEXT NOT NULL,
    trans_date TEXT NOT NULL,
    trans_code TEXT,
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    is_buy INTEGER NOT NULL,
    is_option INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store CSV upload metadata
  CREATE TABLE IF NOT EXISTS csv_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_date TEXT NOT NULL UNIQUE,
    latest_trade_date TEXT NOT NULL,
    trade_count INTEGER NOT NULL,
    total_principal REAL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store deposits (ACH deposits from CSV)
  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_date TEXT NOT NULL,
    deposit_date TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store P&L benchmarks at specific price levels
  CREATE TABLE IF NOT EXISTS price_benchmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    price_level REAL NOT NULL,
    total_pnl REAL NOT NULL,
    position REAL NOT NULL,
    avg_cost REAL,
    realized_pnl REAL,
    unrealized_pnl REAL,
    asof_date TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
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

  CREATE INDEX IF NOT EXISTS idx_trades_upload_date
    ON trades(upload_date DESC, trans_date DESC);

  CREATE INDEX IF NOT EXISTS idx_trades_symbol
    ON trades(symbol, trans_date DESC);

  CREATE INDEX IF NOT EXISTS idx_csv_uploads_date
    ON csv_uploads(upload_date DESC);

  CREATE INDEX IF NOT EXISTS idx_price_benchmarks_symbol_price
    ON price_benchmarks(symbol, price_level, timestamp DESC);
`)

console.log(`Database initialized at: ${dbPath}`)

// Migration: Add is_option column to trades table if it doesn't exist
try {
  const tableInfo = db.pragma('table_info(trades)')
  const hasIsOption = tableInfo.some(col => col.name === 'is_option')

  if (!hasIsOption) {
    console.log('Adding is_option column to trades table...')
    db.exec('ALTER TABLE trades ADD COLUMN is_option INTEGER DEFAULT 0')

    // Update existing trades to set is_option based on description
    db.exec(`
      UPDATE trades
      SET is_option = 1
      WHERE description LIKE '%Call%' OR description LIKE '%Put%'
    `)
    console.log('✅ Added is_option column and updated existing trades')
  }
} catch (error) {
  console.error('Migration error:', error)
}

// Migration: Add lowest_open_buy_price and lowest_open_buy_days_ago columns to pnl_snapshots
try {
  const tableInfo = db.pragma('table_info(pnl_snapshots)')
  const hasLowestBuyPrice = tableInfo.some(col => col.name === 'lowest_open_buy_price')
  const hasLowestBuyDays = tableInfo.some(col => col.name === 'lowest_open_buy_days_ago')

  if (!hasLowestBuyPrice) {
    console.log('Adding lowest_open_buy_price column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN lowest_open_buy_price REAL')
    console.log('✅ Added lowest_open_buy_price column')
  }

  if (!hasLowestBuyDays) {
    console.log('Adding lowest_open_buy_days_ago column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN lowest_open_buy_days_ago INTEGER')
    console.log('✅ Added lowest_open_buy_days_ago column')
  }
} catch (error) {
  console.error('Migration error:', error)
}

// Migration: Add recent_lowest_buy_price and recent_lowest_buy_days_ago columns to pnl_snapshots
try {
  const tableInfo = db.pragma('table_info(pnl_snapshots)')
  const hasRecentBuyPrice = tableInfo.some(col => col.name === 'recent_lowest_buy_price')
  const hasRecentBuyDays = tableInfo.some(col => col.name === 'recent_lowest_buy_days_ago')

  if (!hasRecentBuyPrice) {
    console.log('Adding recent_lowest_buy_price column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN recent_lowest_buy_price REAL')
    console.log('✅ Added recent_lowest_buy_price column')
  }

  if (!hasRecentBuyDays) {
    console.log('Adding recent_lowest_buy_days_ago column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN recent_lowest_buy_days_ago INTEGER')
    console.log('✅ Added recent_lowest_buy_days_ago column')
  }
} catch (error) {
  console.error('Migration error:', error)
}

// Migration: Add recent_lowest_sell_price and recent_lowest_sell_days_ago columns to pnl_snapshots
try {
  const tableInfo = db.pragma('table_info(pnl_snapshots)')
  const hasRecentSellPrice = tableInfo.some(col => col.name === 'recent_lowest_sell_price')
  const hasRecentSellDays = tableInfo.some(col => col.name === 'recent_lowest_sell_days_ago')

  if (!hasRecentSellPrice) {
    console.log('Adding recent_lowest_sell_price column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN recent_lowest_sell_price REAL')
    console.log('✅ Added recent_lowest_sell_price column')
  }

  if (!hasRecentSellDays) {
    console.log('Adding recent_lowest_sell_days_ago column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN recent_lowest_sell_days_ago INTEGER')
    console.log('✅ Added recent_lowest_sell_days_ago column')
  }
} catch (error) {
  console.error('Migration error:', error)
}

// Migration: Add total_principal column to csv_uploads table if it doesn't exist
try {
  const csvUploadsInfo = db.pragma('table_info(csv_uploads)')
  const hasTotalPrincipal = csvUploadsInfo.some(col => col.name === 'total_principal')

  if (!hasTotalPrincipal) {
    console.log('Adding total_principal column to csv_uploads table...')
    db.exec('ALTER TABLE csv_uploads ADD COLUMN total_principal REAL DEFAULT 0')
    console.log('✅ Added total_principal column to csv_uploads')
  }
} catch (error) {
  console.error('Migration error:', error)
}

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
  INSERT INTO pnl_snapshots (asof_date, symbol, position, avg_cost, current_price, current_value, realized_pnl, unrealized_pnl, total_pnl, daily_pnl, options_pnl, percentage, lowest_open_buy_price, lowest_open_buy_days_ago, recent_lowest_buy_price, recent_lowest_buy_days_ago, recent_lowest_sell_price, recent_lowest_sell_days_ago)
  VALUES (@asofDate, @symbol, @position, @avgCost, @currentPrice, @currentValue, @realizedPnl, @unrealizedPnl, @totalPnl, @dailyPnl, @optionsPnl, @percentage, @lowestOpenBuyPrice, @lowestOpenBuyDaysAgo, @recentLowestBuyPrice, @recentLowestBuyDaysAgo, @recentLowestSellPrice, @recentLowestSellDaysAgo)
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
    lowest_open_buy_price = excluded.lowest_open_buy_price,
    lowest_open_buy_days_ago = excluded.lowest_open_buy_days_ago,
    recent_lowest_buy_price = excluded.recent_lowest_buy_price,
    recent_lowest_buy_days_ago = excluded.recent_lowest_buy_days_ago,
    recent_lowest_sell_price = excluded.recent_lowest_sell_price,
    recent_lowest_sell_days_ago = excluded.recent_lowest_sell_days_ago,
    created_at = strftime('%s', 'now')
`)

const insertTrade = db.prepare(`
  INSERT INTO trades (upload_date, trans_date, trans_code, symbol, quantity, price, amount, description, is_buy, is_option)
  VALUES (@uploadDate, @transDate, @transCode, @symbol, @quantity, @price, @amount, @description, @isBuy, @isOption)
`)

const upsertCsvUpload = db.prepare(`
  INSERT INTO csv_uploads (upload_date, latest_trade_date, trade_count, total_principal)
  VALUES (@uploadDate, @latestTradeDate, @tradeCount, @totalPrincipal)
  ON CONFLICT(upload_date) DO UPDATE SET
    latest_trade_date = excluded.latest_trade_date,
    trade_count = excluded.trade_count,
    total_principal = excluded.total_principal,
    updated_at = strftime('%s', 'now')
`)

const insertDeposit = db.prepare(`
  INSERT INTO deposits (upload_date, deposit_date, amount, description)
  VALUES (@uploadDate, @depositDate, @amount, @description)
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
            realizedPnl: item.real?.realizedPnL || null,
            unrealizedPnl: item.real?.unrealizedPnL || null,
            totalPnl: item.real?.totalPnL || null,
            dailyPnL: 0, // TODO: Calculate daily change from previous snapshot
            optionsPnl: item.optionsPnL || null,
            percentage: item.real?.percentage || null,
            lowestOpenBuyPrice: item.real?.lowestOpenBuyPrice || null,
            lowestOpenBuyDaysAgo: item.real?.lowestOpenBuyDaysAgo || null,
            recentLowestBuyPrice: item.real?.recentLowestBuyPrice || null,
            recentLowestBuyDaysAgo: item.real?.recentLowestBuyDaysAgo || null,
            recentLowestSellPrice: item.real?.recentLowestSellPrice || null,
            recentLowestSellDaysAgo: item.real?.recentLowestSellDaysAgo || null
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

  // Debug: Get raw snapshot data from database
  getSnapshotsDebugInfo() {
    try {
      const snapshots = db.prepare(`
        SELECT asof_date, symbol, total_pnl, realized_pnl, unrealized_pnl
        FROM pnl_snapshots
        ORDER BY asof_date DESC, symbol
        LIMIT 50
      `).all()

      const dates = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        ORDER BY asof_date DESC
      `).all()

      const count = db.prepare(`
        SELECT COUNT(*) as count
        FROM pnl_snapshots
      `).get()

      return {
        success: true,
        totalCount: count.count,
        uniqueDates: dates.length,
        dates: dates.map(d => d.asof_date),
        sampleSnapshots: snapshots.slice(0, 10),
        allSnapshots: snapshots
      }
    } catch (error) {
      console.error('Error getting snapshots debug info:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  // Get P&L snapshot from approximately N days ago (closest available date)
  getPnLSnapshotFromDaysAgo(daysAgo = 7) {
    try {
      // Calculate target date (N days ago)
      const targetDate = new Date()
      targetDate.setDate(targetDate.getDate() - daysAgo)
      const targetDateStr = targetDate.toISOString().split('T')[0]

      // Find the closest snapshot date to the target (prefer earlier dates)
      const stmt = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        WHERE asof_date <= ?
        ORDER BY asof_date DESC
        LIMIT 1
      `)
      const result = stmt.get(targetDateStr)

      if (!result) {
        console.log(`No snapshot found from ${daysAgo} days ago (target: ${targetDateStr})`)
        return { date: null, data: [] }
      }

      // Get the snapshot data for that date
      const snapshotDate = result.asof_date
      const dataStmt = db.prepare(`
        SELECT * FROM pnl_snapshots
        WHERE asof_date = ?
        ORDER BY symbol
      `)
      const data = dataStmt.all(snapshotDate)

      console.log(`📅 Found snapshot from ${snapshotDate} (${daysAgo} days ago target: ${targetDateStr})`)
      return { date: snapshotDate, data }
    } catch (error) {
      console.error('Error getting snapshot from days ago:', error)
      return { date: null, data: [] }
    }
  }

  // Get daily P&L history for charting (aggregate across all symbols per day)
  getDailyPnLHistory() {
    try {
      const stmt = db.prepare(`
        SELECT
          asof_date,
          SUM(total_pnl + COALESCE(options_pnl, 0)) as total_pnl,
          SUM(realized_pnl) as realized_pnl,
          SUM(unrealized_pnl) as unrealized_pnl,
          SUM(daily_pnl) as daily_pnl,
          SUM(COALESCE(options_pnl, 0)) as options_pnl
        FROM pnl_snapshots
        GROUP BY asof_date
        ORDER BY asof_date ASC
      `)
      return stmt.all()
    } catch (error) {
      console.error('Error getting daily P&L history:', error)
      return []
    }
  }

  // Get daily P&L history for a specific symbol with price
  getSymbolDailyPnL(symbol) {
    try {
      const stmt = db.prepare(`
        SELECT
          asof_date,
          symbol,
          current_price,
          total_pnl + COALESCE(options_pnl, 0) as total_pnl,
          realized_pnl,
          unrealized_pnl,
          daily_pnl,
          COALESCE(options_pnl, 0) as options_pnl,
          position,
          avg_cost
        FROM pnl_snapshots
        WHERE symbol = ?
        ORDER BY asof_date ASC
      `)
      return stmt.all(symbol)
    } catch (error) {
      console.error('Error getting symbol daily P&L:', error)
      return []
    }
  }

  // Get list of all symbols that have snapshot data
  getSymbolsWithSnapshots() {
    try {
      const stmt = db.prepare(`
        SELECT DISTINCT symbol
        FROM pnl_snapshots
        ORDER BY symbol ASC
      `)
      return stmt.all().map(row => row.symbol)
    } catch (error) {
      console.error('Error getting symbols with snapshots:', error)
      return []
    }
  }

  // Save trades from CSV upload
  saveTrades(trades, uploadDate = null, deposits = [], totalPrincipal = 0) {
    try {
      // Use provided upload date or generate from latest trade date
      if (!uploadDate && trades.length > 0) {
        // Find the latest trade date
        const latestTrade = trades.reduce((latest, trade) => {
          const tradeDate = new Date(trade.date || trade.transDate)
          const latestDate = new Date(latest.date || latest.transDate)
          return tradeDate > latestDate ? trade : latest
        })
        uploadDate = new Date(latestTrade.date || latestTrade.transDate).toISOString().split('T')[0]
      }

      // Delete existing trades and deposits for this upload date
      db.prepare('DELETE FROM trades WHERE upload_date = ?').run(uploadDate)
      db.prepare('DELETE FROM deposits WHERE upload_date = ?').run(uploadDate)

      // Save all trades and deposits in a transaction
      const saveData = db.transaction((trades, deposits, uploadDate, totalPrincipal) => {
        for (const trade of trades) {
          const transDate = new Date(trade.date || trade.transDate).toISOString().split('T')[0]
          insertTrade.run({
            uploadDate,
            transDate,
            transCode: trade.transCode || trade.transactionCode || null,
            symbol: trade.symbol,
            quantity: trade.quantity,
            price: trade.price,
            amount: trade.amount,
            description: trade.description || null,
            isBuy: trade.isBuy ? 1 : 0,
            isOption: trade.isOption ? 1 : 0
          })
        }

        // Save deposits
        for (const deposit of deposits) {
          const depositDate = new Date(deposit.date).toISOString().split('T')[0]
          insertDeposit.run({
            uploadDate,
            depositDate,
            amount: deposit.amount,
            description: deposit.description || null
          })
        }

        // Update metadata
        upsertCsvUpload.run({
          uploadDate,
          latestTradeDate: uploadDate,
          tradeCount: trades.length,
          totalPrincipal
        })
      })

      saveData(trades, deposits, uploadDate, totalPrincipal)
      console.log(`✅ Saved ${trades.length} trades and ${deposits.length} deposits for ${uploadDate} (principal: $${totalPrincipal.toFixed(2)})`)
      return uploadDate
    } catch (error) {
      console.error('Error saving trades:', error)
      throw error
    }
  }

  // Get trades for a specific upload date
  getTrades(uploadDate) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM trades
        WHERE upload_date = ?
        ORDER BY trans_date DESC, symbol
      `)
      const rows = stmt.all(uploadDate)

      // Convert back to the expected format
      return rows.map(row => ({
        date: row.trans_date,
        transDate: row.trans_date,
        transCode: row.trans_code,
        symbol: row.symbol,
        quantity: row.quantity,
        price: row.price,
        amount: row.amount,
        description: row.description,
        isBuy: row.is_buy === 1,
        isOption: row.is_option === 1
      }))
    } catch (error) {
      console.error('Error getting trades:', error)
      return []
    }
  }

  // Get deposits for a specific upload date
  getDeposits(uploadDate) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM deposits
        WHERE upload_date = ?
        ORDER BY deposit_date ASC
      `)
      const rows = stmt.all(uploadDate)

      return rows.map(row => ({
        date: row.deposit_date,
        amount: row.amount,
        description: row.description
      }))
    } catch (error) {
      console.error('Error getting deposits:', error)
      return []
    }
  }

  // Get total principal for a specific upload date
  getTotalPrincipal(uploadDate) {
    try {
      const stmt = db.prepare(`
        SELECT total_principal FROM csv_uploads
        WHERE upload_date = ?
      `)
      const row = stmt.get(uploadDate)
      return row ? row.total_principal : 0
    } catch (error) {
      console.error('Error getting total principal:', error)
      return 0
    }
  }

  // Get the latest saved trades
  getLatestTrades() {
    try {
      const latestUpload = db.prepare(`
        SELECT upload_date FROM csv_uploads
        ORDER BY upload_date DESC
        LIMIT 1
      `).get()

      if (!latestUpload) {
        return { trades: [], uploadDate: null }
      }

      return {
        trades: this.getTrades(latestUpload.upload_date),
        uploadDate: latestUpload.upload_date
      }
    } catch (error) {
      console.error('Error getting latest trades:', error)
      return { trades: [], uploadDate: null }
    }
  }

  // Get latest CSV upload metadata without loading trades
  getLatestCsvUpload() {
    try {
      const stmt = db.prepare(`
        SELECT upload_date, latest_trade_date, trade_count
        FROM csv_uploads
        ORDER BY upload_date DESC
        LIMIT 1
      `)
      return stmt.get()
    } catch (error) {
      console.error('Error getting latest CSV upload:', error)
      return null
    }
  }

  // Get all available upload dates
  getUploadDates() {
    try {
      const stmt = db.prepare(`
        SELECT upload_date, latest_trade_date, trade_count
        FROM csv_uploads
        ORDER BY upload_date DESC
      `)
      return stmt.all()
    } catch (error) {
      console.error('Error getting upload dates:', error)
      return []
    }
  }

  // Save price benchmarks for P&L tracking
  savePriceBenchmarks(pnlData, asofDate) {
    try {
      // Delete existing benchmarks for this date first (allow re-uploading)
      db.prepare('DELETE FROM price_benchmarks WHERE asof_date = ?').run(asofDate)

      const timestamp = Date.now()
      const stmt = db.prepare(`
        INSERT INTO price_benchmarks (symbol, price_level, total_pnl, position, avg_cost, realized_pnl, unrealized_pnl, asof_date, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const insertMany = db.transaction((benchmarks) => {
        for (const benchmark of benchmarks) {
          stmt.run(
            benchmark.symbol,
            benchmark.price_level,
            benchmark.total_pnl,
            benchmark.position,
            benchmark.avg_cost,
            benchmark.realized_pnl,
            benchmark.unrealized_pnl,
            asofDate,
            timestamp
          )
        }
      })

      insertMany(pnlData)
      console.log(`💾 Saved ${pnlData.length} price benchmarks for ${asofDate} (overwrote existing if any)`)
    } catch (error) {
      console.error('Error saving price benchmarks:', error)
      throw error
    }
  }

  // Get price benchmarks for a symbol near a specific price
  getPriceBenchmarks(symbol, targetPrice, tolerance = 0.05) {
    try {
      const minPrice = targetPrice * (1 - tolerance)
      const maxPrice = targetPrice * (1 + tolerance)

      const stmt = db.prepare(`
        SELECT symbol, price_level, total_pnl, position, avg_cost, realized_pnl, unrealized_pnl, asof_date, timestamp
        FROM price_benchmarks
        WHERE symbol = ? AND price_level BETWEEN ? AND ?
        ORDER BY timestamp DESC
        LIMIT 10
      `)

      return stmt.all(symbol, minPrice, maxPrice)
    } catch (error) {
      console.error('Error getting price benchmarks:', error)
      return []
    }
  }

  // Get all benchmark history for a symbol
  getBenchmarkHistory(symbol) {
    try {
      const stmt = db.prepare(`
        SELECT symbol, price_level, total_pnl, position, avg_cost, realized_pnl, unrealized_pnl, asof_date, timestamp
        FROM price_benchmarks
        WHERE symbol = ?
        ORDER BY timestamp DESC
      `)

      return stmt.all(symbol)
    } catch (error) {
      console.error('Error getting benchmark history:', error)
      return []
    }
  }

  // Clear all saved data (useful after code changes that affect P&L calculation)
  clearAllData() {
    try {
      db.prepare('DELETE FROM price_benchmarks').run()
      db.prepare('DELETE FROM pnl_snapshots').run()
      db.prepare('DELETE FROM trades').run()
      db.prepare('DELETE FROM csv_uploads').run()
      console.log('✅ Cleared all saved data from database')
    } catch (error) {
      console.error('Error clearing database:', error)
      throw error
    }
  }

  // Close database connection
  close() {
    db.close()
  }
}

export const databaseService = new DatabaseService()
