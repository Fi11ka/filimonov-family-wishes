-- Events of their own (П12–П13, П22–П25, flows 5, 6 and 10). Many per person; a new
-- one never replaces another. The standard occasions (birthday, New Year, 8 March or
-- 23 February) stay a list worked out from the profile and become events only when
-- someone creates one from them.
-- actual_on: «Фактическая дата»; celebrate_on: «Когда отмечаем» (the same by default).
-- Moving the celebration never changes the actual date or the profile.
-- mode: 'hero' («для одного»: gifts to the organizer) or 'everyone' («для всех»).
-- picked: 0 shows the whole wishlist, new wishes included; 1 only event_wishes.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base TEXT NOT NULL CHECK(base IN ('birthday','new_year','march8','feb23','custom')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  actual_on TEXT NOT NULL CHECK(length(actual_on)=10),
  celebrate_on TEXT NOT NULL CHECK(length(celebrate_on)=10),
  mode TEXT NOT NULL DEFAULT 'hero' CHECK(mode IN ('hero','everyone')),
  place TEXT CHECK(place IS NULL OR length(place)<=1000),
  picked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX events_owner ON events(owner_id, celebrate_on);
CREATE TABLE event_wishes (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  PRIMARY KEY(event_id, gift_id)
);
-- An invited person takes part at once (П24); declined_at: «Отказаться от участия»,
-- which can be undone. Being invited never changes friendship.
CREATE TABLE event_members (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  declined_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(event_id, user_id)
);
CREATE INDEX event_members_user ON event_members(user_id);
-- Parties still ahead become events, with their guests.
CREATE TABLE event_moves (
  owner_id TEXT, event_key TEXT, event_on TEXT, id TEXT
);
INSERT INTO event_moves(owner_id,event_key,event_on,id)
SELECT owner_id,event_key,event_on,
  lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-8'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))
FROM event_parties WHERE event_on>=date('now','-2 days');
INSERT INTO events(id,owner_id,base,title,actual_on,celebrate_on,mode,place,created_at)
SELECT m.id,p.owner_id,p.event_key,
  CASE p.event_key WHEN 'birthday' THEN 'День рождения' WHEN 'new_year' THEN 'Новый год'
    WHEN 'march8' THEN '8 Марта' WHEN 'feb23' THEN '23 Февраля'
    ELSE COALESCE((SELECT event_title FROM users WHERE id=p.owner_id),'Мероприятие') END,
  p.event_on,p.event_on,p.mode,p.description,p.created_at
FROM event_parties p JOIN event_moves m ON m.owner_id=p.owner_id AND m.event_key=p.event_key AND m.event_on=p.event_on;
INSERT INTO event_members(event_id,user_id,created_at)
SELECT m.id,g.user_id,g.created_at FROM event_guests g
JOIN event_moves m ON m.owner_id=g.owner_id AND m.event_key=g.event_key AND m.event_on=g.event_on;
-- A custom event of one's own with no guests yet becomes an event too.
INSERT INTO events(id,owner_id,base,title,actual_on,celebrate_on)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-8'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  id,'custom',event_title,event_date,event_date
FROM users u WHERE event_title IS NOT NULL AND event_date>=date('now','-2 days')
  AND NOT EXISTS(SELECT 1 FROM event_parties p WHERE p.owner_id=u.id AND p.event_key='custom' AND p.event_on=u.event_date);
DROP TABLE event_moves;
-- From now on the profile holds only what the standard occasions need.
UPDATE users SET event_title=NULL,event_date=NULL;
DROP TABLE event_guests;
DROP TABLE event_parties;
