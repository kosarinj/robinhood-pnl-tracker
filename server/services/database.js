import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Resolve the SQLite file. Railway does NOT apply env vars declared in railway.toml,
// so DATABASE_PATH is frequently unset and the app would silently fall back to an
// EPHEMERAL path that gets wiped on every redeploy. To survive redeploys, prefer the
// mounted persistent volume at /app/data whenever it exists, even without the env var.
// Candidate volume mount points, in priority order. /data is where the Railway volume
// (robinhood-pnl-tracker-volume) is actually mounted; the others are legacy paths.
export const VOLUME_CANDIDATES = ['/data', '/app/data', '/app/server/data']
function resolveDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH
  for (const dir of VOLUME_CANDIDATES) {
    try { if (existsSync(dir)) return join(dir, 'trading_data.db') } catch { /* ignore */ }
  }
  return join(__dirname, '..', 'trading_data.db')
}
export const dbPath = resolveDbPath()
console.log(`📁 SQLite path: ${dbPath} (DATABASE_PATH ${process.env.DATABASE_PATH ? 'set' : 'unset → resolved'})`)
const db = new Database(dbPath)

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL')

// Create tables
db.exec(`
  -- Table to store users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_login INTEGER
  );

  -- Table to store user sessions
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Table to cache historical prices
  CREATE TABLE IF NOT EXISTS historical_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    price_date TEXT NOT NULL,
    open_price REAL,
    high_price REAL,
    low_price REAL,
    close_price REAL,
    volume INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(symbol, price_date)
  );

  -- App-wide UI settings (theme, background image, etc.) stored server-side so they
  -- sync across every device/browser instead of living in one browser's localStorage.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Daily IV / HV snapshots per ticker, so IV Rank / Percentile can build over time
  CREATE TABLE IF NOT EXISTS iv_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    snap_date TEXT NOT NULL,
    iv REAL,
    hv30 REAL,
    stock REAL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(ticker, snap_date)
  );
  CREATE INDEX IF NOT EXISTS idx_iv_history_ticker ON iv_history(ticker, snap_date DESC);

  -- Cached full vol-scan rows per ticker, so large universes (S&P/NASDAQ) can be
  -- served instantly from a background scan instead of live-fetching hundreds of names.
  CREATE TABLE IF NOT EXISTS vol_scan_cache (
    ticker TEXT PRIMARY KEY,
    stock REAL, hv20 REAL, hv30 REAL, iv REAL, iv_dte INTEGER, iv_source TEXT,
    iv_hv_ratio REAL, signal TEXT, iv_rank REAL, iv_percentile REAL,
    earnings_date TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Next-earnings dates per ticker (from Nasdaq), cached so we don't refetch constantly.
  CREATE TABLE IF NOT EXISTS earnings_cache (
    ticker TEXT PRIMARY KEY,
    earnings_date TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Table to store support/resistance levels from Level 2 data
  CREATE TABLE IF NOT EXISTS support_resistance_levels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    price REAL NOT NULL,
    size INTEGER NOT NULL,
    value REAL NOT NULL,
    volume_percentage REAL,
    strength INTEGER,
    distance_from_price REAL,
    detected_at INTEGER DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER
  );

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

  -- Indexes for users and sessions
  CREATE INDEX IF NOT EXISTS idx_sessions_token
    ON sessions(session_token);

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id
    ON sessions(user_id, expires_at DESC);

  -- Index for historical prices cache
  CREATE INDEX IF NOT EXISTS idx_historical_prices_symbol_date
    ON historical_prices(symbol, price_date DESC);
`)

// Daily EOD price snapshot table — created via migration so it works on existing DBs
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      symbol TEXT NOT NULL,
      price_date TEXT NOT NULL,
      close_price REAL NOT NULL,
      is_option INTEGER NOT NULL DEFAULT 0,
      contracts INTEGER,
      captured_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, symbol, price_date)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_price_snapshots_date ON daily_price_snapshots(user_id, price_date DESC)`)
} catch (e) {
  console.error('daily_price_snapshots migration error:', e.message)
}

// Migration: short_call_entries — tracks underlying close price when a short call was sold
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS short_call_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      symbol TEXT NOT NULL,
      ticker TEXT NOT NULL,
      strike REAL NOT NULL,
      expiry TEXT NOT NULL,
      contracts INTEGER NOT NULL DEFAULT 1,
      premium REAL NOT NULL,
      sale_date TEXT NOT NULL,
      underlying_close REAL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, symbol, sale_date)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_short_call_entries_user ON short_call_entries(user_id, sale_date DESC)`)
  // Short call entries carry a broker so the Open Premium / Open P&L / Theta
  // columns follow the broker tab like everything else.
  const sceInfo = db.pragma('table_info(short_call_entries)')
  if (!sceInfo.some(c => c.name === 'broker')) {
    db.exec(`ALTER TABLE short_call_entries ADD COLUMN broker TEXT DEFAULT 'robinhood'`)
    db.exec(`UPDATE short_call_entries SET broker = 'robinhood' WHERE broker IS NULL`)
    console.log('✅ Added broker column to short_call_entries')
  }
} catch (e) {
  console.error('short_call_entries migration error:', e.message)
}

// Migration: option_iv_marks — the closing implied vol for each open contract.
// Captured at the 4pm close and calibrated so Black-Scholes reproduces that day's
// actual closing mark exactly. Extended-hours repricing holds this sigma constant
// and only moves the underlying, so the estimate is continuous with the close.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS option_iv_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      symbol TEXT NOT NULL,
      ticker TEXT NOT NULL,
      opt_type TEXT NOT NULL,
      strike REAL NOT NULL,
      expiry TEXT NOT NULL,
      mark_date TEXT NOT NULL,
      close_mark REAL NOT NULL,
      underlying_close REAL NOT NULL,
      sigma REAL NOT NULL,
      source TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, symbol, mark_date)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_option_iv_marks_lookup ON option_iv_marks(user_id, symbol, mark_date DESC)`)
} catch (e) {
  console.error('option_iv_marks migration error:', e.message)
}

// Migration: broker cash activity — dividends, interest, margin, fees.
//
// These were parsed on upload and then dropped: they lived in the socket
// session and there was a "TODO: Load from database" where the reload should
// have been. So margin interest — a real, recurring cost of a leveraged book —
// existed nowhere the app could see it.
//
// Kept out of `trades` deliberately. They aren't trades, and putting them there
// would put them into position and P&L maths that has no idea what to do with
// a financing charge.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cash_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      trans_date TEXT NOT NULL,
      trans_code TEXT NOT NULL,
      symbol TEXT,
      amount REAL NOT NULL,
      description TEXT,
      broker TEXT DEFAULT 'robinhood',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, broker, trans_date, trans_code, amount, description)
    )
  `)
} catch (e) {
  console.error('cash_activity migration error:', e.message)
}

// Migration: stock splits. A split is a market fact, not per-user, so there's no
// user_id. Trades BEFORE split_date are recorded in pre-split terms: the share
// count needs multiplying and the per-share price dividing. The dollar amount is
// untouched — you paid what you paid.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_splits (
      symbol TEXT NOT NULL,
      split_date TEXT NOT NULL,
      ratio REAL NOT NULL,
      source TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (symbol, split_date)
    )
  `)
} catch (e) {
  console.error('stock_splits migration error:', e.message)
}

// Migration: repair Buy to Cover rows imported as sales.
//
// BC closes a short by buying shares back, but the importer's buy test looked
// for "BUY", BTO or BTC, so every cover was stored as another sale and a short
// that was opened and closed subtracted its size twice. Re-importing cannot fix
// these: the dedup key includes trans_code, so the existing rows match the file
// and are skipped rather than rewritten. They have to be corrected in place.
try {
  const fixed = db.prepare(
    `UPDATE trades SET is_buy = 1
     WHERE trans_code = 'BC' AND COALESCE(is_option,0) = 0 AND COALESCE(is_buy,0) = 0`
  ).run()
  if (fixed.changes > 0) console.log(`✅ Repaired ${fixed.changes} Buy-to-Cover row(s) stored as sales`)
} catch (e) {
  console.error('buy-to-cover migration error:', e.message)
}

// Migration: strip the settlement prefix from option symbols.
//
// Robinhood writes an expiry as "Option Expiration for MRVL 8/7/2026 Put $148.00".
// An option's identity in this table IS its description, so that prefix made the
// settlement a different contract from the trade that opened it. Nothing matched:
// every expired option stayed open for good, and the expiry was never booked —
// a loss on a bought contract, the whole premium kept on a sold one. Reimporting
// cannot fix these, because the dedup key includes the symbol, so the stored rows
// have to be rewritten in place.
try {
  const prefixes = [
    'Option Expiration for ',
    'Option Assignment for ',
    'Option Exercise for ',
    'Option Exercise/Assignment for ',
  ]
  let total = 0
  for (const p of prefixes) {
    const r = db.prepare(
      `UPDATE trades
          SET symbol = TRIM(SUBSTR(symbol, ?)),
              description = TRIM(SUBSTR(COALESCE(description, symbol), ?))
        WHERE COALESCE(is_option,0) = 1 AND symbol LIKE ?`
    ).run(p.length + 1, p.length + 1, `${p}%`)
    total += r.changes || 0
  }
  if (total > 0) console.log(`✅ Normalized ${total} option settlement symbol(s)`)
} catch (e) {
  console.error('option settlement symbol migration error:', e.message)
}

// Migration: share transfers between brokers.
//
// Shares moved by journal, not bought or sold. The Schwab parser has always
// separated these out, and server/index.js then dropped them on the floor —
// which leaves per-broker P&L half-counted in both directions. The broker that
// sent them shows the purchase with no shares and no sale to offset it; the one
// that received them shows shares that cost nothing. Neither is wrong about its
// own cash, and neither can be right on its own.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_transfers (
      user_id INTEGER NOT NULL,
      broker TEXT NOT NULL,
      symbol TEXT NOT NULL,
      transfer_date TEXT NOT NULL,
      quantity REAL NOT NULL,
      direction TEXT NOT NULL,          -- 'in' | 'out'
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, broker, symbol, transfer_date, quantity, direction)
    )
  `)
} catch (e) {
  console.error('share_transfers migration error:', e.message)
}

// Migration: per-user view preferences.
//
// These lived in localStorage, which makes them per DEVICE. Several of them
// change displayed P&L rather than just layout — how many weeks Cumulative P&L
// sums, manual share and price overrides, which tickers are hidden — so the
// same account reported different totals on a laptop, a phone browser and the
// iOS app, each holding its own copy. Keyed by user so settings follow the
// person; the value is opaque JSON so a new preference needs no migration.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER NOT NULL,
      pref_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (user_id, pref_key)
    )
  `)
} catch (e) {
  console.error('user_preferences migration error:', e.message)
}

// Migration: stock cost overrides — manual avg cost per symbol for YTD panel
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_cost_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      symbol TEXT NOT NULL,
      avg_cost REAL NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, symbol)
    )
  `)
  // Overrides are per broker: the same ticker can be held at two brokers with
  // genuinely different cost bases, and a single shared override made the
  // Webull row show the Robinhood cost.
  //
  // The old UNIQUE(user_id, symbol) is a table constraint backed by an
  // auto-index that SQLite won't let us drop, so the table has to be rebuilt.
  // Existing overrides were all Robinhood, which is the backfill value.
  const scoInfo = db.pragma('table_info(stock_cost_overrides)')
  if (!scoInfo.some(c => c.name === 'broker')) {
    db.exec('BEGIN')
    try {
      db.exec(`
        CREATE TABLE stock_cost_overrides_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 1,
          symbol TEXT NOT NULL,
          broker TEXT NOT NULL DEFAULT 'robinhood',
          avg_cost REAL NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s', 'now')),
          UNIQUE(user_id, symbol, broker)
        )
      `)
      db.exec(`
        INSERT INTO stock_cost_overrides_new (id, user_id, symbol, broker, avg_cost, updated_at)
        SELECT id, user_id, symbol, 'robinhood', avg_cost, updated_at FROM stock_cost_overrides
      `)
      db.exec('DROP TABLE stock_cost_overrides')
      db.exec('ALTER TABLE stock_cost_overrides_new RENAME TO stock_cost_overrides')
      db.exec('COMMIT')
      console.log('✅ stock_cost_overrides is now per-broker (existing rows → robinhood)')
    } catch (inner) {
      db.exec('ROLLBACK')
      throw inner
    }
  }
} catch (e) {
  console.error('stock_cost_overrides migration error:', e.message)
}

console.log(`Database initialized at: ${dbPath}`)

// Migration: add earnings_date to an existing vol_scan_cache (older DBs created before it)
try { db.exec(`ALTER TABLE vol_scan_cache ADD COLUMN earnings_date TEXT`) } catch (e) { /* column already exists */ }

// Migration: Drop the trades dedup unique index that incorrectly prevents identical legitimate trades
try {
  db.exec('DROP INDEX IF EXISTS idx_trades_dedup')
  console.log('✅ Dropped idx_trades_dedup (replaced with count-based dedup in saveTrades)')
} catch (error) {
  console.log('ℹ️ idx_trades_dedup drop skipped:', error.message)
}

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

  // Migration: which broker a trade came from. Everything that existed before
  // multi-broker support was a Robinhood CSV, so that's the backfill value.
  // Must run before the prepared statements below reference the column.
  // NB: no index here — on a fresh database `user_id` doesn't exist on trades
  // yet (a later migration adds it), and a CREATE INDEX naming it would throw
  // and abort the rest of this block. The index is created further down, once
  // user_id is guaranteed to be there.
  const hasBroker = tableInfo.some(col => col.name === 'broker')
  if (!hasBroker) {
    db.exec(`ALTER TABLE trades ADD COLUMN broker TEXT DEFAULT 'robinhood'`)
    db.exec(`UPDATE trades SET broker = 'robinhood' WHERE broker IS NULL`)
    console.log('✅ Added broker column to trades table (existing rows → robinhood)')
  }
  // Deposits carry a broker too, so re-uploading one broker's file can't delete
  // another's cash movements for the same upload date.
  const depositInfo = db.pragma('table_info(deposits)')
  if (!depositInfo.some(col => col.name === 'broker')) {
    db.exec(`ALTER TABLE deposits ADD COLUMN broker TEXT DEFAULT 'robinhood'`)
    db.exec(`UPDATE deposits SET broker = 'robinhood' WHERE broker IS NULL`)
    console.log('✅ Added broker column to deposits table')
  }

  // Migration: Add contracts column to trades table if it doesn't exist
  const hasContracts = tableInfo.some(col => col.name === 'contracts')
  if (!hasContracts) {
    db.exec('ALTER TABLE trades ADD COLUMN contracts INTEGER DEFAULT 1')
    db.exec(`UPDATE trades SET contracts = 1 WHERE contracts IS NULL`)
    console.log('✅ Added contracts column to trades table')
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

// Migration: Add user_id columns to existing tables for multi-user support
try {
  const tradesInfo = db.pragma('table_info(trades)')
  const tradesHasUserId = tradesInfo.some(col => col.name === 'user_id')

  if (!tradesHasUserId) {
    console.log('Adding user_id column to trades table...')
    db.exec('ALTER TABLE trades ADD COLUMN user_id INTEGER DEFAULT 1')
    console.log('✅ Added user_id column to trades')
  }

  const pnlSnapshotsInfo = db.pragma('table_info(pnl_snapshots)')
  const pnlHasUserId = pnlSnapshotsInfo.some(col => col.name === 'user_id')

  if (!pnlHasUserId) {
    console.log('Adding user_id column to pnl_snapshots table...')
    db.exec('ALTER TABLE pnl_snapshots ADD COLUMN user_id INTEGER DEFAULT 1')
    console.log('✅ Added user_id column to pnl_snapshots')
  }

  const depositsInfo = db.pragma('table_info(deposits)')
  const depositsHasUserId = depositsInfo.some(col => col.name === 'user_id')

  if (!depositsHasUserId) {
    console.log('Adding user_id column to deposits table...')
    db.exec('ALTER TABLE deposits ADD COLUMN user_id INTEGER DEFAULT 1')
    console.log('✅ Added user_id column to deposits')
  }

  const csvUploadsInfo2 = db.pragma('table_info(csv_uploads)')
  const csvHasUserId = csvUploadsInfo2.some(col => col.name === 'user_id')

  if (!csvHasUserId) {
    console.log('Adding user_id column to csv_uploads table...')
    db.exec('ALTER TABLE csv_uploads ADD COLUMN user_id INTEGER DEFAULT 1')
    console.log('✅ Added user_id column to csv_uploads')
  }

  // Create unique indexes for multi-user support
  // Note: SQLite doesn't support modifying UNIQUE constraints, so we create indexes
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_snapshots_user_date_symbol ON pnl_snapshots(user_id, asof_date, symbol)')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_csv_uploads_user_date ON csv_uploads(user_id, upload_date)')
    // Safe here: user_id exists on trades by this point.
    db.exec('CREATE INDEX IF NOT EXISTS idx_trades_broker ON trades(user_id, broker)')
    console.log('✅ Created unique indexes for multi-user support')
  } catch (error) {
    console.log('ℹ️ Unique indexes may already exist')
  }
} catch (error) {
  console.error('Migration error:', error)
}

// Migration: Create DCA schedule table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dca_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      symbol TEXT NOT NULL,
      next_alert_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, symbol)
    )
  `)
  console.log('✅ dca_schedule table ready')
} catch (error) {
  console.error('Migration error (dca_schedule):', error)
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
  INSERT INTO pnl_snapshots (asof_date, symbol, position, avg_cost, current_price, current_value, realized_pnl, unrealized_pnl, total_pnl, daily_pnl, options_pnl, percentage, lowest_open_buy_price, lowest_open_buy_days_ago, recent_lowest_buy_price, recent_lowest_buy_days_ago, recent_lowest_sell_price, recent_lowest_sell_days_ago, user_id)
  VALUES (@asofDate, @symbol, @position, @avgCost, @currentPrice, @currentValue, @realizedPnl, @unrealizedPnl, @totalPnl, @dailyPnl, @optionsPnl, @percentage, @lowestOpenBuyPrice, @lowestOpenBuyDaysAgo, @recentLowestBuyPrice, @recentLowestBuyDaysAgo, @recentLowestSellPrice, @recentLowestSellDaysAgo, @userId)
  ON CONFLICT(asof_date, symbol, user_id) DO UPDATE SET
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
  INSERT INTO trades (upload_date, trans_date, trans_code, symbol, quantity, price, amount, description, is_buy, is_option, contracts, user_id, broker)
  VALUES (@uploadDate, @transDate, @transCode, @symbol, @quantity, @price, @amount, @description, @isBuy, @isOption, @contracts, @userId, @broker)
`)

// Count existing trades matching a given key from upload_dates OTHER than the current one.
// Broker is part of the key: the same ticker, size and price can legitimately trade
// at two brokers on the same day, and without it one of them would be deduped away.
const countExistingTrade = db.prepare(`
  SELECT COUNT(*) as cnt FROM trades
  WHERE user_id = @userId
    AND COALESCE(broker, 'robinhood') = @broker
    AND trans_date = @transDate
    AND COALESCE(trans_code, '') = @transCode
    AND symbol = @symbol
    AND quantity = @quantity
    AND price = @price
    AND amount = @amount
    AND upload_date != @uploadDate
`)

const upsertCsvUpload = db.prepare(`
  INSERT INTO csv_uploads (upload_date, latest_trade_date, trade_count, total_principal, user_id)
  VALUES (@uploadDate, @latestTradeDate, @tradeCount, @totalPrincipal, @userId)
  ON CONFLICT(upload_date, user_id) DO UPDATE SET
    latest_trade_date = excluded.latest_trade_date,
    trade_count = excluded.trade_count,
    total_principal = excluded.total_principal,
    updated_at = strftime('%s', 'now')
`)

const insertDeposit = db.prepare(`
  INSERT INTO deposits (upload_date, deposit_date, amount, description, user_id, broker)
  VALUES (@uploadDate, @depositDate, @amount, @description, @userId, @broker)
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
  savePnLSnapshot(asofDate, pnlData, userId = 1) {
    try {
      // Get previous day's snapshot to calculate daily P&L
      const previousDayStmt = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        WHERE asof_date < ? AND user_id = ?
        ORDER BY asof_date DESC
        LIMIT 1
      `)
      const previousDay = previousDayStmt.get(asofDate, userId)
      const previousDayDate = previousDay?.asof_date

      // Get previous day's P&L for each symbol if it exists
      const previousPnLMap = {}
      if (previousDayDate) {
        const prevStmt = db.prepare(`
          SELECT symbol, total_pnl
          FROM pnl_snapshots
          WHERE asof_date = ? AND user_id = ?
        `)
        const prevSnapshots = prevStmt.all(previousDayDate, userId)
        prevSnapshots.forEach(snap => {
          previousPnLMap[snap.symbol] = snap.total_pnl || 0
        })
      }

      let totalDailyPnl = 0
      let previousDayTotalPnl = 0
      const saveSnapshot = db.transaction((asofDate, pnlData) => {
        totalDailyPnl = 0
        previousDayTotalPnl = 0
        for (const item of pnlData) {
          const currentTotalPnl = item.real?.totalPnL || 0
          const previousTotalPnl = previousPnLMap[item.symbol] || 0
          previousDayTotalPnl += previousTotalPnl

          // Daily P&L = today's total - yesterday's total
          // If no previous day, daily P&L = total P&L
          const dailyPnl = previousDayDate ? (currentTotalPnl - previousTotalPnl) : currentTotalPnl
          totalDailyPnl += dailyPnl

          upsertPnLSnapshot.run({
            asofDate,
            symbol: item.symbol,
            position: item.real?.position || 0,
            avgCost: item.real?.avgCostBasis || null,
            currentPrice: item.currentPrice || null,
            currentValue: item.real?.currentValue || null,
            realizedPnl: item.real?.realizedPnL || null,
            unrealizedPnl: item.real?.unrealizedPnL || null,
            totalPnl: currentTotalPnl,
            dailyPnl: dailyPnl,
            optionsPnl: item.optionsPnL || null,
            percentage: item.real?.percentage || null,
            lowestOpenBuyPrice: item.real?.lowestOpenBuyPrice || null,
            lowestOpenBuyDaysAgo: item.real?.lowestOpenBuyDaysAgo || null,
            recentLowestBuyPrice: item.real?.recentLowestBuyPrice || null,
            recentLowestBuyDaysAgo: item.real?.recentLowestBuyDaysAgo || null,
            recentLowestSellPrice: item.real?.recentLowestSellPrice || null,
            recentLowestSellDaysAgo: item.real?.recentLowestSellDaysAgo || null,
            userId
          })
        }
      })
      saveSnapshot(asofDate, pnlData)
      const totalPnl = pnlData.reduce((sum, item) => sum + (item.real?.totalPnL || 0), 0)
      console.log(`✅ Saved P&L snapshot for ${asofDate}:`)
      console.log(`   Previous day: ${previousDayDate || 'none (first snapshot)'}`)
      console.log(`   Previous day Total P&L: ${previousDayDate ? previousDayTotalPnl.toFixed(2) : 'N/A'}`)
      console.log(`   Today Total P&L: ${totalPnl.toFixed(2)}`)
      console.log(`   Daily P&L (difference): ${totalDailyPnl.toFixed(2)}`)
      console.log(`   Symbols: ${pnlData.length}`)
    } catch (error) {
      console.error('Error saving P&L snapshot:', error)
      throw error
    }
  }

  // Delete P&L snapshot for a specific date
  deletePnLSnapshot(asofDate, userId = 1) {
    try {
      const stmt = db.prepare(`
        DELETE FROM pnl_snapshots
        WHERE asof_date = ? AND user_id = ?
      `)
      const result = stmt.run(asofDate, userId)
      console.log(`🗑️ Deleted ${result.changes} snapshot records for ${asofDate} (user: ${userId})`)
      return result.changes
    } catch (error) {
      console.error('Error deleting P&L snapshot:', error)
      throw error
    }
  }

  // Get P&L snapshot for a specific date
  getPnLSnapshot(asofDate, userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM pnl_snapshots
        WHERE asof_date = ? AND user_id = ?
        ORDER BY symbol
      `)
      return stmt.all(asofDate, userId)
    } catch (error) {
      console.error('Error getting P&L snapshot:', error)
      return []
    }
  }

  // Get all available snapshot dates
  getSnapshotDates(userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        WHERE user_id = ?
        ORDER BY asof_date DESC
      `)
      return stmt.all(userId).map(row => row.asof_date)
    } catch (error) {
      console.error('Error getting snapshot dates:', error)
      return []
    }
  }

  // Debug: Get raw snapshot data from database
  getSnapshotsDebugInfo(userId = 1) {
    try {
      const snapshots = db.prepare(`
        SELECT asof_date, symbol, total_pnl, realized_pnl, unrealized_pnl
        FROM pnl_snapshots
        WHERE user_id = ?
        ORDER BY asof_date DESC, symbol
        LIMIT 50
      `).all(userId)

      const dates = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        WHERE user_id = ?
        ORDER BY asof_date DESC
      `).all(userId)

      const count = db.prepare(`
        SELECT COUNT(*) as count
        FROM pnl_snapshots
        WHERE user_id = ?
      `).get(userId)

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
      // Get the most recent snapshot date first (instead of using server's current date)
      const mostRecentStmt = db.prepare(`
        SELECT DISTINCT asof_date
        FROM pnl_snapshots
        ORDER BY asof_date DESC
        LIMIT 1
      `)
      const mostRecent = mostRecentStmt.get()

      if (!mostRecent) {
        console.log(`No snapshots found in database`)
        return { date: null, data: [] }
      }

      console.log(`🔍 Most recent snapshot: ${mostRecent.asof_date}`)

      // Calculate target date as N days before the most recent snapshot
      // Parse YYYY-MM-DD without timezone issues
      const [year, month, day] = mostRecent.asof_date.split('-').map(Number)
      const targetDate = new Date(year, month - 1, day)
      targetDate.setDate(targetDate.getDate() - daysAgo)
      const targetYear = targetDate.getFullYear()
      const targetMonth = String(targetDate.getMonth() + 1).padStart(2, '0')
      const targetDay = String(targetDate.getDate()).padStart(2, '0')
      const targetDateStr = `${targetYear}-${targetMonth}-${targetDay}`

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
  getDailyPnLHistory(userId = 1) {
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
        WHERE user_id = ?
        GROUP BY asof_date
        ORDER BY asof_date ASC
      `)
      const results = stmt.all(userId)
      console.log('🔍 getDailyPnLHistory results:', results.map(r => ({ date: r.asof_date, total: r.total_pnl })))
      return results
    } catch (error) {
      console.error('Error getting daily P&L history:', error)
      return []
    }
  }

  // Get daily P&L history for a specific symbol with price
  getSymbolDailyPnL(symbol, userId = 1) {
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
        WHERE symbol = ? AND user_id = ?
        ORDER BY asof_date ASC
      `)
      return stmt.all(symbol, userId)
    } catch (error) {
      console.error('Error getting symbol daily P&L:', error)
      return []
    }
  }

  // Get list of all symbols that have snapshot data
  getSymbolsWithSnapshots(userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT DISTINCT symbol
        FROM pnl_snapshots
        WHERE user_id = ?
        ORDER BY symbol ASC
      `)
      return stmt.all(userId).map(row => row.symbol)
    } catch (error) {
      console.error('Error getting symbols with snapshots:', error)
      return []
    }
  }

  // Save trades from CSV upload
  saveTrades(trades, uploadDate = null, deposits = [], totalPrincipal = 0, userId = 1, broker = 'robinhood') {
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

      // Delete existing rows for this upload date and user — scoped to THIS
      // broker. Re-uploading a Webull file must not wipe the Robinhood trades
      // that happen to share an upload date.
      db.prepare(`DELETE FROM trades WHERE upload_date = ? AND user_id = ? AND COALESCE(broker,'robinhood') = ?`)
        .run(uploadDate, userId, broker)
      db.prepare(`DELETE FROM deposits WHERE upload_date = ? AND user_id = ? AND COALESCE(broker,'robinhood') = ?`)
        .run(uploadDate, userId, broker)

      // Group CSV trades by dedup key so identical trades can be counted and compared against DB
      const csvTradeGroups = new Map()
      for (const trade of trades) {
        const transDate = new Date(trade.date || trade.transDate).toISOString().split('T')[0]
        const transCode = trade.transCode || trade.transactionCode || null
        const key = `${transDate}|${transCode || ''}|${trade.symbol}|${trade.quantity}|${trade.price}|${trade.amount}`
        if (!csvTradeGroups.has(key)) csvTradeGroups.set(key, [])
        csvTradeGroups.get(key).push({ ...trade, _transDate: transDate, _transCode: transCode })
      }

      // Save all trades and deposits in a transaction
      const saveData = db.transaction((csvTradeGroups, deposits, uploadDate, totalPrincipal, userId) => {
        for (const [, tradeList] of csvTradeGroups) {
          const t = tradeList[0]
          // Count how many times this trade exists in DB from OTHER upload_dates
          const { cnt: alreadyInDb } = countExistingTrade.get({
            userId,
            transDate: t._transDate,
            transCode: t._transCode || '',
            symbol: t.symbol,
            quantity: t.quantity,
            price: t.price,
            amount: t.amount,
            uploadDate,
            broker
          })
          // Insert only the trades that aren't already covered by other uploads
          const toInsert = Math.max(0, tradeList.length - alreadyInDb)
          for (let i = 0; i < toInsert; i++) {
            const trade = tradeList[i]
            insertTrade.run({
              uploadDate,
              transDate: trade._transDate,
              transCode: trade._transCode,
              symbol: trade.symbol,
              quantity: trade.quantity,
              price: trade.price,
              amount: trade.amount,
              description: trade.description || null,
              isBuy: trade.isBuy ? 1 : 0,
              isOption: trade.isOption ? 1 : 0,
              contracts: trade.contracts || 1,
              userId,
              broker
            })
          }
        }

        // Save deposits
        for (const deposit of deposits) {
          const depositDate = new Date(deposit.date).toISOString().split('T')[0]
          insertDeposit.run({
            uploadDate,
            depositDate,
            amount: deposit.amount,
            description: deposit.description || null,
            userId,
            broker
          })
        }

        // Update metadata
        upsertCsvUpload.run({
          uploadDate,
          latestTradeDate: uploadDate,
          tradeCount: trades.length,
          totalPrincipal,
          userId
        })
      })

      saveData(csvTradeGroups, deposits, uploadDate, totalPrincipal, userId)
      console.log(`✅ Saved trades and ${deposits.length} deposits for ${uploadDate} (user: ${userId}, principal: $${totalPrincipal.toFixed(2)})`)
      return uploadDate
    } catch (error) {
      console.error('Error saving trades:', error)
      throw error
    }
  }

  // Get trades for a specific upload date
  getTrades(uploadDate, userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM trades
        WHERE upload_date = ? AND user_id = ?
        ORDER BY trans_date DESC, symbol
      `)
      const rows = stmt.all(uploadDate, userId)

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
  getDeposits(uploadDate, userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM deposits
        WHERE upload_date = ? AND user_id = ?
        ORDER BY deposit_date ASC
      `)
      const rows = stmt.all(uploadDate, userId)

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
  getTotalPrincipal(uploadDate, userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT total_principal FROM csv_uploads
        WHERE upload_date = ? AND user_id = ?
      `)
      const row = stmt.get(uploadDate, userId)
      return row ? row.total_principal : 0
    } catch (error) {
      console.error('Error getting total principal:', error)
      return 0
    }
  }

  // Get all trades for a user across all upload dates (deduped by the save logic — each unique trade lives in exactly one upload_date)
  getAllTradesForUser(userId = 1) {
    try {
      const rows = db.prepare(`
        SELECT * FROM trades
        WHERE user_id = ?
        ORDER BY trans_date ASC, symbol
      `).all(userId)

      // Stock trades are split-adjusted here so every consumer — the tax
      // engine, realized P&L, the trades table — sees consistent share counts.
      // Options are deliberately left alone: a split rewrites strikes and
      // deliverables in ways this can't infer, so quietly scaling them would
      // invent numbers.
      const splits = this.getSplits([...new Set(rows.filter(r => !r.is_option).map(r => r.symbol))])
      return rows.map(row => {
        const f = row.is_option ? 1 : this.splitFactor(splits[row.symbol], row.trans_date)
        return {
          date: row.trans_date,
          transDate: row.trans_date,
          transCode: row.trans_code,
          symbol: row.symbol,
          quantity: f === 1 ? row.quantity : row.quantity * f,
          price: f === 1 ? row.price : row.price / f,
          amount: row.amount,          // cash paid doesn't change
          description: row.description,
          isBuy: row.is_buy === 1,
          isOption: row.is_option === 1,
          contracts: row.contracts || 1,
          broker: row.broker || 'robinhood',
          splitAdjusted: f !== 1 ? f : undefined,
        }
      })
    } catch (error) {
      console.error('Error getting all trades:', error)
      return []
    }
  }

  // Which brokers this user actually has data for — drives the tab bar, so the
  // UI never shows a tab that would be empty.
  getBrokersForUser(userId = 1) {
    try {
      return db.prepare(`
        SELECT COALESCE(broker,'robinhood') AS broker, COUNT(*) AS trade_count
        FROM trades WHERE user_id = ?
        GROUP BY COALESCE(broker,'robinhood')
        ORDER BY trade_count DESC
      `).all(userId)
    } catch (error) {
      console.error('Error getting brokers:', error)
      return []
    }
  }

  // Get the latest saved trades
  getLatestTrades(userId = 1) {
    try {
      const latestUpload = db.prepare(`
        SELECT upload_date FROM csv_uploads
        WHERE user_id = ?
        ORDER BY upload_date DESC
        LIMIT 1
      `).get(userId)

      if (!latestUpload) {
        return { trades: [], uploadDate: null }
      }

      return {
        trades: this.getTrades(latestUpload.upload_date, userId),
        uploadDate: latestUpload.upload_date
      }
    } catch (error) {
      console.error('Error getting latest trades:', error)
      return { trades: [], uploadDate: null }
    }
  }

  // Get latest CSV upload metadata without loading trades
  getLatestCsvUpload(userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT upload_date, latest_trade_date, trade_count
        FROM csv_uploads
        WHERE user_id = ?
        ORDER BY upload_date DESC
        LIMIT 1
      `)
      return stmt.get(userId)
    } catch (error) {
      console.error('Error getting latest CSV upload:', error)
      return null
    }
  }

  // Get all available upload dates
  getUploadDates(userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT upload_date, latest_trade_date, trade_count
        FROM csv_uploads
        WHERE user_id = ?
        ORDER BY upload_date DESC
      `)
      return stmt.all(userId)
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
  clearAllData(userId) {
    if (userId == null) throw new Error('clearAllData requires a userId')
    try {
      // Scoped to the requesting user only — never wipe other users' data.
      db.prepare('DELETE FROM pnl_snapshots WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM trades WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM deposits WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM csv_uploads WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM short_call_entries WHERE user_id = ?').run(userId)
      console.log(`✅ Cleared saved data for user ${userId}`)
    } catch (error) {
      console.error('Error clearing database:', error)
      throw error
    }
  }

  // Clear all P&L snapshots only (keeps trades and uploads)
  clearAllSnapshots(userId = 1) {
    try {
      const result = db.prepare('DELETE FROM pnl_snapshots WHERE user_id = ?').run(userId)
      console.log(`✅ Cleared all P&L snapshots for user ${userId} (${result.changes} records deleted)`)
      return result.changes
    } catch (error) {
      console.error('Error clearing snapshots:', error)
      throw error
    }
  }

  // Get missing days between snapshots for backfill
  getMissingSnapshotDates(userId = 1) {
    try {
      const dates = this.getSnapshotDates(userId)
      if (dates.length < 2) {
        return [] // Need at least 2 snapshots to find gaps
      }

      const firstDate = new Date(dates[0])
      const lastDate = new Date(dates[dates.length - 1])
      const existingDatesSet = new Set(dates)
      const missingDates = []

      // Iterate through all dates between first and last
      const currentDate = new Date(firstDate)
      while (currentDate <= lastDate) {
        const dateStr = currentDate.toISOString().split('T')[0]
        if (!existingDatesSet.has(dateStr)) {
          // Skip weekends (Saturday=6, Sunday=0)
          const dayOfWeek = currentDate.getDay()
          if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            missingDates.push(dateStr)
          }
        }
        currentDate.setDate(currentDate.getDate() + 1)
      }

      return missingDates
    } catch (error) {
      console.error('Error getting missing snapshot dates:', error)
      return []
    }
  }

  // Get all trades that were active (open) on a specific date
  getTradesActiveOnDate(targetDate, userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM trades
        WHERE user_id = ? AND trans_date <= ?
        ORDER BY trans_date ASC
      `)
      return stmt.all(userId, targetDate)
    } catch (error) {
      console.error(`Error getting trades active on ${targetDate}:`, error)
      return []
    }
  }

  // Save historical price to cache
  saveHistoricalPrice(symbol, priceDate, openPrice, highPrice, lowPrice, closePrice, volume = null) {
    try {
      const stmt = db.prepare(`
        INSERT INTO historical_prices (symbol, price_date, open_price, high_price, low_price, close_price, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, price_date) DO UPDATE SET
          open_price = excluded.open_price,
          high_price = excluded.high_price,
          low_price = excluded.low_price,
          close_price = excluded.close_price,
          volume = excluded.volume
      `)
      stmt.run(symbol, priceDate, openPrice, highPrice, lowPrice, closePrice, volume)
    } catch (error) {
      console.error(`Error saving historical price for ${symbol} on ${priceDate}:`, error)
    }
  }

  // Get historical price from cache
  getHistoricalPrice(symbol, priceDate) {
    try {
      const stmt = db.prepare(`
        SELECT close_price FROM historical_prices
        WHERE symbol = ? AND price_date = ?
      `)
      const row = stmt.get(symbol, priceDate)
      return row ? row.close_price : null
    } catch (error) {
      console.error(`Error getting historical price for ${symbol} on ${priceDate}:`, error)
      return null
    }
  }

  // Get historical prices for multiple symbols on a specific date
  getHistoricalPricesForDate(symbols, priceDate) {
    try {
      const placeholders = symbols.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT symbol, close_price FROM historical_prices
        WHERE symbol IN (${placeholders}) AND price_date = ?
      `)
      const rows = stmt.all(...symbols, priceDate)

      const prices = {}
      rows.forEach(row => {
        prices[row.symbol] = row.close_price
      })
      return prices
    } catch (error) {
      console.error(`Error getting historical prices for date ${priceDate}:`, error)
      return {}
    }
  }

  // Save multiple historical prices at once (batch insert)
  saveHistoricalPrices(priceData) {
    try {
      const insertStmt = db.prepare(`
        INSERT INTO historical_prices (symbol, price_date, open_price, high_price, low_price, close_price, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, price_date) DO UPDATE SET
          open_price = excluded.open_price,
          high_price = excluded.high_price,
          low_price = excluded.low_price,
          close_price = excluded.close_price,
          volume = excluded.volume
      `)

      const transaction = db.transaction((prices) => {
        for (const price of prices) {
          insertStmt.run(
            price.symbol,
            price.priceDate,
            price.openPrice || null,
            price.highPrice || null,
            price.lowPrice || null,
            price.closePrice,
            price.volume || null
          )
        }
      })

      transaction(priceData)
      console.log(`✅ Saved ${priceData.length} historical prices to cache`)
    } catch (error) {
      console.error('Error saving historical prices:', error)
      throw error
    }
  }

  // Save support/resistance levels
  saveSupportResistanceLevels(levels) {
    try {
      const stmt = db.prepare(`
        INSERT INTO support_resistance_levels
        (symbol, type, price, size, value, volume_percentage, strength, distance_from_price, detected_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const transaction = db.transaction((levelsList) => {
        for (const level of levelsList) {
          const expiresAt = Math.floor(Date.now() / 1000) + (24 * 60 * 60) // Expire after 24 hours
          stmt.run(
            level.symbol,
            level.type,
            level.price,
            level.size,
            level.value,
            parseFloat(level.volumePercentage),
            level.strength,
            parseFloat(level.distanceFromPrice),
            Math.floor(level.timestamp / 1000),
            expiresAt
          )
        }
      })

      transaction(levels)
      console.log(`✅ Saved ${levels.length} support/resistance levels`)
    } catch (error) {
      console.error('Error saving support/resistance levels:', error)
    }
  }

  // Get recent support/resistance levels for a symbol
  getSupportResistanceLevels(symbol, hoursBack = 24) {
    try {
      const cutoffTime = Math.floor(Date.now() / 1000) - (hoursBack * 60 * 60)
      const stmt = db.prepare(`
        SELECT * FROM support_resistance_levels
        WHERE symbol = ? AND detected_at > ?
        ORDER BY detected_at DESC, strength DESC
      `)
      return stmt.all(symbol, cutoffTime)
    } catch (error) {
      console.error(`Error getting support/resistance levels for ${symbol}:`, error)
      return []
    }
  }

  // Get active support/resistance levels across all symbols
  getAllActiveLevels() {
    try {
      const now = Math.floor(Date.now() / 1000)
      const stmt = db.prepare(`
        SELECT * FROM support_resistance_levels
        WHERE expires_at > ?
        ORDER BY strength DESC
        LIMIT 100
      `)
      return stmt.all(now)
    } catch (error) {
      console.error('Error getting all active levels:', error)
      return []
    }
  }

  // Clean up expired support/resistance levels
  cleanupExpiredLevels() {
    try {
      const now = Math.floor(Date.now() / 1000)
      const result = db.prepare('DELETE FROM support_resistance_levels WHERE expires_at <= ?').run(now)
      if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} expired support/resistance levels`)
      }
      return result.changes
    } catch (error) {
      console.error('Error cleaning up expired levels:', error)
      return 0
    }
  }

  getDailyOptionsPnLHistory(userId = 1) {
    try {
      const stmt = db.prepare(`
        SELECT
          asof_date,
          SUM(COALESCE(options_pnl, 0)) as options_pnl_total,
          SUM(daily_pnl) as stock_daily_pnl
        FROM pnl_snapshots
        WHERE user_id = ?
        GROUP BY asof_date
        ORDER BY asof_date ASC
      `)
      return stmt.all(userId)
    } catch (error) {
      console.error('Error getting daily options P&L history:', error)
      return []
    }
  }

  // Get all option trades for cash-flow-based P&L calculation (deduplicated)
  getOptionTrades(userId = 1, broker = null) {
    try {
      // broker in the GROUP BY: the same contract traded at two brokers on one
      // day is two trades, not one.
      const stmt = db.prepare(`
        SELECT trans_date, symbol, description, is_buy, amount, trans_code,
               COALESCE(broker,'robinhood') as broker
        FROM trades
        WHERE is_option = 1 AND user_id = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        GROUP BY trans_date, symbol, is_buy, amount, COALESCE(broker,'robinhood')
        ORDER BY trans_date ASC
      `)
      return stmt.all(...[userId, ...(broker ? [broker] : [])])
    } catch (error) {
      console.error('Error getting option trades:', error)
      return []
    }
  }

  // Get option trades for a specific week (for what-if analysis)
  getOptionTradesForWeek(userId = 1, startDate = '', endDate = '') {
    try {
      if (endDate) {
        return db.prepare(`
          SELECT trans_date, trans_code, symbol, quantity, price, amount, is_buy
          FROM trades
          WHERE is_option = 1 AND user_id = ? AND trans_date >= ? AND trans_date < ?
          GROUP BY trans_date, symbol, trans_code, is_buy, amount
          ORDER BY trans_date ASC
        `).all(userId, startDate, endDate)
      }
      return db.prepare(`
        SELECT trans_date, trans_code, symbol, quantity, price, amount, is_buy
        FROM trades
        WHERE is_option = 1 AND user_id = ? AND trans_date >= ?
        GROUP BY trans_date, symbol, trans_code, is_buy, amount
        ORDER BY trans_date ASC
      `).all(userId, startDate)
    } catch (error) {
      console.error('Error getting option trades for week:', error)
      return []
    }
  }

  // Find the final outcome (OEXP/OASGN) for a specific option contract
  getContractOutcome(userId = 1, symbol = '') {
    try {
      return db.prepare(`
        SELECT trans_date, trans_code, quantity, amount, is_buy
        FROM trades
        WHERE is_option = 1 AND user_id = ? AND symbol = ?
          AND trans_code IN ('OEXP', 'OASGN', 'OEXC')
        ORDER BY trans_date ASC LIMIT 1
      `).get(userId, symbol)
    } catch (error) {
      return null
    }
  }

  // Get positions for specific symbols computed from trades
  getPositionsForSymbols(symbols, userId = 1) {
    try {
      if (!symbols.length) return {}
      const placeholders = symbols.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT symbol, SUM(CASE WHEN is_buy = 1 THEN quantity ELSE -quantity END) AS position
        FROM trades
        WHERE is_option = 0 AND symbol IN (${placeholders}) AND user_id = ?
        GROUP BY symbol
        HAVING position > 0
      `)
      const rows = stmt.all(...symbols, userId)
      const result = {}
      rows.forEach(r => { result[r.symbol] = r.position })
      return result
    } catch (error) {
      console.error('Error getting positions:', error)
      return {}
    }
  }

  // Get stock positions as of a specific date (for historical share counts)
  getPositionsAsOf(userId = 1, dateStr, broker = null) {
    try {
      const stmt = db.prepare(`
        SELECT symbol, SUM(CASE WHEN is_buy = 1 THEN quantity ELSE -quantity END) AS position
        FROM trades
        WHERE is_option = 0 AND user_id = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
          AND trans_date <= ?
        GROUP BY symbol
        HAVING position > 0
      `)
      const rows = stmt.all(...[userId, ...(broker ? [broker] : []), dateStr])
      const result = {}
      rows.forEach(r => { result[r.symbol] = r.position })
      return result
    } catch (error) {
      console.error('Error getting positions as of date:', error)
      return {}
    }
  }

  // Get all stock positions computed from trades (net shares = buys - sells)
  getAllPositions(userId = 1, broker = null) {
    try {
      const stmt = db.prepare(`
        SELECT symbol, SUM(CASE WHEN is_buy = 1 THEN quantity ELSE -quantity END) AS position
        FROM trades
        WHERE is_option = 0 AND user_id = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        GROUP BY symbol
        HAVING position > 0
      `)
      const rows = stmt.all(...[userId, ...(broker ? [broker] : [])])
      const result = {}
      rows.forEach(r => { result[r.symbol] = r.position })
      return result
    } catch (error) {
      console.error('Error getting all positions:', error)
      return {}
    }
  }

  getThisWeekStockSells(userId, since, symbols, broker = null) {
    if (!symbols || symbols.length === 0) return {}
    try {
      const placeholders = symbols.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT symbol,
          SUM(quantity) AS shares_sold,
          SUM(ABS(amount)) AS total_proceeds
        FROM trades
        WHERE is_option = 0 AND is_buy = 0 AND user_id = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
          AND trans_date >= ?
          AND symbol IN (${placeholders})
        GROUP BY symbol
      `).all(...[userId, ...(broker ? [broker] : []), since, ...symbols])
      const result = {}
      rows.forEach(r => {
        result[r.symbol] = { sharesSold: r.shares_sold, avgPrice: r.shares_sold > 0 ? r.total_proceeds / r.shares_sold : 0 }
      })
      return result
    } catch (e) {
      console.error('Error getting this week stock sells:', e)
      return {}
    }
  }

  // Get net stock activity within a date range — used to detect positions started mid-week.
  // Returns netChange (buys - sells) and avgBuyPrice. Only trigger mid-week P&L when
  // netChange >= 100, so buy-and-sell-same-week (assignments that were quickly sold) are excluded.
  getStockBuysInPeriod(userId, fromDateExclusive, toDateInclusive, symbols, broker = null) {
    if (!symbols || symbols.length === 0) return {}
    try {
      const placeholders = symbols.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT symbol,
          SUM(CASE WHEN is_buy = 1 THEN quantity ELSE -quantity END) AS net_change,
          SUM(CASE WHEN is_buy = 1 THEN quantity ELSE 0 END) AS shares_bought,
          SUM(CASE WHEN is_buy = 1 THEN ABS(amount) ELSE 0 END) AS total_cost
        FROM trades
        WHERE is_option = 0 AND user_id = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
          AND trans_date > ? AND trans_date <= ?
          AND symbol IN (${placeholders})
        GROUP BY symbol
      `).all(...[userId, ...(broker ? [broker] : []), fromDateExclusive, toDateInclusive, ...symbols])
      const result = {}
      rows.forEach(r => {
        result[r.symbol] = {
          netChange: r.net_change,
          sharesBought: r.shares_bought,
          avgPrice: r.shares_bought > 0 ? r.total_cost / r.shares_bought : 0
        }
      })
      return result
    } catch (e) {
      console.error('Error getting stock buys in period:', e)
      return {}
    }
  }

  getOpenOptionPositions(userId = 1, broker = null) {
    const rows = db.prepare(`
      SELECT
        symbol,
        SUM(CASE WHEN trans_code = 'BTO' THEN COALESCE(contracts, 1) ELSE 0 END) as bto_contracts,
        SUM(CASE WHEN trans_code = 'STO' THEN COALESCE(contracts, 1) ELSE 0 END) as sto_contracts,
        SUM(CASE WHEN trans_code = 'STC' THEN COALESCE(contracts, 1) ELSE 0 END) as stc_contracts,
        SUM(CASE WHEN trans_code = 'BTC' THEN COALESCE(contracts, 1) ELSE 0 END) as btc_contracts,
        -- Settlements are kept apart from STC because they can close EITHER side.
        -- Counting them as long closes only, as before, left an expired short
        -- open for good.
        SUM(CASE WHEN trans_code IN ('OEXP', 'OASGN', 'OEXC') THEN COALESCE(contracts, 1) ELSE 0 END) as settled_contracts,
        SUM(CASE WHEN trans_code = 'BTO' THEN amount ELSE 0 END) as total_paid,
        SUM(CASE WHEN trans_code = 'STO' THEN amount ELSE 0 END) as total_received,
        MAX(trans_date) as last_trade_date
      FROM trades
      WHERE is_option = 1 AND user_id = ?
        ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
      GROUP BY symbol
    `).all(...[userId, ...(broker ? [broker] : [])])

    return rows
      .map(r => {
        // A settlement closes whichever side is actually open. The quantity's
        // "1S" suffix looks like it marks a short, but 405 of 413 sit on
        // contracts opened with BTO, so it can't be trusted for direction —
        // matching the contract and closing the open side is what holds.
        // Longs first, since an expiring long is the common case, then any
        // remainder against the short side.
        const longOpen = (r.bto_contracts || 0) - (r.stc_contracts || 0)
        const shortOpen = (r.sto_contracts || 0) - (r.btc_contracts || 0)
        const settled = r.settled_contracts || 0
        const settleLong = Math.min(settled, Math.max(0, longOpen))
        const settleShort = Math.min(settled - settleLong, Math.max(0, shortOpen))
        return {
          symbol: r.symbol,
          net_long: longOpen - settleLong,
          net_short: shortOpen - settleShort,
          bto_contracts: r.bto_contracts || 0,
          sto_contracts: r.sto_contracts || 0,
          total_paid: r.total_paid || 0,
          total_received: r.total_received || 0,
          last_trade_date: r.last_trade_date,
        }
      })
      .filter(r => r.net_long > 0 || r.net_short > 0)
  }

  // Returns all option trades (including contracts count) without GROUP BY dedup for accurate LIFO
  getRawStockTrades(userId = 1) {
    try {
      return db.prepare(`
        SELECT symbol, trans_code, quantity, price, amount, is_buy, is_option
        FROM trades WHERE user_id = ? AND (is_option = 0 OR is_option IS NULL)
        ORDER BY trans_date DESC LIMIT 20
      `).all(userId)
    } catch (e) {
      return [{ error: e.message }]
    }
  }

  /**
   * Open stock positions with the cost basis of the shares STILL HELD.
   *
   * This used to average every buy ever made, which is only right for someone
   * who bought and held. Trading in and out wrecks it: NFLX was day-traded
   * around $1,200 before its 10:1, closed out, then rebought at ~$75 — and the
   * lifetime average reported $188.27 against a $76 price, a phantom -$11,460.
   * RDDT read $198.55 where the shares held cost $155.69. Across ten positions
   * the error came to about $27,000, and it was the whole reason stock P&L and
   * every figure built on it looked wrong.
   *
   * Robinhood sells FIFO, so what remains is the most RECENT shares bought.
   * Cost is taken by walking buys newest-first until the open position is
   * covered. Deriving it that way rather than draining a lot queue forward
   * matters because an export starts mid-history: earlier sells can exceed the
   * buys on file, and a forward pass would either go negative or, if clamped,
   * strand lots and overstate the position (PLTR read 351 against an actual
   * 300 that way).
   */
  /**
   * @param method
   *   'moving'  — moving average, what a broker shows: a sale removes shares at
   *               the running average, so shares that are gone stop counting.
   *   'fifo'    — the actual cost of the specific shares still held.
   *   'average' — a lifetime average of every buy ever made. Kept only for
   *               callers that were calibrated on it; it never forgets a closed
   *               position, which is how PLTR read $160.32 against a broker's
   *               $132.19.
   */
  getStockPositionsWithCost(userId = 1, asOf = null, broker = null, method = 'average') {
    try {
      // Individual rows, not aggregates: FIFO needs each buy's own price, and
      // the split factor depends on each row's date.
      const rows = db.prepare(`
        SELECT symbol, trans_date, is_buy,
               COALESCE(quantity,0) AS qty,
               ABS(COALESCE(amount,0)) AS amt
        FROM trades
        WHERE (is_option = 0 OR is_option IS NULL) AND user_id = ?
          ${asOf ? 'AND trans_date <= ?' : ''}
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        ORDER BY trans_date ASC
      `).all(...[userId, ...(asOf ? [asOf] : []), ...(broker ? [broker] : [])])

      const splits = this.getSplits([...new Set(rows.map(r => r.symbol))])
      const acc = {}
      rows.forEach(r => {
        // A pre-split buy is recorded in pre-split terms: 1 NFLX share at
        // $1,200 became 10 at $120. Share counts scale, the cash paid does not.
        const f = this.splitFactor(splits[r.symbol], r.trans_date)
        const qty = (r.qty || 0) * f
        if (!(qty > 0)) return
        const a = acc[r.symbol] || (acc[r.symbol] = { position: 0, buys: [], ordered: [], boughtQty: 0, boughtCost: 0 })
        // Buys AND sells in order, which the moving average needs — it has to
        // see each sale to know what to forget.
        a.ordered.push({ isBuy: r.is_buy === 1, qty, amt: r.amt || 0 })
        if (r.is_buy === 1) {
          a.position += qty
          a.buys.push({ qty, perShare: (r.amt || 0) / qty })
          a.boughtQty += qty
          a.boughtCost += (r.amt || 0)     // cash paid is unchanged by a split
        } else {
          a.position -= qty
        }
      })

      const result = {}
      Object.entries(acc).forEach(([symbol, a]) => {
        const position = Math.round(a.position * 1e6) / 1e6
        if (!(position > 0)) return

        let avgCost = 0
        if (method === 'moving') {
          // Moving average — what a broker shows as "average cost".
          //
          // A sale removes shares AT the running average, so it leaves the
          // average untouched and the shares that are gone stop influencing it.
          // The lifetime average this replaced never forgot anything: PLTR read
          // $160.32 against a broker's $132.19, because buys from positions
          // closed months ago were still weighing on shares held today.
          //
          // A sale bigger than the shares on file empties the position rather
          // than going negative — an export starts mid-history, so those shares
          // were bought before it and there is no cost to carry forward.
          let sh = 0, cost = 0
          for (const b of a.ordered) {
            if (b.isBuy) { sh += b.qty; cost += b.amt }
            else if (sh > 0) {
              const take = Math.min(b.qty, sh)
              cost -= (cost / sh) * take
              sh -= take
              if (sh <= 1e-9) { sh = 0; cost = 0 }
            }
          }
          avgCost = sh > 1e-9 ? Math.round((cost / sh) * 100) / 100 : 0
          // The share COUNT still comes from netting, which handles a mid-history
          // export correctly; only the cost comes from this walk.
        } else if (method === 'fifo') {
          // Newest buys first, taking only as many shares as are still held.
          let need = position, cost = 0
          for (let i = a.buys.length - 1; i >= 0 && need > 1e-9; i--) {
            const take = Math.min(a.buys[i].qty, need)
            cost += take * a.buys[i].perShare
            need -= take
          }
          // `need` left over means the open shares predate the imported history,
          // so price what's known and let the rest fall back to that same average
          // rather than reporting a basis of zero.
          const covered = position - need
          avgCost = covered > 1e-9 ? Math.round((cost / covered) * 100) / 100 : 0
        } else {
          avgCost = a.boughtQty > 0 ? Math.round((a.boughtCost / a.boughtQty) * 100) / 100 : 0
        }
        result[symbol] = { position, avgCost }
      })
      console.log(`getStockPositionsWithCost: ${Object.keys(result).length} stock positions for user ${userId}`)
      return result
    } catch (e) {
      console.error('Error getting stock positions with cost:', e)
      return {}
    }
  }

  // Realized stock P&L per symbol (average-cost method), INCLUDING fully-closed positions.
  // Uses quantity × price (matching the Dashboard's calculation) so the two agree.
  // realized = sell proceeds − avgCost × shares sold, where avgCost = total buy cost / total shares bought.
  // For a fully-closed position this equals sells − buys, matching the Dashboard's realized P&L.
  // `overrides` is an optional { SYMBOL: avgCost } map; when present for a symbol, the
  // manual cost basis is used instead of the computed average cost.
  getStockRealizedPnL(userId = 1, overrides = {}, asOf = null) {
    try {
      const rows = db.prepare(`
        SELECT
          symbol,
          SUM(CASE WHEN is_buy = 1 THEN COALESCE(quantity,0) ELSE 0 END) AS total_bought,
          SUM(CASE WHEN is_buy = 1 THEN COALESCE(quantity,0) * COALESCE(price,0) ELSE 0 END) AS total_buy_cost,
          SUM(CASE WHEN is_buy = 0 THEN COALESCE(quantity,0) ELSE 0 END) AS total_sold,
          SUM(CASE WHEN is_buy = 0 THEN COALESCE(quantity,0) * COALESCE(price,0) ELSE 0 END) AS total_sell_proceeds
        FROM trades
        WHERE (is_option = 0 OR is_option IS NULL) AND user_id = ?
          ${asOf ? 'AND trans_date <= ?' : ''}
        GROUP BY symbol
      `).all(...(asOf ? [userId, asOf] : [userId]))
      const result = {}
      rows.forEach(r => {
        if (r.total_sold > 0 && r.total_bought > 0) {
          const computedAvg = r.total_buy_cost / r.total_bought
          const avgCost = overrides[r.symbol] > 0 ? overrides[r.symbol] : computedAvg
          result[r.symbol] = Math.round((r.total_sell_proceeds - avgCost * r.total_sold) * 100) / 100
        }
      })
      return result
    } catch (e) {
      console.error('Error getting stock realized P&L:', e)
      return {}
    }
  }

  /**
   * Manual avg-cost overrides as { SYMBOL: cost }.
   *
   * With a broker, returns that broker's overrides. Without one (the merged
   * view) a symbol overridden at two brokers has no single right answer, so
   * each broker's effective cost is weighted by the shares held there — the
   * same rule the cross-broker P&L merge uses. A broker with no override
   * contributes its actual computed cost, so overriding one broker doesn't
   * silently rewrite the other's basis.
   */
  getCostOverrides(userId = 1, broker = null) {
    try {
      if (broker) {
        const rows = db.prepare(
          `SELECT symbol, avg_cost FROM stock_cost_overrides
           WHERE user_id = ? AND COALESCE(broker,'robinhood') = ?`
        ).all(userId, broker)
        return Object.fromEntries(rows.map(r => [r.symbol, r.avg_cost]))
      }

      const rows = db.prepare(
        `SELECT symbol, COALESCE(broker,'robinhood') AS broker, avg_cost
         FROM stock_cost_overrides WHERE user_id = ?`
      ).all(userId)
      if (!rows.length) return {}

      // Only symbols that actually carry an override need blending.
      const symbols = [...new Set(rows.map(r => r.symbol))]
      const blended = {}
      for (const symbol of symbols) {
        const perBroker = db.prepare(
          `SELECT COALESCE(broker,'robinhood') AS broker,
                  SUM(CASE WHEN is_buy = 1 THEN COALESCE(quantity,0) ELSE -COALESCE(quantity,0) END) AS position,
                  SUM(CASE WHEN is_buy = 1 THEN ABS(COALESCE(amount,0)) ELSE 0 END) AS total_cost,
                  SUM(CASE WHEN is_buy = 1 THEN COALESCE(quantity,0) ELSE 0 END) AS total_bought
           FROM trades
           WHERE user_id = ? AND symbol = ? AND (is_option = 0 OR is_option IS NULL)
           GROUP BY COALESCE(broker,'robinhood')
           HAVING position > 0`
        ).all(userId, symbol)

        let shares = 0, cost = 0
        for (const b of perBroker) {
          const override = rows.find(r => r.symbol === symbol && r.broker === b.broker)?.avg_cost
          const actual = b.total_bought > 0 ? b.total_cost / b.total_bought : 0
          const effective = override != null ? override : actual
          shares += b.position
          cost += effective * b.position
        }
        if (shares > 0) blended[symbol] = Math.round((cost / shares) * 100) / 100
      }
      return blended
    } catch (e) {
      console.error('Error getting cost overrides:', e)
      return {}
    }
  }

  setCostOverride(userId = 1, symbol, avgCost, broker = 'robinhood') {
    db.prepare(`
      INSERT INTO stock_cost_overrides (user_id, symbol, broker, avg_cost, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
      ON CONFLICT(user_id, symbol, broker) DO UPDATE SET avg_cost = excluded.avg_cost, updated_at = excluded.updated_at
    `).run(userId, symbol.toUpperCase(), broker, avgCost)
  }

  deleteCostOverride(userId = 1, symbol, broker = 'robinhood') {
    db.prepare(
      `DELETE FROM stock_cost_overrides WHERE user_id = ? AND symbol = ? AND COALESCE(broker,'robinhood') = ?`
    ).run(userId, symbol.toUpperCase(), broker)
  }

  getOptionTradesForYTD(userId = 1) {
    try {
      return db.prepare(`
        SELECT trans_date, trans_code, symbol, quantity, price, amount, is_buy,
               COALESCE(contracts, 1) as contracts, COALESCE(broker,'robinhood') as broker
        FROM trades
        WHERE is_option = 1 AND user_id = ?
        -- broker is in the GROUP BY too: the same contract traded at two
        -- brokers on the same day is two positions, not one.
        GROUP BY trans_date, symbol, trans_code, is_buy, amount, COALESCE(broker,'robinhood')
        ORDER BY trans_date ASC, id ASC
      `).all(userId)
    } catch (e) {
      console.error('Error getting option trades for YTD:', e)
      return []
    }
  }

  // Raw (ungrouped) option trades for one ticker — for diagnosing premium/P&L issues.
  getRawOptionTradesForTicker(userId = 1, ticker = '') {
    try {
      return db.prepare(`
        SELECT trans_date, trans_code, symbol, quantity, price, amount, is_buy, contracts
        FROM trades
        WHERE is_option = 1 AND user_id = ? AND symbol LIKE ?
        ORDER BY trans_date ASC, id ASC
      `).all(userId, `${ticker}%`)
    } catch (e) {
      console.error('Error getting raw option trades:', e)
      return []
    }
  }

  // Short call entry helpers
  getShortCallEntries(userId = 1, broker = null) {
    try {
      if (broker) {
        return db.prepare(`
          SELECT * FROM short_call_entries
          WHERE user_id = ? AND COALESCE(broker,'robinhood') = ?
          ORDER BY sale_date DESC, ticker ASC
        `).all(userId, broker)
      }
      return db.prepare(`
        SELECT * FROM short_call_entries WHERE user_id = ? ORDER BY sale_date DESC, ticker ASC
      `).all(userId)
    } catch (e) {
      console.error('Error getting short call entries:', e)
      return []
    }
  }

  upsertShortCallEntry(userId, { symbol, ticker, strike, expiry, contracts, premium, saleDate, underlyingClose, broker = 'robinhood' }) {
    try {
      return db.prepare(`
        INSERT INTO short_call_entries (user_id, symbol, ticker, strike, expiry, contracts, premium, sale_date, underlying_close, broker)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, symbol, sale_date) DO UPDATE SET
          -- Keep the stored value (incl. manual overrides) if present; only fill from the
          -- auto-fetched price when nothing is stored yet. Otherwise a CSV re-upload would
          -- wipe the user's manual "Stock @ Sale" edit.
          underlying_close = COALESCE(short_call_entries.underlying_close, excluded.underlying_close),
          premium = excluded.premium,
          contracts = excluded.contracts
      `).run(userId, symbol, ticker, strike, expiry, contracts, premium, saleDate, underlyingClose ?? null, broker)
    } catch (e) {
      console.error('Error upserting short call entry:', e)
    }
  }

  /** Every stock trade in one symbol, oldest first. */
  getTradesForStockSymbol(userId, symbol, broker = null) {
    try {
      return db.prepare(`
        SELECT trans_date, trans_code, quantity, price, amount, is_buy
        FROM trades
        WHERE user_id = ? AND (is_option = 0 OR is_option IS NULL) AND symbol = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        ORDER BY trans_date ASC, id ASC
      `).all(...[userId, symbol, ...(broker ? [broker] : [])])
    } catch (e) {
      console.error('Error getting stock trades for symbol:', e)
      return []
    }
  }

  /** Every trade in one option contract, oldest first. */
  getTradesForOptionSymbol(userId, symbol, broker = null) {
    try {
      return db.prepare(`
        SELECT trans_date, trans_code, contracts, amount, price
        FROM trades
        WHERE user_id = ? AND is_option = 1 AND symbol = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        ORDER BY trans_date ASC, id ASC
      `).all(...[userId, symbol, ...(broker ? [broker] : [])])
    } catch (e) {
      console.error('Error getting trades for option symbol:', e)
      return []
    }
  }

  updateShortCallUnderlyingClose(id, underlyingClose) {
    try {
      return db.prepare(`UPDATE short_call_entries SET underlying_close = ? WHERE id = ?`).run(underlyingClose, id)
    } catch (e) {
      console.error('Error updating short call underlying close:', e)
    }
  }

  // Returns all STO-call trades from trades table (for rebuilding short_call_entries)
  getStoCallTrades(userId = 1) {
    try {
      return db.prepare(`
        SELECT trans_date, symbol, COALESCE(contracts, 1) as contracts, price, amount,
               COALESCE(broker,'robinhood') as broker
        FROM trades
        WHERE is_option = 1 AND user_id = ? AND trans_code = 'STO'
          AND (symbol LIKE '%Call%' OR description LIKE '%Call%')
        -- broker in the GROUP BY: the same call sold at two brokers on one day
        -- is two entries, not one.
        GROUP BY trans_date, symbol, price, amount, COALESCE(broker,'robinhood')
        ORDER BY trans_date ASC
      `).all(userId)
    } catch (e) {
      console.error('Error getting STO call trades:', e)
      return []
    }
  }

  // Record (upsert) a day's IV/HV snapshot for a ticker so IV Rank can build over time
  // App settings (key-value) — synced UI preferences (theme, background image, …)
  getAppSettings() {
    try {
      const rows = db.prepare('SELECT key, value FROM app_settings').all()
      const out = {}
      rows.forEach(r => { out[r.key] = r.value })
      return out
    } catch (e) { console.error('getAppSettings:', e.message); return {} }
  }

  setAppSetting(key, value) {
    try {
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, value == null ? null : String(value))
    } catch (e) { console.error('setAppSetting:', e.message) }
  }

  recordIV(ticker, snapDate, iv, hv30, stock) {
    try {
      if (!ticker || !snapDate || !(iv > 0)) return
      db.prepare(`
        INSERT INTO iv_history (ticker, snap_date, iv, hv30, stock)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ticker, snap_date) DO UPDATE SET iv = excluded.iv, hv30 = excluded.hv30, stock = excluded.stock
      `).run(ticker.toUpperCase(), snapDate, iv, hv30 ?? null, stock ?? null)
    } catch (e) {
      console.error('Error recording IV:', e.message)
    }
  }

  // IV history for a ticker since a date (ascending). Returns [{ snap_date, iv, hv30, stock }]
  getIVHistory(ticker, sinceDate) {
    try {
      return db.prepare(`
        SELECT snap_date, iv, hv30, stock FROM iv_history
        WHERE ticker = ? AND snap_date >= ?
        ORDER BY snap_date ASC
      `).all((ticker || '').toUpperCase(), sinceDate)
    } catch (e) {
      console.error('Error getting IV history:', e.message)
      return []
    }
  }

  // Upsert a full vol-scan row into the cache (for background universe scans)
  upsertVolScan(r) {
    try {
      if (!r || !r.ticker) return
      db.prepare(`
        INSERT INTO vol_scan_cache (ticker, stock, hv20, hv30, iv, iv_dte, iv_source, iv_hv_ratio, signal, iv_rank, iv_percentile, earnings_date, updated_at)
        VALUES (@ticker, @stock, @hv20, @hv30, @iv, @iv_dte, @iv_source, @iv_hv_ratio, @signal, @iv_rank, @iv_percentile, @earnings_date, strftime('%s','now'))
        ON CONFLICT(ticker) DO UPDATE SET
          stock=excluded.stock, hv20=excluded.hv20, hv30=excluded.hv30, iv=excluded.iv,
          iv_dte=excluded.iv_dte, iv_source=excluded.iv_source, iv_hv_ratio=excluded.iv_hv_ratio,
          signal=excluded.signal, iv_rank=excluded.iv_rank, iv_percentile=excluded.iv_percentile,
          earnings_date=excluded.earnings_date,
          updated_at=strftime('%s','now')
      `).run({
        ticker: r.ticker.toUpperCase(),
        stock: r.stock ?? null, hv20: r.hv20 ?? null, hv30: r.hv30 ?? null, iv: r.iv ?? null,
        iv_dte: r.ivDte ?? null, iv_source: r.ivSource ?? null, iv_hv_ratio: r.ivHvRatio ?? null,
        signal: r.signal ?? null, iv_rank: r.ivRank ?? null, iv_percentile: r.ivPercentile ?? null,
        earnings_date: r.earningsDate ?? null
      })
    } catch (e) { console.error('Error upserting vol scan:', e.message) }
  }

  // Cached next-earnings date per ticker (Nasdaq). Refreshed by the scanner when stale.
  getEarnings(ticker) {
    try { return db.prepare('SELECT earnings_date, updated_at FROM earnings_cache WHERE ticker = ?').get((ticker || '').toUpperCase()) || null }
    catch (e) { return null }
  }
  setEarnings(ticker, date) {
    try {
      db.prepare(`
        INSERT INTO earnings_cache (ticker, earnings_date, updated_at) VALUES (?, ?, strftime('%s','now'))
        ON CONFLICT(ticker) DO UPDATE SET earnings_date=excluded.earnings_date, updated_at=strftime('%s','now')
      `).run((ticker || '').toUpperCase(), date ?? null)
    } catch (e) { console.error('Error setting earnings:', e.message) }
  }

  // Get cached vol-scan rows for a set of tickers
  getVolScanCache(tickers) {
    try {
      if (!Array.isArray(tickers) || tickers.length === 0) return []
      const up = tickers.map(t => (t || '').toUpperCase())
      const ph = up.map(() => '?').join(',')
      return db.prepare(`SELECT * FROM vol_scan_cache WHERE ticker IN (${ph})`).all(...up)
    } catch (e) {
      console.error('Error getting vol scan cache:', e.message)
      return []
    }
  }

  // Close database connection
  close() {
    db.close()
  }

  // DCA alert schedule
  getDCASchedule(userId = 1) {
    return db.prepare('SELECT * FROM dca_schedule WHERE user_id = ? ORDER BY next_alert_date ASC').all(userId)
  }

  addDCASymbol(userId = 1, symbol, nextAlertDate) {
    return db.prepare('INSERT OR IGNORE INTO dca_schedule (user_id, symbol, next_alert_date) VALUES (?, ?, ?)').run(userId, symbol, nextAlertDate)
  }

  markDCABought(id, nextAlertDate) {
    return db.prepare('UPDATE dca_schedule SET next_alert_date = ? WHERE id = ?').run(nextAlertDate, id)
  }

  removeDCASymbol(id) {
    return db.prepare('DELETE FROM dca_schedule WHERE id = ?').run(id)
  }

  getStockOnlySymbols(userId = 1) {
    // Symbols with open stock positions that have NO options trades
    const optionSymbols = new Set(
      db.prepare('SELECT DISTINCT symbol FROM trades WHERE is_option = 1 AND user_id = ?').all(userId).map(r => r.symbol)
    )
    const stockPositions = this.getAllPositions(userId)
    return Object.keys(stockPositions).filter(sym => !optionSymbols.has(sym))
  }

  getAllUsers() {
    return db.prepare('SELECT id, username FROM users ORDER BY id').all()
  }

  // Save EOD price snapshot entries. entries: [{ symbol, closePrice, isOption, contracts }]
  saveDailyPriceSnapshot(userId, dateStr, entries) {
    const stmt = db.prepare(`
      INSERT INTO daily_price_snapshots (user_id, symbol, price_date, close_price, is_option, contracts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, symbol, price_date) DO UPDATE SET
        close_price = excluded.close_price,
        contracts = excluded.contracts,
        captured_at = strftime('%s', 'now')
    `)
    const run = db.transaction((rows) => { for (const e of rows) stmt.run(userId, e.symbol, dateStr, e.closePrice, e.isOption ? 1 : 0, e.contracts ?? null) })
    run(entries)
  }

  // Returns { stocks: { SYM: price }, options: { contractSym: { price, contracts } } }
  getDailyPriceSnapshot(userId, dateStr) {
    const rows = db.prepare(`SELECT symbol, close_price, is_option, contracts FROM daily_price_snapshots WHERE user_id = ? AND price_date = ?`).all(userId, dateStr)
    const stocks = {}
    const options = {}
    rows.forEach(r => {
      if (r.is_option) options[r.symbol] = { price: r.close_price, contracts: r.contracts }
      else stocks[r.symbol] = r.close_price
    })
    return { stocks, options }
  }

  hasDailyPriceSnapshot(userId, dateStr) {
    return db.prepare(`SELECT 1 FROM daily_price_snapshots WHERE user_id = ? AND price_date = ? LIMIT 1`).get(userId, dateStr) != null
  }

  // Returns list of dates (desc) that have daily price snapshots for a given user
  getDailySnapshotDates(userId, limit = 30) {
    return db.prepare(`SELECT DISTINCT price_date FROM daily_price_snapshots WHERE user_id = ? ORDER BY price_date DESC LIMIT ?`).all(userId, limit).map(r => r.price_date)
  }

  /**
   * Net cash in and out, split between stock and options.
   *
   * The building block for account P&L, which is simply cash flow plus what the
   * open positions are worth right now. That identity is why this exists:
   * realized + unrealized = proceeds + market value - total cost whichever way
   * cost basis is figured, so a total built this way cannot be thrown off by
   * FIFO versus average. It only ever moves when money moves or a price does.
   *
   * Amounts are stored absolute, so direction comes from the trans code. An
   * expiry carries no cash at all and contributes nothing here — what it did to
   * the position shows up in the market value instead.
   */
  /**
   * Money the broker charged or paid that isn't a trade.
   *
   * Margin interest is a real cost of running a leveraged book and it never
   * appears in trade P&L, so a position can look profitable while the borrowing
   * behind it quietly eats the gain. Reported separately rather than folded
   * into a total: it's a financing cost, not a trading result, and mixing them
   * makes both harder to read.
   *
   * Robinhood codes these MINT ("Aggregated Margin Rate"), GOLD (subscription)
   * and INT (interest paid TO you). Amounts are stored absolute, so the sign
   * comes from what the code means.
   */
  getFinancingCosts(userId = 1, broker = null) {
    try {
      const rows = db.prepare(`
        SELECT UPPER(COALESCE(trans_code,'')) AS code,
               COUNT(*) AS n,
               SUM(ABS(COALESCE(amount,0))) AS total
        FROM cash_activity
        WHERE user_id = ?
          AND UPPER(COALESCE(trans_code,'')) IN ('MINT','GOLD','INT')
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        GROUP BY code
      `).all(...[userId, ...(broker ? [broker] : [])])

      // Whether ANY cash activity exists for this user, which separates "no
      // margin was ever charged" from "nothing has been imported yet". Those
      // look identical as zeros and need opposite responses.
      let hasData = false
      try {
        const any = db.prepare(
          `SELECT 1 FROM cash_activity WHERE user_id = ? ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''} LIMIT 1`
        ).get(...[userId, ...(broker ? [broker] : [])])
        hasData = !!any
      } catch (e) { /* table may not exist yet on an old database */ }

      const by = Object.fromEntries(rows.map(r => [r.code, { n: r.n, total: Number(r.total) || 0 }]))
      const marginInterest = -(by.MINT?.total || 0)   // charged to you
      const subscription = -(by.GOLD?.total || 0)     // charged to you
      const interestEarned = by.INT?.total || 0       // paid to you
      return {
        hasData,
        marginInterest: round2(marginInterest),
        marginInterestCount: by.MINT?.n || 0,
        subscription: round2(subscription),
        interestEarned: round2(interestEarned),
        net: round2(marginInterest + subscription + interestEarned),
      }
    } catch (e) {
      console.error('Error getting financing costs:', e)
      return { hasData: false, marginInterest: 0, marginInterestCount: 0, subscription: 0, interestEarned: 0, net: 0 }
    }
  }

  /**
   * Persist dividends, interest, margin and fees from an upload.
   *
   * UNIQUE on the whole row so re-uploading an overlapping export doesn't
   * double-count a charge — these have no order id to dedupe on, and the same
   * margin charge appearing twice would quietly double the reported cost.
   */
  saveCashActivity(userId, rows = [], broker = 'robinhood') {
    if (!rows.length) return 0
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO cash_activity
        (user_id, trans_date, trans_code, symbol, amount, description, broker)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    let n = 0
    const run = db.transaction(list => {
      list.forEach(r => {
        const code = String(r.transCode || '').toUpperCase()
        if (!code) return
        const date = r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date || r.transDate || '').slice(0, 10)
        if (!date) return
        n += stmt.run(userId, date, code, r.symbol || null,
          Math.abs(Number(r.amount) || 0), r.description || null, broker).changes || 0
      })
    })
    try { run(rows) } catch (e) { console.error('Error saving cash activity:', e) }
    return n
  }

  getCashFlows(userId = 1, broker = null) {
    try {
      const r = db.prepare(`
        SELECT
          SUM(CASE WHEN COALESCE(is_option,0) = 0
                   THEN (CASE WHEN is_buy = 1 THEN -ABS(COALESCE(amount,0)) ELSE ABS(COALESCE(amount,0)) END)
                   ELSE 0 END) AS stock_cash,
          SUM(CASE WHEN COALESCE(is_option,0) = 1
                   THEN (CASE WHEN UPPER(COALESCE(trans_code,'')) IN ('BTO','BTC') THEN -ABS(COALESCE(amount,0))
                              WHEN UPPER(COALESCE(trans_code,'')) IN ('STO','STC') THEN  ABS(COALESCE(amount,0))
                              ELSE 0 END)
                   ELSE 0 END) AS option_cash
        FROM trades
        WHERE user_id = ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
      `).get(...[userId, ...(broker ? [broker] : [])])
      return {
        stockCash: r?.stock_cash || 0,
        optionCash: r?.option_cash || 0,
      }
    } catch (e) {
      console.error('Error getting cash flows:', e)
      return { stockCash: 0, optionCash: 0 }
    }
  }

  // ── Share transfers ─────────────────────────────────────────────────────
  // UNIQUE on the whole row, so re-importing the same export doesn't stack up
  // duplicate journals the way a second upload otherwise would.
  saveShareTransfers(userId, transfers = []) {
    if (!transfers.length) return 0
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO share_transfers
        (user_id, broker, symbol, transfer_date, quantity, direction, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    let n = 0
    const run = db.transaction(list => {
      list.forEach(t => {
        if (!t?.symbol || !(t.quantity > 0)) return
        const r = stmt.run(
          userId, t.broker || 'robinhood', String(t.symbol).toUpperCase(),
          t.date, t.quantity, t.direction === 'out' ? 'out' : 'in', t.description || null
        )
        n += r.changes || 0
      })
    })
    try { run(transfers) } catch (e) { console.error('Error saving share transfers:', e) }
    return n
  }

  getShareTransfers(userId = 1, broker = null) {
    try {
      return db.prepare(`
        SELECT broker, symbol, transfer_date, quantity, direction, description
        FROM share_transfers
        WHERE user_id = ?
          ${broker ? 'AND broker = ?' : ''}
        ORDER BY transfer_date ASC
      `).all(...[userId, ...(broker ? [broker] : [])])
    } catch (e) {
      console.error('Error getting share transfers:', e)
      return []
    }
  }

  /**
   * Dates on which this stock closed near a given price, from the snapshots.
   *
   * ONLY the price and the date are taken from the snapshot row. Its P&L
   * columns are deliberately ignored: they were written by the calculator as it
   * stood at the time, which counted Buy-to-Cover as a sale, never booked an
   * expiry, and averaged cost over every buy ever made. Reading them back would
   * be comparing today's corrected figure against yesterday's buggy one — MRVL
   * came out at +$6,400 on a day that was nothing like it.
   *
   * The caller recomputes the P&L for these dates from the trades, which is the
   * only basis that agrees with what's on screen now.
   */
  getPriceVisits(userId, symbol, targetPrice, { bandPct = 2, limit = 4, excludeDays = 5 } = {}) {
    try {
      const price = Number(targetPrice)
      if (!(price > 0)) return []
      const low = price * (1 - bandPct / 100)
      const high = price * (1 + bandPct / 100)

      const rows = db.prepare(`
        SELECT asof_date, current_price
        FROM pnl_snapshots
        WHERE user_id = ? AND symbol = ?
          AND current_price BETWEEN ? AND ?
          AND asof_date <= date('now', ?)
        ORDER BY asof_date DESC
      `).all(userId, String(symbol).toUpperCase(), low, high, `-${excludeDays} days`)

      // One per day, closest to the target — several rows from one day are one
      // visit, and would otherwise fill the list with a single afternoon.
      const byDay = new Map()
      for (const r of rows) {
        const day = String(r.asof_date).slice(0, 10)
        const prev = byDay.get(day)
        if (!prev || Math.abs(r.current_price - price) < Math.abs(prev.current_price - price)) {
          byDay.set(day, r)
        }
      }
      return [...byDay.values()]
        .sort((a, b) => String(b.asof_date).localeCompare(String(a.asof_date)))
        .slice(0, limit)
        .map(r => ({ date: String(r.asof_date).slice(0, 10), price: round2(r.current_price) }))
    } catch (e) {
      console.error('Error finding price visits:', e)
      return []
    }
  }

  /**
   * Stock position and realized stock P&L as of a date, from the trades.
   *
   * Same FIFO basis as the live figures, so a comparison across dates is
   * measuring the position rather than a change of method.
   */
  getStockStateAsOf(userId, symbol, asOfDate, broker = null) {
    try {
      const rows = db.prepare(`
        SELECT trans_date, is_buy, COALESCE(quantity,0) AS qty, ABS(COALESCE(amount,0)) AS amt
        FROM trades
        WHERE (is_option = 0 OR is_option IS NULL) AND user_id = ? AND symbol = ?
          AND trans_date <= ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        ORDER BY trans_date ASC
      `).all(...[userId, String(symbol).toUpperCase(), asOfDate, ...(broker ? [broker] : [])])

      const splits = this.getSplits([String(symbol).toUpperCase()])
      let position = 0, realized = 0
      const buys = []
      let soldQty = 0, soldProceeds = 0, boughtQty = 0, boughtCost = 0

      for (const r of rows) {
        const f = this.splitFactor(splits[String(symbol).toUpperCase()], r.trans_date)
        const qty = (r.qty || 0) * f
        if (!(qty > 0)) continue
        if (r.is_buy === 1) {
          position += qty
          buys.push({ qty, perShare: (r.amt || 0) / qty })
          boughtQty += qty; boughtCost += (r.amt || 0)
        } else {
          position -= qty
          soldQty += qty; soldProceeds += (r.amt || 0)
        }
      }
      if (soldQty > 0 && boughtQty > 0) {
        realized = soldProceeds - (boughtCost / boughtQty) * soldQty
      }

      // Cost of the shares still held, newest first — the same rule the live
      // panel uses.
      let need = position, cost = 0
      for (let i = buys.length - 1; i >= 0 && need > 1e-9; i--) {
        const take = Math.min(buys[i].qty, need)
        cost += take * buys[i].perShare
        need -= take
      }
      const covered = position - need
      return {
        position: Math.round(position * 1e6) / 1e6,
        avgCost: covered > 1e-9 ? round2(cost / covered) : 0,
        realized: round2(realized),
      }
    } catch (e) {
      console.error('Error getting stock state as of:', e)
      return { position: 0, avgCost: 0, realized: 0 }
    }
  }

  /**
   * Realized OPTION P&L for one underlying up to a date, LIFO-matched.
   *
   * Open contracts are not valued: a past option mark can't be recovered, and
   * modelling one would turn a measurement into a guess. The caller says so
   * rather than folding an estimate into the total.
   */
  getOptionRealizedAsOf(userId, ticker, asOfDate, broker = null, fromDate = null) {
    try {
      // Bounded BELOW as well as above. The panel's Options Total only counts
      // closes inside the selected period, so summing all-time here made the
      // comparison read far too high — every option ever closed, against a
      // column showing only this period's.
      //
      // Lots still OPEN at fromDate are built from trades before it, so the
      // stack is filled from the whole history and only CLOSES inside the
      // window are counted. Starting the stack at fromDate would leave closes
      // with nothing to match against and silently drop them.
      const rows = db.prepare(`
        SELECT symbol, trans_date, trans_code, COALESCE(contracts,1) AS contracts, ABS(COALESCE(amount,0)) AS amt
        FROM trades
        WHERE is_option = 1 AND user_id = ? AND trans_date <= ?
          ${broker ? "AND COALESCE(broker,'robinhood') = ?" : ''}
        ORDER BY trans_date ASC
      `).all(...[userId, asOfDate, ...(broker ? [broker] : [])])

      const want = String(ticker).toUpperCase()
      const stacks = {}
      let realized = 0

      for (const r of rows) {
        const sym = String(r.symbol || '')
        // Cheap prefix match on the underlying, which is how these descriptions
        // are shaped ("MRVL 8/15/2026 Call $90.00").
        if (!sym.toUpperCase().startsWith(want + ' ')) continue
        const tc = String(r.trans_code || '').toUpperCase()
        const n = Math.abs(r.contracts || 1)
        const ppc = n > 0 ? r.amt / n : r.amt
        if (!stacks[sym]) stacks[sym] = { long: [], short: [] }
        const st = stacks[sym]

        if (tc === 'BTO') st.long.push({ ppc, left: n })
        else if (tc === 'STO') st.short.push({ ppc, left: n })
        else if (['STC', 'BTC', 'OEXP', 'OASGN', 'OEXC'].includes(tc)) {
          const closingShort = tc === 'BTC'
          const stack = closingShort ? st.short : st.long
          let remaining = n
          while (remaining > 0 && stack.length > 0) {
            const lot = stack[stack.length - 1]
            const take = Math.min(lot.left, remaining)
            const openVal = lot.ppc * take
            const closeVal = ppc * take
            const pnl = closingShort ? (openVal - closeVal) : (closeVal - openVal)
            // Only closes inside the window count toward the figure, though the
            // lots themselves are tracked across the whole history.
            if (!fromDate || String(r.trans_date) >= fromDate) realized += pnl
            lot.left -= take; remaining -= take
            if (lot.left <= 0) stack.pop()
          }
        }
      }
      return round2(realized)
    } catch (e) {
      console.error('Error getting option realized as of:', e)
      return 0
    }
  }

  // ── Per-user view preferences ───────────────────────────────────────────
  getPreferences(userId) {
    try {
      const rows = db.prepare('SELECT pref_key, value FROM user_preferences WHERE user_id = ?').all(userId)
      const out = {}
      rows.forEach(r => {
        // Stored as JSON. A malformed row shouldn't take the whole set down —
        // one bad preference would otherwise blank every panel at once.
        try { out[r.pref_key] = JSON.parse(r.value) } catch { /* skip */ }
      })
      return out
    } catch (e) {
      console.error('Error getting preferences:', e)
      return {}
    }
  }

  setPreference(userId, key, value) {
    try {
      db.prepare(`
        INSERT INTO user_preferences (user_id, pref_key, value, updated_at)
        VALUES (?, ?, ?, strftime('%s','now'))
        ON CONFLICT(user_id, pref_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(userId, String(key), JSON.stringify(value))
      return true
    } catch (e) {
      console.error('Error saving preference:', e)
      return false
    }
  }

  deletePreference(userId, key) {
    try {
      return db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND pref_key = ?')
        .run(userId, String(key)).changes || 0
    } catch (e) {
      console.error('Error deleting preference:', e)
      return 0
    }
  }

  // ── Stock splits ────────────────────────────────────────────────────────
  /**
   * Split adjustment is ON unless SPLIT_ADJUSTMENT=off.
   *
   * It was switched off while wrong RDDT and PLTR share counts were being
   * chased. Splits turned out to be innocent — the cause was Buy-to-Cover rows
   * imported as sales — and leaving it off cost real accuracy: NFLX split 10:1
   * on 2025-11-17, so pre-split buys sat at a ~$188 average against a ~$76
   * price and reported roughly -$11,400 that was never lost.
   *
   * Back on by default, now that a stored reading is reconciled against Yahoo
   * on every refresh, an implausible ratio is refused, and a bad row can be
   * deleted outright. SPLIT_ADJUSTMENT=off still disables it, which reads
   * exactly as the app did before the feature landed: every factor is 1.
   */
  splitAdjustmentEnabled() {
    return String(process.env.SPLIT_ADJUSTMENT || 'on').toLowerCase() !== 'off'
  }

  // What the table actually holds, whatever the switch says. Inspection and
  // reconciliation need the real rows — hiding them from the diagnostic
  // endpoint would be the opposite of helpful.
  getSplitsRaw(symbols = null) {
    try {
      const rows = symbols?.length
        ? db.prepare(`SELECT symbol, split_date, ratio FROM stock_splits WHERE symbol IN (${symbols.map(() => '?').join(',')})`).all(...symbols)
        : db.prepare('SELECT symbol, split_date, ratio FROM stock_splits').all()
      const bySymbol = {}
      rows.forEach(r => {
        if (!bySymbol[r.symbol]) bySymbol[r.symbol] = []
        bySymbol[r.symbol].push({ date: r.split_date, ratio: r.ratio })
      })
      // Applied oldest-first so two splits compound correctly.
      Object.values(bySymbol).forEach(list => list.sort((a, b) => a.date.localeCompare(b.date)))
      return bySymbol
    } catch (e) {
      console.error('Error getting splits:', e)
      return {}
    }
  }

  // What the P&L math is allowed to apply. Empty while the switch is off, so
  // every factor comes out 1.
  getSplits(symbols = null) {
    if (!this.splitAdjustmentEnabled()) return {}
    return this.getSplitsRaw(symbols)
  }

  saveSplit(symbol, splitDate, ratio, source = 'yahoo') {
    try {
      db.prepare(`
        INSERT INTO stock_splits (symbol, split_date, ratio, source, updated_at)
        VALUES (?, ?, ?, ?, strftime('%s','now'))
        ON CONFLICT(symbol, split_date) DO UPDATE SET ratio = excluded.ratio, source = excluded.source, updated_at = excluded.updated_at
      `).run(String(symbol).toUpperCase(), splitDate, ratio, source)
    } catch (e) {
      console.error('Error saving split:', e)
    }
  }

  /**
   * Replace the Yahoo-sourced splits for one symbol with exactly what Yahoo
   * currently reports, and return how many stale rows were dropped.
   *
   * Without this the table was append-only: a single bad or transient reading
   * was written once and then applied to every share count forever, because
   * nothing ever removed a row. Share counts are MULTIPLIED by the ratio, so a
   * spurious split silently rewrites a position and its cost basis.
   *
   * Only ever called after a response that actually parsed — a failed fetch
   * must not be read as "Yahoo says there are no splits" and wipe real ones.
   * Hand-entered rows (source != 'yahoo') are left alone.
   */
  reconcileYahooSplits(symbol, confirmedDates) {
    try {
      const sym = String(symbol).toUpperCase()
      const keep = confirmedDates || []
      const stale = keep.length
        ? db.prepare(
            `DELETE FROM stock_splits
             WHERE symbol = ? AND COALESCE(source,'yahoo') = 'yahoo'
               AND split_date NOT IN (${keep.map(() => '?').join(',')})`
          ).run(sym, ...keep)
        : db.prepare(
            `DELETE FROM stock_splits WHERE symbol = ? AND COALESCE(source,'yahoo') = 'yahoo'`
          ).run(sym)
      return stale.changes || 0
    } catch (e) {
      console.error('Error reconciling splits:', e)
      return 0
    }
  }

  // Drop every split for a symbol, whatever its source — the manual escape
  // hatch when a bad ratio has already distorted a position.
  deleteSplitsForSymbol(symbol) {
    try {
      return db.prepare('DELETE FROM stock_splits WHERE symbol = ?')
        .run(String(symbol).toUpperCase()).changes || 0
    } catch (e) {
      console.error('Error deleting splits for symbol:', e)
      return 0
    }
  }

  deleteAllSplits() {
    try {
      return db.prepare('DELETE FROM stock_splits').run().changes || 0
    } catch (e) {
      console.error('Error deleting splits:', e)
      return 0
    }
  }

  /**
   * Cumulative factor for a trade dated `transDate`: the product of every split
   * that happened AFTER it. A pre-split share count is multiplied by this and a
   * pre-split per-share price divided by it.
   */
  splitFactor(splitsForSymbol, transDate) {
    if (!splitsForSymbol?.length || !transDate) return 1
    return splitsForSymbol.reduce((f, s) => (transDate < s.date ? f * s.ratio : f), 1)
  }

  // ── Closing implied vol per contract (for extended-hours repricing) ──
  saveOptionIvMark(userId, m) {
    return db.prepare(`
      INSERT INTO option_iv_marks
        (user_id, symbol, ticker, opt_type, strike, expiry, mark_date, close_mark, underlying_close, sigma, source)
      VALUES (@user_id, @symbol, @ticker, @opt_type, @strike, @expiry, @mark_date, @close_mark, @underlying_close, @sigma, @source)
      ON CONFLICT(user_id, symbol, mark_date) DO UPDATE SET
        close_mark = excluded.close_mark,
        underlying_close = excluded.underlying_close,
        sigma = excluded.sigma,
        source = excluded.source
    `).run({ user_id: userId, ...m })
  }

  /**
   * The mark history of one contract, oldest first.
   *
   * option_iv_marks records a closing mark per contract per day, captured for
   * the extended-hours estimate. It also happens to be a decay series: for a
   * sold call, the mark falling IS the premium being earned, and that's the
   * thing worth watching when a stock ranges.
   */
  getOptionMarkHistory(userId, symbol, days = 90) {
    try {
      return db.prepare(`
        SELECT mark_date, close_mark, underlying_close, sigma
        FROM option_iv_marks
        WHERE user_id = ? AND symbol = ?
          AND mark_date >= date('now', ?)
        ORDER BY mark_date ASC
      `).all(userId, symbol, `-${Math.max(1, days)} days`)
    } catch (e) {
      console.error('Error getting option mark history:', e)
      return []
    }
  }

  // Most recent calibration at or before asOfDate, one row per symbol.
  getLatestOptionIvMarks(userId, asOfDate = null) {
    const cutoff = asOfDate || '9999-12-31'
    return db.prepare(`
      SELECT m.* FROM option_iv_marks m
      JOIN (
        SELECT symbol, MAX(mark_date) AS mark_date
        FROM option_iv_marks
        WHERE user_id = ? AND mark_date <= ?
        GROUP BY symbol
      ) latest ON latest.symbol = m.symbol AND latest.mark_date = m.mark_date
      WHERE m.user_id = ?
    `).all(userId, cutoff, userId)
  }
}

export const databaseService = new DatabaseService()

// Export the database connection for use by other services (like auth)
export function getDatabase() {
  return db
}

// Shared rounding for the snapshot comparisons above. Null stays null — a
// missing figure and a zero mean different things on a P&L line.
function round2(n) {
  if (n == null) return null
  return Math.round(Number(n) * 100) / 100
}
