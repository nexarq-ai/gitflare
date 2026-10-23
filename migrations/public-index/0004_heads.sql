CREATE TABLE IF NOT EXISTS heads (
  repository_id TEXT PRIMARY KEY,
  head_sha TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
