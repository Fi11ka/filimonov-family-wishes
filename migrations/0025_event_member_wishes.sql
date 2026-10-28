-- «Для всех» (block «Мероприятия и поводы»): every guest, not only the organizer,
-- chooses which of their wishes the event shows. picked: 0 shows the whole
-- personal wishlist, 1 only that guest's gifts in event_wishes. event_wishes
-- now holds any participant's gifts; whose they are is the gift's owner.
ALTER TABLE event_members ADD COLUMN picked INTEGER NOT NULL DEFAULT 0;
