-- «Подтвердить актуальность» (П36): when the owner last confirmed the whole list is
-- still what they want. Apart from wishlist_updated_at: editing wishes never sets it,
-- and existing lists start with none rather than their last edit.
ALTER TABLE users ADD COLUMN checked_at INTEGER;
