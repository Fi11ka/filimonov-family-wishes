-- Profile photo: a small compressed data URL, like gift photos. photo_at changes
-- with every new photo so apps can cache it; photo_checked marks that the photo
-- from Telegram was already tried once (it is taken automatically only the first time).
ALTER TABLE users ADD COLUMN photo TEXT NOT NULL DEFAULT '' CHECK(length(photo)<=120000);
ALTER TABLE users ADD COLUMN photo_at INTEGER;
ALTER TABLE users ADD COLUMN photo_checked INTEGER NOT NULL DEFAULT 0 CHECK(photo_checked IN (0,1));
