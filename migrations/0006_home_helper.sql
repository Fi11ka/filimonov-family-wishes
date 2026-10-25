-- Home helper: jobs for the program that opens Ozon/DNS/Yandex Market/AliExpress.ru
-- pages in a real browser on a home computer. Rows live for seconds; the daily
-- cron removes anything older than an hour. Only shop URLs and shop HTML are stored.
CREATE TABLE helper_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('page','image')),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','taken','done','error')),
  created_at INTEGER NOT NULL,
  taken_at INTEGER,
  result_status INTEGER,
  result_url TEXT,
  result_type TEXT,
  body TEXT
);
CREATE INDEX helper_jobs_queue ON helper_jobs(status, created_at);
-- Last time the helper asked for work (single row).
CREATE TABLE helper_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seen_at INTEGER NOT NULL
);
