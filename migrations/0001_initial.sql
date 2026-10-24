PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  invite_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX members_family ON members(family_id);
CREATE TABLE gifts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  price_minor INTEGER CHECK(price_minor IS NULL OR price_minor BETWEEN 0 AND 100000000000),
  currency TEXT NOT NULL CHECK(currency IN ('EUR','USD','RUB','GBP','GEL','TRY','KZT','UAH','BYN')),
  shop_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL CHECK(priority IN (1,2,3)),
  photo TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX gifts_owner ON gifts(owner_id, priority DESC, created_at DESC);
CREATE TABLE guest_links (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX guest_links_owner ON guest_links(owner_id);
CREATE TABLE reservations (
  gift_id TEXT PRIMARY KEY REFERENCES gifts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX reservations_user ON reservations(user_id);
CREATE TRIGGER no_self_reservation BEFORE INSERT ON reservations
WHEN (SELECT owner_id FROM gifts WHERE id = NEW.gift_id) = NEW.user_id
BEGIN SELECT RAISE(ABORT, 'self_reservation'); END;
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
