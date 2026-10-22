CREATE TABLE IF NOT EXISTS facts (
  repository_id TEXT PRIMARY KEY,
  releases INTEGER NOT NULL DEFAULT 0,
  landed_at TEXT
);
