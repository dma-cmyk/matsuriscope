-- MatsuriScope DB schema (node:sqlite)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL DEFAULT 'fivech',  -- 収集元 (将来 x/reddit 等)
  server TEXT NOT NULL,
  board_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_id, server, board_key)
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id),
  thread_key TEXT NOT NULL,             -- dat番号 (= 作成Unix秒)
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  res_count INTEGER NOT NULL DEFAULT 0,
  ikioi REAL NOT NULL DEFAULT 0,        -- レス数/経過日数
  created_at INTEGER NOT NULL,          -- thread_key 由来
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(board_id, thread_key)
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_canonical TEXT NOT NULL UNIQUE,   -- 正規化URL (重複排除キー)
  type TEXT NOT NULL CHECK (type IN ('image','gif','video','youtube','twitter','other')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  previewable INTEGER NOT NULL DEFAULT 1,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  occ_count INTEGER NOT NULL DEFAULT 1  -- 出現スレッド数
);

CREATE TABLE IF NOT EXISTS media_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  res_no INTEGER,                       -- レス番号 (1-based)
  found_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(media_id, thread_id, res_no)
);

CREATE TABLE IF NOT EXISTS collect_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','success','partial','error','cancelled','interrupted')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule','manual','startup')),
  scope TEXT NOT NULL DEFAULT 'hot' CHECK (scope IN ('hot','board')),
  board_id INTEGER REFERENCES boards(id),
  threads_total INTEGER NOT NULL DEFAULT 0,
  threads_attempted INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  current_thread TEXT,
  boards_checked INTEGER NOT NULL DEFAULT 0,
  threads_seen INTEGER NOT NULL DEFAULT 0,
  threads_fetched INTEGER NOT NULL DEFAULT 0,
  media_found INTEGER NOT NULL DEFAULT 0,
  media_new INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES collect_jobs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id);
CREATE INDEX IF NOT EXISTS idx_threads_ikioi ON threads(ikioi DESC);
CREATE INDEX IF NOT EXISTS idx_threads_last_seen ON threads(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_favorite ON media(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS idx_media_first_seen ON media(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_occ_media ON media_occurrences(media_id);
CREATE INDEX IF NOT EXISTS idx_occ_thread ON media_occurrences(thread_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);
