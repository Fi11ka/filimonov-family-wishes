ALTER TABLE gifts ADD COLUMN archive_reason TEXT CHECK(archive_reason IN ('changed_mind','gifted','bought_self'));
ALTER TABLE gifts ADD COLUMN gifted_by_name TEXT;
ALTER TABLE gifts ADD COLUMN gifted_by_username TEXT;
