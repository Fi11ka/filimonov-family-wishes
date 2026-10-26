-- Followers instead of mutual friendship (docs/FOLLOWERS.md).
-- A closed profile (1) shows its list only to approved followers; an open one to
-- everyone. Existing profiles stay closed; new ones choose in the welcome dialog.
ALTER TABLE users ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1 CHECK(is_private IN (0,1));
-- One-way: approving a follower opens my list to them, not theirs to me.
CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','approved')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  approved_at INTEGER,
  PRIMARY KEY(follower_id, target_id),
  CHECK(follower_id <> target_id)
);
CREATE INDEX follows_target ON follows(target_id, status);
-- Friends keep seeing each other: one approved follow each way. Bells (subscriptions) stay.
INSERT OR IGNORE INTO follows(follower_id,target_id,status,created_at,approved_at)
  SELECT user_a,user_b,'approved',created_at,COALESCE(accepted_at,created_at) FROM friendships WHERE status='accepted';
INSERT OR IGNORE INTO follows(follower_id,target_id,status,created_at,approved_at)
  SELECT user_b,user_a,'approved',created_at,COALESCE(accepted_at,created_at) FROM friendships WHERE status='accepted';
-- A pending friend request becomes a request to follow from the person who sent it.
INSERT OR IGNORE INTO follows(follower_id,target_id,status,created_at)
  SELECT requested_by,CASE WHEN requested_by=user_a THEN user_b ELSE user_a END,'pending',created_at
  FROM friendships WHERE status='pending';
-- friendships and friend_invites are no longer read; old f_ links only lead to the profile.
