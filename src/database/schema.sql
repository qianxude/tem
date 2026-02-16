-- TEM Database Schema
-- SQLite with WAL mode

-- Migration tracking
CREATE TABLE IF NOT EXISTS _migration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Batch: Groups of related tasks
CREATE TABLE IF NOT EXISTS batch (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  metadata TEXT -- JSON object
);

-- Task: Individual units of work
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES batch(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  payload TEXT NOT NULL, -- JSON object (opaque)
  result TEXT, -- JSON object (opaque)
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempt INTEGER NOT NULL DEFAULT 3,
  claimed_at DATETIME,
  completed_at DATETIME,
  version INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_batch_code ON batch(code);
CREATE INDEX IF NOT EXISTS idx_batch_type ON batch(type);
CREATE INDEX IF NOT EXISTS idx_task_batch_id ON task(batch_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
CREATE INDEX IF NOT EXISTS idx_task_type ON task(type);
CREATE INDEX IF NOT EXISTS idx_task_claim ON task(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_task_pending ON task(status, created_at) WHERE status = 'pending';
