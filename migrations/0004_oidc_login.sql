-- Telegram Login (OpenID Connect): one-time nonces issued before the sign-in popup.
-- Only SHA-256 of the nonce is stored; a nonce is deleted when used or expired.
CREATE TABLE login_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_nonces_expiry ON login_nonces(expires_at);
