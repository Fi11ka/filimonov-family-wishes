-- Events in the wishlist header. Gender picks 8 March or 23 February; it is shown only to the person.
ALTER TABLE users ADD COLUMN gender TEXT CHECK(gender IS NULL OR gender IN ('female','male'));
-- One event of the owner's own (a new one replaces it); the date is YYYY-MM-DD.
ALTER TABLE users ADD COLUMN event_title TEXT CHECK(event_title IS NULL OR length(event_title)<=80);
ALTER TABLE users ADD COLUMN event_date TEXT CHECK(event_date IS NULL OR length(event_date)=10);
-- An occurrence of an event (key + date) the owner invited friends to.
-- 'hero': guests see who booked what in the owner's list only.
-- 'everyone': the owner and guests see it in each other's lists.
-- Nobody ever sees who booked gifts in their own list.
CREATE TABLE event_parties (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK(event_key IN ('birthday','new_year','march8','feb23','custom')),
  event_on TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'hero' CHECK(mode IN ('hero','everyone')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, event_key, event_on)
);
CREATE TABLE event_guests (
  owner_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_on TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, event_key, event_on, user_id),
  FOREIGN KEY(owner_id, event_key, event_on) REFERENCES event_parties(owner_id, event_key, event_on) ON DELETE CASCADE,
  CHECK(owner_id <> user_id)
);
CREATE INDEX event_guests_user ON event_guests(user_id);
