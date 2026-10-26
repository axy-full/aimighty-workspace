-- Deploy #4 migration 1 of 6: PR #702 (board/3-other-key), and the same column in PR #718 (board/4-transfer).
-- Database: every TENANT database (each client workspace's own) and the house workspace's database.
-- What the app runs (lib/db.ts bootstrap, via columnInstaller in lib/schemaInitialization.ts): it reads the catalogue first and only issues this ALTER
-- when the column is missing. A plain ALTER cannot do that check, so applying this file a SECOND time fails with "duplicate column name: updated_by":
-- expected and harmless (nothing changes). Additive: one new nullable column; NULL on every older row; no data is read or written.
ALTER TABLE "workbench_projects" ADD COLUMN updated_by TEXT;
