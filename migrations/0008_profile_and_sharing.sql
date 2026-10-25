ALTER TABLE users ADD COLUMN birthday TEXT CHECK(birthday IS NULL OR length(birthday)=5);
ALTER TABLE users ADD COLUMN allow_resharing INTEGER NOT NULL DEFAULT 1 CHECK(allow_resharing IN (0,1));
ALTER TABLE users ADD COLUMN wishlist_updated_at INTEGER;
UPDATE users SET wishlist_updated_at=(SELECT MAX(MAX(g.created_at,g.updated_at,COALESCE(g.archived_at,0))) FROM gifts g WHERE g.owner_id=users.id);
CREATE TRIGGER wishlist_insert AFTER INSERT ON gifts BEGIN
 UPDATE users SET wishlist_updated_at=unixepoch() WHERE id=NEW.owner_id;
END;
CREATE TRIGGER wishlist_update AFTER UPDATE ON gifts BEGIN
 UPDATE users SET wishlist_updated_at=unixepoch() WHERE id=NEW.owner_id;
END;
CREATE TRIGGER wishlist_delete AFTER DELETE ON gifts BEGIN
 UPDATE users SET wishlist_updated_at=unixepoch() WHERE id=OLD.owner_id;
END;
ALTER TABLE guest_links ADD COLUMN created_by TEXT REFERENCES users(id);
UPDATE guest_links SET created_by=owner_id;
DROP INDEX permanent_share_owner_kind;
CREATE UNIQUE INDEX permanent_share_creator_kind ON guest_links(owner_id,created_by,kind) WHERE revoked_at IS NULL AND token_value IS NOT NULL;
