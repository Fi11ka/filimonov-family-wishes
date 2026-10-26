-- «Открыть в браузере» from the Mini App: a one-time code (2 minutes) that the
-- website exchanges for a normal session. Only the SHA-256 of the code is stored.
CREATE TABLE login_handoffs (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_handoffs_expiry ON login_handoffs(expires_at);
