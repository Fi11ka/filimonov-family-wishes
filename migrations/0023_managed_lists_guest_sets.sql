-- Wishlists one keeps for someone close (П35, flow 17): a child, a grandmother. Their
-- wishes stay the manager's own gifts (gifts.owner_id), told apart by list_id, so
-- everyone who sees the manager's list sees these too, with no settings of their own.
-- NULL list_id is the manager's personal list. checked_at: «Подтвердить актуальность»
-- for this list (П36).
CREATE TABLE wishlists (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
  checked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX wishlists_manager ON wishlists(manager_id, created_at);
ALTER TABLE gifts ADD COLUMN list_id TEXT REFERENCES wishlists(id) ON DELETE CASCADE;
CREATE INDEX gifts_list ON gifts(owner_id, list_id, archived_at);
-- A guest link opens one list, whole (new wishes appear by themselves) or a picked
-- set of its wishes (П30): picked=1 and the wishes in guest_link_gifts. Each set is
-- a link of its own, so the old one-link-per-owner rule goes.
ALTER TABLE guest_links ADD COLUMN list_id TEXT REFERENCES wishlists(id) ON DELETE CASCADE;
ALTER TABLE guest_links ADD COLUMN picked INTEGER NOT NULL DEFAULT 0;
CREATE TABLE guest_link_gifts (
  link_id TEXT NOT NULL REFERENCES guest_links(id) ON DELETE CASCADE,
  gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  PRIMARY KEY(link_id, gift_id)
);
DROP INDEX IF EXISTS permanent_share_owner_kind;
DROP INDEX IF EXISTS permanent_share_creator_kind;
CREATE UNIQUE INDEX guest_link_whole_list ON guest_links(owner_id, created_by, kind, COALESCE(list_id, ''))
  WHERE revoked_at IS NULL AND token_value IS NOT NULL AND picked=0;
-- Whose list a giver's card belongs to, by name, when it is a list kept for someone.
ALTER TABLE giver_records ADD COLUMN list_name TEXT;
