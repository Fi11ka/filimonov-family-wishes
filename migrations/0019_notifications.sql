-- «Уведомления» in the app: every message the bot sends, also to people whose
-- bot is off or who have no Telegram. A message counts as read once it is seen
-- in the app, or once the person does anything in the bot chat after it arrived
-- (Telegram does not tell bots what was read).
-- text: the bot's Telegram HTML, <b> only, everything else escaped.
-- open: the app screen its button opens: l_<id> a profile, b «Мои брони», e_… an event, f followers.
-- tg_message_id: set when Telegram accepted the message.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  open TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at INTEGER,
  tg_message_id INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);
