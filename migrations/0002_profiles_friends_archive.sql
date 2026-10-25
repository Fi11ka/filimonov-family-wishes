-- Individual profiles and friends instead of families; archive; price ranges.
-- families/members are kept read-only for history and can be dropped later.
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX users_username ON users(username) WHERE username IS NOT NULL;
ALTER TABLE gifts ADD COLUMN price_max_minor INTEGER CHECK(price_max_minor IS NULL OR price_max_minor BETWEEN 0 AND 100000000000);
ALTER TABLE gifts ADD COLUMN price_range INTEGER NOT NULL DEFAULT 0 CHECK(price_range IN (0,1));
ALTER TABLE gifts ADD COLUMN archived_at INTEGER;
CREATE INDEX gifts_owner_active ON gifts(owner_id, archived_at);
CREATE TABLE friendships (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at INTEGER,
  PRIMARY KEY(user_a, user_b),
  CHECK(user_a < user_b),
  CHECK(requested_by IN (user_a, user_b))
);
CREATE INDEX friendships_b ON friendships(user_b, status);
CREATE TABLE friend_invites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX friend_invites_owner ON friend_invites(owner_id);
-- Everyone who shared a family becomes friends with everyone else from it.
INSERT OR IGNORE INTO friendships(user_a, user_b, status, requested_by, accepted_at)
SELECT a.user_id, b.user_id, 'accepted', a.user_id, unixepoch()
FROM members a JOIN members b ON a.family_id = b.family_id AND a.user_id < b.user_id;
