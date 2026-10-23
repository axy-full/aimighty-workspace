-- Deploy #4 migration 2 of 6: PR #698 (feat/r1-trash), the board's Trash. Database: every TENANT database and the house workspace's database.
-- Exactly the statements the app runs (lib/db.ts SCHEMA). Idempotent (IF NOT EXISTS); nothing existing is touched.
CREATE TABLE IF NOT EXISTS board_trash (
     id          TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     kind        TEXT NOT NULL,
     item_id     TEXT NOT NULL,
     label       TEXT NOT NULL DEFAULT '',
     payload     TEXT,
     removed_by  TEXT NOT NULL,
     removed_at  INTEGER NOT NULL,
     restored_by TEXT,
     restored_at INTEGER,
     holder      TEXT NOT NULL DEFAULT ''
   );
CREATE INDEX IF NOT EXISTS idx_board_trash_project ON board_trash(project_id, removed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_trash_open_v2 ON board_trash(project_id, kind, item_id, holder) WHERE restored_at IS NULL;
-- NOT part of this file, and not run on production: the app also carries a one-off repair for a database that ran an EARLIER, never-shipped shape of this same table
-- (a board_trash with no `holder` column and an index idx_board_trash_open). It runs only when the statements above fail with "no such column: holder":
--   ALTER TABLE board_trash ADD COLUMN holder TEXT NOT NULL DEFAULT '';
--   DROP INDEX IF EXISTS idx_board_trash_open;
-- Production has no board_trash table before this deploy, so that path is never reached; the index it drops belongs to that earlier shape of this new table (not to any
-- existing table), and was only ever created on a development database. It is listed here so nothing in the PR is a surprise; do not run it.
