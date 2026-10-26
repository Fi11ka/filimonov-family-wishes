-- Sign-in methods, separate from accounts: one account may later have several
-- (Telegram, other providers). Additive only: users keeps every column,
-- including username as a display/search copy, so the previous Worker version
-- still works after this migration (safe rollback).
CREATE TABLE identities (
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 20),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(provider, subject)
);
CREATE UNIQUE INDEX identities_username ON identities(provider, username) WHERE username IS NOT NULL;
CREATE INDEX identities_user ON identities(user_id, provider);
-- Every existing account came from Telegram: its ID is the Telegram user ID.
INSERT INTO identities(provider, subject, user_id, username, name, created_at)
SELECT 'telegram', id, id, username, name, created_at FROM users
WHERE id <> '' AND id NOT GLOB '*[^0-9]*';
