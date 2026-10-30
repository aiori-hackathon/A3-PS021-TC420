-- PS-021 SQLite Schema Definition
-- Version: EXPERIMENTAL DRAFT v0, schema version pending mentor pinning
-- Honesty note: Relies on SQLite WAL mode and synchronous transactions for durability.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Core dialog state table correlating dialog_id with task_id across adapters
CREATE TABLE IF NOT EXISTS dialogs (
  dialog_id TEXT PRIMARY KEY,
  task_id TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  origin_adapter TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Idempotency table tracking requests and cached responses to prevent duplicate execution
CREATE TABLE IF NOT EXISTS requests (
  dialog_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  attempts INTEGER DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY(dialog_id, request_id),
  FOREIGN KEY(dialog_id) REFERENCES dialogs(dialog_id)
);

-- Audit table tracking external side effects executed by the engine
-- UNIQUE constraint guarantees at the DB level that a given side effect type for a (dialog, request) cannot run twice
CREATE TABLE IF NOT EXISTS side_effects (
  effect_id INTEGER PRIMARY KEY AUTOINCREMENT,
  dialog_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  effect_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dialog_id, request_id, effect_type),
  FOREIGN KEY(dialog_id) REFERENCES dialogs(dialog_id)
);
