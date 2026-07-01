CREATE TABLE IF NOT EXISTS filecoin_session_keys (
  wallet_address TEXT PRIMARY KEY,
  private_key TEXT NOT NULL,
  session_key_address TEXT NOT NULL,
  authorized INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (wallet_address) REFERENCES users(wallet_address) ON DELETE CASCADE
);
