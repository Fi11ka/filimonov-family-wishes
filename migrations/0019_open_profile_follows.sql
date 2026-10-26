-- A request to follow an open profile is a follow: approve the ones left
-- waiting from when those profiles were closed.
UPDATE follows SET status='approved',approved_at=unixepoch()
  WHERE status='pending' AND target_id IN (SELECT id FROM users WHERE is_private=0);
