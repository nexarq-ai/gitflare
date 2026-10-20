CREATE TABLE IF NOT EXISTS repositories (
  repository_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '',
  language TEXT,
  license TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,
  paths_truncated INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repositories_by_stars ON repositories (stars DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS repositories_by_published ON repositories (published_at DESC);
CREATE INDEX IF NOT EXISTS repositories_by_updated ON repositories (updated_at DESC);
CREATE INDEX IF NOT EXISTS repositories_by_language ON repositories (language, stars DESC);
CREATE INDEX IF NOT EXISTS repositories_by_workspace ON repositories (workspace_id);
CREATE TABLE IF NOT EXISTS paths (
  repository_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (repository_id, path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS handles (
  handle TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handles_by_workspace ON handles (workspace_id);
