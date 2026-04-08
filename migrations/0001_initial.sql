-- FitKoh System Bridge — Initial Schema

CREATE TABLE IF NOT EXISTS bookings (
  clock_booking_id TEXT PRIMARY KEY,
  poster_client_id INTEGER,
  clock_folio_id TEXT,
  guest_name TEXT,
  room_number TEXT,
  check_in TEXT,
  check_out TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS synced_transactions (
  poster_transaction_id TEXT PRIMARY KEY,
  clock_booking_id TEXT NOT NULL REFERENCES bookings(clock_booking_id),
  clock_charge_id TEXT,
  amount_cents INTEGER,
  product_name TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  booking_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clock_booking_id TEXT,
  operation TEXT NOT NULL,
  error_message TEXT,
  payload TEXT,
  retries INTEGER DEFAULT 0,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(type);
CREATE INDEX IF NOT EXISTS idx_dead_letters_unresolved ON dead_letters(resolved) WHERE resolved = 0;
CREATE INDEX IF NOT EXISTS idx_synced_booking ON synced_transactions(clock_booking_id);
