-- Track which Poster items have been auto-imported to FitKoh
CREATE TABLE IF NOT EXISTS auto_imported_items (
  id TEXT PRIMARY KEY,           -- "{posterClientId}:{transactionId}:{productIndex}"
  poster_client_id INTEGER NOT NULL,
  fitkoh_user_id INTEGER NOT NULL,
  fitkoh_menu_item_id INTEGER NOT NULL,
  poster_product_name TEXT,
  imported_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auto_import_client ON auto_imported_items(poster_client_id);
