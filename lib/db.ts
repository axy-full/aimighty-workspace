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
  /* Shots — the production unit a project is actually organised by.
     A shot is asked for once and rendered many times; every render is a
     VERSION of it. This is what makes "revisions per shot" a real number,
     what the canvas groups by, and what gives a download a meaningful name
     instead of a Seedance id. */
  `CREATE TABLE IF NOT EXISTS shots (
     id          TEXT PRIMARY KEY,
     project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
     scene       TEXT NOT NULL DEFAULT '',
     code        TEXT NOT NULL DEFAULT '',
     title       TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     status      TEXT NOT NULL DEFAULT 'open',
     position    INTEGER NOT NULL DEFAULT 0,
     created_by  TEXT NOT NULL DEFAULT '',
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id, position)`,
  /* Where a card sits on a project's canvas. Kept apart from the generation
     row so laying out a board never rewrites production data, and so a
     reference asset or a note can share the same surface as a render. */
  `CREATE TABLE IF NOT EXISTS canvas_items (
     id         TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind       TEXT NOT NULL DEFAULT 'generation',
     ref_id     TEXT,
     text       TEXT NOT NULL DEFAULT '',
     x          REAL NOT NULL DEFAULT 0,
     y          REAL NOT NULL DEFAULT 0,
     w          REAL NOT NULL DEFAULT 260,
     h          REAL NOT NULL DEFAULT 170,
     z          INTEGER NOT NULL DEFAULT 0,
     colour     TEXT NOT NULL DEFAULT '',
     created_by TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_project ON canvas_items(project_id, z)`,
  /* A saved shot spec — "our house look" as one click instead of six.
     Kept apart from cast_members because a look here is a set of CHOICES
     (85mm, golden hour, handheld), not an asset with a still. */
  `CREATE TABLE IF NOT EXISTS shot_presets (
     id         TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
     name       TEXT NOT NULL,
     spec       TEXT NOT NULL DEFAULT '{}',
     created_by TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_presets_project ON shot_presets(project_id)`,
  /* Workspace-level settings that outlive any one browser: the filename
     protocol, retention policy, provider preferences. localStorage prefs
     stay in lib/prefs.ts — these are the ones the whole team shares. */
  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_by TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL
   )`,
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
        // Reference uploads keep their master untouched; when a downstream
        // API can't accept the master, the derivative lives alongside it.
        `derivative_url TEXT`, `derivative_bytes INTEGER`,
        `derivative_note TEXT`, `sha256 TEXT`,
      ]) {
        try { await db().execute(`ALTER TABLE uploads ADD COLUMN ${col}`); }
        catch { /* column already exists */ }
      }
      // A deleted member is retired, not erased: their renders and spend keep
      // their name on the ledger, while access and listings treat them as gone.
      try { await db().execute(`ALTER TABLE users ADD COLUMN deleted_at INTEGER`); }
      catch { /* column already exists */ }
      // Invites remember whether and when they were emailed.
      for (const col of [`sent_at INTEGER`, `send_count INTEGER NOT NULL DEFAULT 0`]) {
        try { await db().execute(`ALTER TABLE invites ADD COLUMN ${col}`); }
        catch { /* column already exists */ }
      }
      for (const col of [`code TEXT NOT NULL DEFAULT ''`, `archived INTEGER NOT NULL DEFAULT 0`,
                         // What kind of job this is — the axis R2 calls
                         // genre/category-level performance.
                         `category TEXT NOT NULL DEFAULT ''`]) {
        try { await db().execute(`ALTER TABLE projects ADD COLUMN ${col}`); }
        catch { /* column already exists */ }
      }
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
        // Which shot this render is a take of, and which take it is.
        `shot_id TEXT`,
        `version INTEGER NOT NULL DEFAULT 1`,
        // How long the render actually took, wall-clock, in ms — the basis
        // for "where do projects get stuck" and for hours spent.
        `duration_ms INTEGER`,
        // Which provider served it, so the ledger survives a second vendor.
        `provider TEXT NOT NULL DEFAULT 'byteplus'`,
        `attempts INTEGER NOT NULL DEFAULT 1`,
        // generate | edit | extend, and the render this one works on.
        `task TEXT NOT NULL DEFAULT 'generate'`,
        `source_gen_id TEXT`,
      ]) {
        try { await db().execute(`ALTER TABLE generations ADD COLUMN ${col}`); }
        catch { /* column already exists */ }
      }
      /* Indexes for columns added above — created AFTER the ALTERs, since on
         an existing database the column doesn't exist until they've run.
         Every shot query (take counts, next version, revisions per shot)
         filters on shot_id, so without this they scan the whole table. */
      for (const stmt of [
        `CREATE INDEX IF NOT EXISTS idx_gen_shot ON generations(shot_id)`,
        `CREATE INDEX IF NOT EXISTS idx_gen_kind ON generations(kind)`,
      ]) {
        try { await db().execute(stmt); }
        catch { /* index already exists, or the column predates it */ }
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
