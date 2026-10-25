ALTER TABLE guest_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'guest' CHECK(kind IN ('guest','telegram'));
ALTER TABLE guest_links ADD COLUMN token_value TEXT;
UPDATE guest_links SET expires_at=253402300799 WHERE revoked_at IS NULL AND expires_at>unixepoch();
DROP TRIGGER no_self_reservation;
ALTER TABLE reservations RENAME TO old_reservations;
CREATE TABLE reservations (
 gift_id TEXT PRIMARY KEY REFERENCES gifts(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 guest_name TEXT CHECK(guest_name IS NULL OR length(guest_name) BETWEEN 1 AND 80),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 CHECK((user_id IS NOT NULL AND guest_name IS NULL) OR (user_id IS NULL AND guest_name IS NOT NULL))
);
INSERT INTO reservations(gift_id,user_id,created_at) SELECT gift_id,user_id,created_at FROM old_reservations;
DROP TABLE old_reservations;
CREATE INDEX reservations_user ON reservations(user_id);
CREATE TRIGGER no_self_reservation BEFORE INSERT ON reservations
WHEN (SELECT owner_id FROM gifts WHERE id=NEW.gift_id)=NEW.user_id
BEGIN SELECT RAISE(ABORT, 'self_reservation'); END;
CREATE UNIQUE INDEX permanent_share_owner_kind ON guest_links(owner_id,kind) WHERE revoked_at IS NULL AND token_value IS NOT NULL;
