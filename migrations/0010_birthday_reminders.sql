-- Birthday reminders already sent to friends (one row per person, date and lead time).
CREATE TABLE birthday_notices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  birthday_on TEXT NOT NULL,
  days INTEGER NOT NULL,
  PRIMARY KEY(user_id, birthday_on, days)
);
