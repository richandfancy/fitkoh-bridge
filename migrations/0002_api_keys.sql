-- BAC-831: Public API v1 — API keys and meal cache

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hashed_key TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL, -- first 8 chars for display (fbk_1234)
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hashed_key);

CREATE TABLE IF NOT EXISTS poster_meals_cache (
  cache_key TEXT PRIMARY KEY,  -- "{posterClientId}:{date}"
  data TEXT NOT NULL,           -- JSON blob
  cached_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cache_age ON poster_meals_cache(cached_at);
