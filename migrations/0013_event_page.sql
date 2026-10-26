-- A few words about the party for its guests (place, time, dress code). A party may have
-- no guests: cancelling it removes the invitations but keeps the event and its text.
ALTER TABLE event_parties ADD COLUMN description TEXT CHECK(description IS NULL OR length(description)<=1000);
