-- Deploy #4 migration 5 of 6: PR #728 (feat/step0-review-events), the append-only history of who judged a take. Database: every TENANT database and the house
-- workspace's database. Exactly the statements the app runs (lib/db.ts SCHEMA). Idempotent; additive; nothing existing is touched; no backfill.
CREATE TABLE IF NOT EXISTS take_review_events (
     id         TEXT PRIMARY KEY,
     gen_id     TEXT NOT NULL,
     action     TEXT NOT NULL,
     actor_id   TEXT NOT NULL,
     via        TEXT NOT NULL,
     token_id   TEXT,
     reasons    TEXT,
     drift      TEXT,
     note_id    TEXT,
     cause      TEXT,
     created_at INTEGER NOT NULL
   );
CREATE INDEX IF NOT EXISTS idx_take_review_events_gen ON take_review_events(gen_id, created_at);
CREATE TRIGGER IF NOT EXISTS take_review_events_no_update BEFORE UPDATE ON take_review_events BEGIN SELECT RAISE(ABORT,'Review history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS take_review_events_no_delete BEFORE DELETE ON take_review_events BEGIN SELECT RAISE(ABORT,'Review history is append-only'); END;
