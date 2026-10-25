-- Telegram bot: notifications, subscriptions to friends' wishlists and gifts from several friends.
-- Notifications are on by default; a user receives them once they pressed Start in the bot.
ALTER TABLE users ADD COLUMN notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1));
-- Last update from this user in the bot chat; NULL means the bot may not be able to write to them.
ALTER TABLE users ADD COLUMN bot_chat_at INTEGER;
-- Telegram answered 403 (the bot was blocked or never started); cleared by the next update.
ALTER TABLE users ADD COLUMN bot_blocked_at INTEGER;
CREATE TABLE subscriptions (
  subscriber_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(subscriber_id, target_id),
  CHECK(subscriber_id <> target_id)
);
CREATE INDEX subscriptions_target ON subscriptions(target_id);
-- Friends invited by the reservation's organizer (reservations.user_id) to share a gift.
-- Never read by any owner-facing query.
CREATE TABLE reservation_members (
  gift_id TEXT NOT NULL REFERENCES reservations(gift_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('invited','joined')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(gift_id, user_id)
);
CREATE INDEX reservation_members_user ON reservation_members(user_id);
CREATE TRIGGER no_owner_member BEFORE INSERT ON reservation_members
WHEN (SELECT owner_id FROM gifts WHERE id=NEW.gift_id)=NEW.user_id
BEGIN SELECT RAISE(ABORT, 'self_reservation'); END;
-- Guests cancel their own booking with a code kept in their browser; owners no longer see guest names.
ALTER TABLE reservations ADD COLUMN guest_code_hash TEXT;
-- What the bot waits for from a user (a new wish, a new title…). Rows expire after a day.
CREATE TABLE bot_states (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  gift_id TEXT,
  updated_at INTEGER NOT NULL
);
-- Birthday reminders already sent to friends (one row per person, date and lead time).
CREATE TABLE birthday_notices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  birthday_on TEXT NOT NULL,
  days INTEGER NOT NULL,
  PRIMARY KEY(user_id, birthday_on, days)
);
