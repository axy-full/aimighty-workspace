-- Deploy #4 migration 3 of 6: PR #718 (board/4-transfer), handing a board over. Database: every TENANT database and the house workspace's database.
-- Exactly the statements the app runs (lib/db.ts SCHEMA). Idempotent; additive. (#718 also adds workbench_projects.updated_by: migration 1 covers it.)
CREATE TABLE IF NOT EXISTS workbench_board_owners (
     project_id TEXT PRIMARY KEY, draft_owner TEXT NOT NULL, draft_id TEXT NOT NULL,
     owner TEXT NOT NULL, previous_owner TEXT NOT NULL, transferred_by TEXT NOT NULL, at INTEGER NOT NULL
   );
CREATE INDEX IF NOT EXISTS workbench_board_owners_owner ON workbench_board_owners(owner);
