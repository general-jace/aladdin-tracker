-- Aladdin-Style Tracker — D1 schema
-- Apply with: wrangler d1 execute aladdin-tracker-db --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  shares REAL DEFAULT 0,
  price REAL DEFAULT 0,
  weight REAL DEFAULT 0,
  asset_class TEXT DEFAULT 'Equity',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS returns_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'portfolio' or 'benchmark'
  period_index INTEGER NOT NULL,
  return_pct REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_kind ON returns_series(kind, period_index);

CREATE TABLE IF NOT EXISTS footprint_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date TEXT NOT NULL,
  source TEXT NOT NULL,
  aum REAL,
  inflows REAL,
  tech_rev REAL,
  net_income REAL,
  eps_diluted REAL,
  retention TEXT,
  stress_period TEXT,
  drawdown_note TEXT,
  notes TEXT,
  auto_fetched INTEGER DEFAULT 0,
  saved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_cache (
  ticker TEXT PRIMARY KEY,
  price REAL,
  as_of_date TEXT,
  fetched_at TEXT,
  source TEXT
);
