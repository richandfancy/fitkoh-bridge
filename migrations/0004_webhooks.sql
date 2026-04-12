CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  events TEXT NOT NULL,         -- JSON array: ["meal.ordered", "guest.synced"]
  secret TEXT NOT NULL,          -- HMAC-SHA256 signing secret
  description TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_triggered_at TEXT,
  last_status_code INTEGER,
  failure_count INTEGER DEFAULT 0
);
