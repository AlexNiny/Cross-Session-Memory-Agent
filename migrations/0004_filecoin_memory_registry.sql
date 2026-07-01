CREATE TABLE IF NOT EXISTS filecoin_memory_registry (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  dataset_id TEXT,
  provider_address TEXT,
  wallet_address TEXT NOT NULL,
  last_piece_cid TEXT,
  piece_count INTEGER NOT NULL DEFAULT 0,
  synced_turn_indexes TEXT NOT NULL DEFAULT '[]',
  batches TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_filecoin_memory_registry_wallet
  ON filecoin_memory_registry (wallet_address, session_id);
