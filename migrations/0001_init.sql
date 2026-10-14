CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  theme TEXT,
  color TEXT,
  avatar_url TEXT,
  vk_group_id TEXT,
  vk_screen_name TEXT,
  vk_connected INTEGER NOT NULL DEFAULT 0,
  vk_token_enc TEXT,
  schedule TEXT NOT NULL,
  style_rules TEXT NOT NULL,
  generation_settings TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  description TEXT,
  appearance TEXT NOT NULL,
  personality TEXT,
  locked INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (community_id) REFERENCES communities(id)
);

CREATE TABLE IF NOT EXISTS character_references (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  published_at TEXT,
  title TEXT,
  text TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  image_prompt TEXT,
  topic TEXT,
  idea TEXT,
  vk_post_id TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  approved_hash TEXT,
  approved_at TEXT,
  approved_by INTEGER,
  error_message TEXT,
  generation_meta TEXT,
  similarity_score REAL,
  similar_to TEXT,
  test_mode INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (community_id) REFERENCES communities(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_community_slot
  ON posts(community_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at);

CREATE TABLE IF NOT EXISTS post_versions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT,
  image_path TEXT,
  image_prompt TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER,
  reason TEXT,
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  post_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_generations (
  id TEXT PRIMARY KEY,
  community_id TEXT,
  type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt TEXT,
  result TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics (
  id TEXT PRIMARY KEY,
  community_id TEXT,
  post_id TEXT,
  date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'test',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_run ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
