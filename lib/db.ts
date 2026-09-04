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
  /* An identity — a real face the trainer has learned from a set of photos,
     the way Higgsfield's Soul ID works. The photos stay uploads; the model
     the trainer returns is a file at the vendor, referenced by URL. */
  `CREATE TABLE IF NOT EXISTS identities (
     id            TEXT PRIMARY KEY,
     project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
     name          TEXT NOT NULL,
     description   TEXT NOT NULL DEFAULT '',
     photos        TEXT NOT NULL DEFAULT '[]',
     status        TEXT NOT NULL DEFAULT 'draft',
     provider      TEXT NOT NULL DEFAULT 'fal',
     trainer       TEXT,
     request_id    TEXT,
     trigger       TEXT,
     steps         INTEGER,
     lora_url      TEXT,
     config_url    TEXT,
     cost_usd      REAL,
     error         TEXT,
     cover_upload_id TEXT,
     cast_id       TEXT,
     created_by    TEXT NOT NULL DEFAULT '',
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     trained_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_identities_project ON identities(project_id)`,
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
  /* A reading taken from a vendor's own console.
     Every cost in this app is COMPUTED — tokens times a rate we hold in a
     table — which is an estimate however careful, and drifts the moment a
     vendor changes a price or applies a promotion we don't know about. A
     reading anchors the ledger to what the vendor itself says, so the
     figure on the Usage page is the vendor's, not ours, and the difference
     between them is visible instead of silent. */
  `CREATE TABLE IF NOT EXISTS ledger_checks (
     id           TEXT PRIMARY KEY,
     provider     TEXT NOT NULL,
     balance_usd  REAL,
     spend_usd    REAL,
     /* A vendor sold in credits rather than dollars — ElevenLabs — is read
        off its console in credits, so the reading is kept in the same unit
        the console showed. Converting at read time would bake in whatever
        rate we happened to believe that day. */
     balance_credits INTEGER,
     spend_credits   INTEGER,
     note         TEXT NOT NULL DEFAULT '',
     checked_at   INTEGER NOT NULL,
     created_by   TEXT NOT NULL DEFAULT '',
     created_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_checks_provider ON ledger_checks(provider, checked_at DESC)`,
  `CREATE TABLE IF NOT EXISTS topups (
     id         TEXT PRIMARY KEY,
     amount_usd REAL NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,

  /* ── Atomik ───────────────────────────────────────────────────────────
     The studio's agent. A chat is one production conversation; messages
     are its transcript; steps are the generations the agent has PROPOSED
     and that a person has not yet paid for.

     Steps are a table rather than JSON on the message because a step
     outlives the sentence that proposed it: it is approved minutes later,
     edited before approval, run, retried, and finally points at a real
     generation. Each of those is a single-row update, which is miserable
     against a blob every writer has to read, rewrite and race over. */
  `CREATE TABLE IF NOT EXISTS atomik_chats (
     id          TEXT PRIMARY KEY,
     project_id  TEXT,
     title       TEXT NOT NULL DEFAULT 'New chat',
     /* the planner: a Vercel AI Gateway model id, or 'auto' */
     model       TEXT NOT NULL DEFAULT 'auto',
     /* ask | auto -- whether each generation stops for approval */
     agent_mode  TEXT NOT NULL DEFAULT 'ask',
     /* running | waiting | idle | failed */
     status      TEXT NOT NULL DEFAULT 'idle',
     text_cost_usd REAL NOT NULL DEFAULT 0,
     created_by  TEXT NOT NULL DEFAULT '',
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     deleted     INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_atomik_chats_created ON atomik_chats(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS atomik_messages (
     id         TEXT PRIMARY KEY,
     chat_id    TEXT NOT NULL,
     /* user | assistant | system */
     role       TEXT NOT NULL,
     text       TEXT NOT NULL DEFAULT '',
     /* the collapsible activity groups, as JSON: what it loaded, weighed
        and decided on the way to this answer */
     activity   TEXT NOT NULL DEFAULT '[]',
     /* a question put back to the person, with its suggested answers */
     ask        TEXT,
     /* how long the turn took, and what the model charged for it */
     worked_ms  INTEGER,
     cost_usd   REAL NOT NULL DEFAULT 0,
     model      TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_atomik_messages_chat ON atomik_messages(chat_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS atomik_steps (
     id           TEXT PRIMARY KEY,
     chat_id      TEXT NOT NULL,
     message_id   TEXT NOT NULL DEFAULT '',
     position     INTEGER NOT NULL DEFAULT 0,
     /* video | image | audio */
     kind         TEXT NOT NULL DEFAULT 'video',
     title        TEXT NOT NULL DEFAULT '',
     prompt       TEXT NOT NULL DEFAULT '',
     model        TEXT NOT NULL DEFAULT '',
     params       TEXT NOT NULL DEFAULT '{}',
     /* proposed | running | done | failed | rejected */
     status       TEXT NOT NULL DEFAULT 'proposed',
     gen_id       TEXT,
     est_cost_usd REAL,
     error        TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_atomik_steps_chat ON atomik_steps(chat_id, created_at)`,
];

/**
 * An ALTER expected to fail exactly once, when the column already exists.
 *
 * A bare `catch {}` here cannot tell "already there" from a dropped
 * connection, and swallowing the second one is the worse bug of the two:
 * ready() would resolve, report the schema complete, and cache that success
 * for the life of the instance while a column every query touches is simply
 * missing. Only the duplicate is ignored; anything else propagates, clears
 * the memo, and is retried by the next request.
 */
async function addColumn(table: string, decl: string): Promise<void> {
  try {
    await db().execute(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
  } catch (e) {
    if (!/duplicate column|already exists/i.test((e as Error).message)) throw e;
  }
}

/** Same reasoning for an index that may name a column added moments ago. */
async function addIndex(stmt: string): Promise<void> {
  try {
    await db().execute(stmt);
  } catch (e) {
    if (!/already exists|no such column|duplicate/i.test((e as Error).message)) throw e;
  }
}

export async function ready(): Promise<void> {
  if (!_ready) {
    /* The promise is memoised so the migration runs once per instance. That
       makes the FAILURE path the dangerous one: a rejected promise left in
       `_ready` would be handed to every subsequent request, so one blink of
       the database during a cold start would turn into an outage lasting the
       whole life of the container. Clearing it on failure means the next
       request simply tries again. */
    _ready = (async () => {
      for (const stmt of SCHEMA) await db().execute(stmt);
      // Lightweight migrations for columns added after first deploy.
      await addColumn("generations", `deleted INTEGER NOT NULL DEFAULT 0`);
      await addColumn("uploads", `kind TEXT NOT NULL DEFAULT 'image'`);
      await addColumn("uploads", `duration_s REAL`);
      for (const col of [
        // Reference uploads keep their master untouched; when a downstream
        // API can't accept the master, the derivative lives alongside it.
        `derivative_url TEXT`, `derivative_bytes INTEGER`,
        `derivative_note TEXT`, `sha256 TEXT`,
      ]) {
        await addColumn("uploads", col);
      }
      // A deleted member is retired, not erased: their renders and spend keep
      // their name on the ledger, while access and listings treat them as gone.
      await addColumn("users", `deleted_at INTEGER`);
      // Looks: a category, a cover, a blurb, a style block, references,
      // and whether the product shipped it.
      for (const col of [
        `slug TEXT`, `category TEXT NOT NULL DEFAULT ''`, `blurb TEXT NOT NULL DEFAULT ''`,
        `prose TEXT NOT NULL DEFAULT ''`, `refs TEXT NOT NULL DEFAULT '[]'`,
        `cover_gen_id TEXT`, `cover_upload_id TEXT`, `swatch TEXT`,
        `builtin INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER`,
      ]) {
        await addColumn("shot_presets", col);
      }
      // Invites remember whether and when they were emailed.
      for (const col of [`sent_at INTEGER`, `send_count INTEGER NOT NULL DEFAULT 0`]) {
        await addColumn("invites", col);
      }
      for (const col of [`code TEXT NOT NULL DEFAULT ''`, `archived INTEGER NOT NULL DEFAULT 0`,
                         // What kind of job this is — the axis R2 calls
                         // genre/category-level performance.
                         `category TEXT NOT NULL DEFAULT ''`]) {
        await addColumn("projects", col);
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
        // A name the team gives a render, shown in place of the clip id.
        `title TEXT`,
        /* Where the time actually went. duration_ms alone says only how long
           a render took to reach a terminal state, which on a path that waits
           for a poll is mostly OUR waiting rather than the engine's working —
           one row read 21 hours because the cron was down. These split it:
              queue_ms   asked → the work actually starting
              refine_ms  the prompt writer, before the engine sees anything
              submit_ms  handing the task to the vendor
              engine_ms  the vendor's own working time
              notice_ms  vendor finished → we found out (polled paths only)
              store_ms   moving the bytes into our storage
           Each is null where it does not apply or could not be measured. */
        /* How many bytes this render occupies in storage. Unlike every
           other cost here it is not paid once: it is rent, charged every
           month for as long as the render is kept, and it is the only line
           on the ledger that grows without anyone doing anything. */
        `bytes INTEGER`,
        `queue_ms INTEGER`, `refine_ms INTEGER`, `submit_ms INTEGER`,
        `engine_ms INTEGER`, `notice_ms INTEGER`, `store_ms INTEGER`,
      ]) {
        await addColumn("generations", col);
      }
      /* Indexes for columns added above — created AFTER the ALTERs, since on
         an existing database the column doesn't exist until they've run.
         Every shot query (take counts, next version, revisions per shot)
         filters on shot_id, so without this they scan the whole table. */
      /* Top-ups belong to a vendor. Everything recorded before there was more
         than one vendor was ModelArk money, which the default preserves. */
      await addColumn("topups", `provider TEXT NOT NULL DEFAULT 'byteplus'`);
      /* ElevenLabs is bought in credits; its ledger counts those. */
      await addColumn("topups", `credits INTEGER`);
      /* Added after ledger_checks first shipped, so the CREATE TABLE above
         will not deliver them to a database that already has the table. A
         column added to a CREATE TABLE IF NOT EXISTS reaches new databases
         only; every existing one needs the ALTER. */
      await addColumn("ledger_checks", `balance_credits INTEGER`);
      await addColumn("ledger_checks", `spend_credits INTEGER`);
      /* Re-assert the super admin on every boot. A guarantee checked only at
         the point of use can be undone by a direct database edit or a bug in
         a route; re-asserting it here means the account heals itself on the
         next request instead of staying broken.

         The LIKE clause matters: deleting a member mangles the address to
         "<email>#deleted-<ts>", so a super admin deleted before this existed
         would otherwise never be found again. This restores the address too. */
      try {
        const superEmail = (process.env.SUPER_ADMIN_EMAIL ?? "axy@akshaypanchal.com").trim().toLowerCase();
        await db().execute({
          sql: `UPDATE users
                SET role='admin', disabled=0, deleted_at=NULL,
                    locked_until=NULL, failed_count=0, email=?
                WHERE LOWER(email)=? OR LOWER(email) LIKE ?`,
          args: [superEmail, superEmail, `${superEmail}#deleted-%`],
        });
      } catch { /* the users table may not exist on the very first boot */ }
      /* The balances the team reported on 3 Sep 2026, written once into the
         ledger so each vendor's credit counts down from what was actually
         loaded. Fixed ids: a redeploy never records them twice, and deleting
         one on the Usage page stays deleted. */
      for (const [tid, provider, usd, credits, note] of [
        ["top_seed_fal_20260903", "fal", 50, null, "Added at fal.ai, 3 Sep 2026"],
        ["top_seed_google_20260903", "google", 25, null, "Vercel AI Gateway credit, 3 Sep 2026"],
        ["top_seed_eleven_20260903", "elevenlabs", 0, 131000, "Plan credits, 3 Sep 2026"],
      ] as const) {
        try {
          await db().execute({
            sql: `INSERT OR IGNORE INTO topups (id, provider, amount_usd, credits, note, created_at) VALUES (?,?,?,?,?,?)`,
            args: [tid, provider, usd, credits, note, Date.parse("2026-09-03T12:00:00Z")],
          });
        } catch { /* recorded already, or the table is read-only right now */ }
      }
      for (const stmt of [
        `CREATE INDEX IF NOT EXISTS idx_gen_shot ON generations(shot_id)`,
        `CREATE INDEX IF NOT EXISTS idx_gen_kind ON generations(kind)`,
      ]) {
        await addIndex(stmt);
      }
    })().catch((e) => {
      _ready = null;
      throw e;
    });
  }
  return _ready;
}

export function now(): number {
  return Date.now();
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
