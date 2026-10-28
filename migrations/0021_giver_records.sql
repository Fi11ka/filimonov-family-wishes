-- What a giver keeps of their own choice (flow 16, П32–П33). When the owner deletes
-- or archives a booked wish the booking closes, but each giver keeps a card with
-- what the gift was at the time: «Требует внимания» in «Активные». «Подарено»
-- confirmed by the giver moves it to «Подаренные». No foreign key to gifts: the
-- record outlives the wish. Never read by any owner-facing query.
-- reason: what the owner did (deleted it, or archived it for one of three reasons).
-- gifted_at: the giver confirmed they gave it («Подаренные»).
-- hidden_at: «Удалить у меня», for this giver only; later actions do not bring it back.
CREATE TABLE giver_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  price_minor INTEGER,
  price_max_minor INTEGER,
  price_range INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  shop_url TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  reason TEXT CHECK(reason IS NULL OR reason IN ('deleted','changed_mind','bought_self','gifted')),
  changed_at INTEGER,
  gifted_at INTEGER,
  hidden_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, gift_id)
);
CREATE INDEX giver_records_gift ON giver_records(gift_id);
-- The owner changed the title, price or link of a booked gift: a mark for the giver
-- until they dismiss it. Which of the three, comma-separated.
ALTER TABLE reservations ADD COLUMN changed_at INTEGER;
ALTER TABLE reservations ADD COLUMN changed_fields TEXT;
-- Bookings on wishes already archived become records: the organizer and those who joined.
INSERT OR IGNORE INTO giver_records(user_id,gift_id,owner_id,title,price_minor,price_max_minor,price_range,currency,shop_url,photo,reason,changed_at)
SELECT b.user_id,g.id,g.owner_id,g.title,g.price_minor,g.price_max_minor,g.price_range,g.currency,g.shop_url,g.photo,
  COALESCE(g.archive_reason,'bought_self'),g.archived_at
FROM gifts g JOIN (
  SELECT gift_id,user_id FROM reservations WHERE user_id IS NOT NULL
  UNION SELECT gift_id,user_id FROM reservation_members WHERE status='joined'
) b ON b.gift_id=g.id
WHERE g.archived_at IS NOT NULL;
DELETE FROM reservations WHERE gift_id IN (SELECT id FROM gifts WHERE archived_at IS NOT NULL);
