import { createClient, type Client } from "@libsql/client";

/**
 * Local dev  -> file:.data/ark.db
 * Production -> set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 */
let _db: Client | null = null;
let _ready: Promise<void> | null = null;

export function db(): Client {
  if (!_db) {
    const url = process.env.TURSO_DATABASE_URL ?? "file:.data/ark.db";
    _db = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _db;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS generations (
     id            TEXT PRIMARY KEY,
     project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
     ark_task_id   TEXT,
     model         TEXT NOT NULL,
     prompt        TEXT NOT NULL,
     params        TEXT NOT NULL,
     status        TEXT NOT NULL,
     source_url    TEXT,
     stored_url    TEXT,
     total_tokens  INTEGER,
     cost_usd      REAL,
     rate_usd_per_m REAL,
     error         TEXT,
     created_by    TEXT NOT NULL DEFAULT '',
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gen_project ON generations(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gen_status  ON generations(status)`,
  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     name          TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT 'member',
     disabled      INTEGER NOT NULL DEFAULT 0,
     failed_count  INTEGER NOT NULL DEFAULT 0,
     locked_until  INTEGER,
     last_seen     INTEGER,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS invites (
     code       TEXT PRIMARY KEY,
     email      TEXT NOT NULL,
     name       TEXT NOT NULL,
     role       TEXT NOT NULL DEFAULT 'member',
     created_by TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS uploads (
     id          TEXT PRIMARY KEY,
     filename    TEXT NOT NULL,
     mime        TEXT NOT NULL,
     ext         TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     sha256      TEXT NOT NULL,
     width       INTEGER,
     height      INTEGER,
     stored_url  TEXT NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text       TEXT NOT NULL DEFAULT '',
     mentions   TEXT NOT NULL DEFAULT '[]',
     upload_id  TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS chat_reads (
     user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     last_read_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint   TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     p256dh     TEXT NOT NULL,
     auth       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id)`,
  /* The cast: characters, locations and looks that recur across shots.
     Naming one once and citing it as @Name is what keeps a face or a street
     the same from scene to scene. */
  `CREATE TABLE IF NOT EXISTS cast_members (
     id          TEXT PRIMARY KEY,
     project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     kind        TEXT NOT NULL DEFAULT 'character',
     description TEXT NOT NULL DEFAULT '',
     upload_id   TEXT,
     created_by  TEXT NOT NULL DEFAULT '',
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cast_project ON cast_members(project_id)`,
  /* Notes on a specific shot, as opposed to the workspace-wide chat. */
  `CREATE TABLE IF NOT EXISTS notes (
     id         TEXT PRIMARY KEY,
     gen_id     TEXT NOT NULL,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_gen ON notes(gen_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id          TEXT PRIMARY KEY,
     token_hash  TEXT NOT NULL UNIQUE,
     name        TEXT NOT NULL,
     user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     scope       TEXT NOT NULL DEFAULT 'render',
     cap_usd     REAL,
     last_used   INTEGER,
     created_at  INTEGER NOT NULL,
     revoked_at  INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id)`,
  `CREATE TABLE IF NOT EXISTS topups (
     id         TEXT PRIMARY KEY,
     amount_usd REAL NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
];

export async function ready(): Promise<void> {
  if (!_ready) {
    _ready = (async () => {
      for (const stmt of SCHEMA) await db().execute(stmt);
      // Lightweight migrations for columns added after first deploy.
      try {
        await db().execute(`ALTER TABLE generations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
      } catch { /* column already exists */ }
      try {
        await db().execute(`ALTER TABLE uploads ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'`);
      } catch { /* column already exists */ }
      try {
        await db().execute(`ALTER TABLE uploads ADD COLUMN duration_s REAL`);
      } catch { /* column already exists */ }
      for (const col of [
        `refine_model TEXT`, `refine_in_tokens INTEGER`,
        `refine_out_tokens INTEGER`, `refine_cost_usd REAL`,
        `kind TEXT NOT NULL DEFAULT 'video'`,
        // Which API token made this render, when it wasn't a person in a browser.
        `token_id TEXT`,
        // Review state: '' (unreviewed) | 'approved' | 'changes'
        `review_state TEXT NOT NULL DEFAULT ''`,
        `review_by TEXT`,
        `reviewed_at INTEGER`,
      ]) {
        try { await db().execute(`ALTER TABLE generations ADD COLUMN ${col}`); }
        catch { /* column already exists */ }
      }
    })();
  }
  return _ready;
}

export function now(): number {
  return Date.now();
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
