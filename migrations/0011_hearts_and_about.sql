-- Priority as 1–5 hearts. The old 1–3 column stays (CHECK cannot be relaxed
-- without rebuilding gifts, which would cascade to reservations) and is kept in
-- sync: 1–2 hearts → 1, 3 → 2, 4–5 → 3.
ALTER TABLE gifts ADD COLUMN hearts INTEGER NOT NULL DEFAULT 3 CHECK(hearts BETWEEN 1 AND 5);
-- Converting priorities is not a wishlist change: "Обновлён" must keep its date.
DROP TRIGGER wishlist_update;
UPDATE gifts SET hearts=CASE priority WHEN 1 THEN 2 WHEN 2 THEN 3 ELSE 5 END;
CREATE TRIGGER wishlist_update AFTER UPDATE ON gifts BEGIN
 UPDATE users SET wishlist_updated_at=unixepoch() WHERE id=NEW.owner_id;
END;
-- A few words under the wishlist title, shown to everyone who can see the list.
ALTER TABLE users ADD COLUMN about TEXT CHECK(about IS NULL OR length(about)<=500);
