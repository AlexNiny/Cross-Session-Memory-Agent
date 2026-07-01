CREATE TABLE IF NOT EXISTS chat_turns (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  user_message TEXT NOT NULL,
  agent_response TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, turn_index),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_session
  ON chat_turns (user_id, session_id, turn_index);
