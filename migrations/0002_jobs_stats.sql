-- Extra tables from the Supabase TZ, mirrored locally so the app
-- keeps working without cloud credentials.

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  community_id TEXT,
  post_id TEXT,
  type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_jobs (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  vk_post_id TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_statistics (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  community_id TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_secrets (
  community_id TEXT PRIMARY KEY,
  vk_token_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pub_jobs_post ON publication_jobs(post_id, status);
CREATE INDEX IF NOT EXISTS idx_post_stats_post ON post_statistics(post_id, collected_at);
