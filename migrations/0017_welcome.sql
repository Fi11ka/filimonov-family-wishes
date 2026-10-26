-- First sign-in: the app shows what it can do and asks for the birthday and
-- gender once per account. Those who already filled both do not need it.
ALTER TABLE users ADD COLUMN welcomed_at INTEGER;
UPDATE users SET welcomed_at=unixepoch() WHERE birthday IS NOT NULL AND gender IS NOT NULL;
