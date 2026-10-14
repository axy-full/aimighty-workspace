# Deploy #4: the migrations, and a throwaway-copy test (for the owner, on the Mac, with the turso CLI)

Owner, 14 Oct 2026: "a local run on 127.0.0.1 alone does NOT count. Test on a throwaway copy of production instead." This page is that test. Everything below is **additive**:
new tables, one new nullable column, one index and two triggers. Nothing is dropped, renamed, repriced or rewritten, and no file here holds a secret or a name.
Rollback stays as written in each PR (redeploy the previous build; leave the tables: the previous build ignores them).

## 1. Which database each migration touches

Every one of the six changes **tenant databases**: each client workspace's own database, and the house workspace's database. None creates anything in the **platform database**
(the one holding the `workspaces` table). The platform/main database is also the one the house workspace's own tables live in (per the 11 Oct backup notes), so a copy of it is
tested with the same files too. The app applies these itself, on a workspace's first request after the deploy; the files let you apply and check them by hand first.

| # | File | PR | Touches | What the app runs |
|---|---|---|---|---|
| 1 | `01-pr702-workbench_projects-updated_by.sql` | #702 (also in #718) | every tenant DB (+ house) | `ALTER TABLE "workbench_projects" ADD COLUMN updated_by TEXT`, only when the column is missing (it reads the catalogue first). Applied twice by hand it says `duplicate column name: updated_by`: expected, harmless. |
| 2 | `02-pr698-board_trash.sql` | #698 | every tenant DB (+ house) | `CREATE TABLE IF NOT EXISTS board_trash`, `idx_board_trash_project`, `idx_board_trash_open_v2` (unique, partial) |
| 3 | `03-pr718-workbench_board_owners.sql` | #718 | every tenant DB (+ house) | `CREATE TABLE IF NOT EXISTS workbench_board_owners`, `workbench_board_owners_owner` |
| 4 | `04-pr700-export_jobs.sql` | #700 | the tenant DB of a workspace that uses an export (`db()`), created lazily; **only if `REMOTION_EXPORTS` is on** | `CREATE TABLE IF NOT EXISTS export_jobs`, `export_jobs_queue` |
| 5 | `05-pr728-take_review_events.sql` | #728 | every tenant DB (+ house) | `CREATE TABLE IF NOT EXISTS take_review_events`, `idx_take_review_events_gen`, two triggers that refuse UPDATE and DELETE |
| 6 | `06-pr731-estimated_credits-tables.sql` | #731 | every tenant DB (+ house); the fill reads the platform DB's `meter_events` but writes only the tenant DB | `CREATE TABLE IF NOT EXISTS estimated_credits`, `estimated_credits_fill` (two empty tables) |

Notes, so nothing is a surprise:
- **#698's repair path.** `lib/db.ts` also carries a one-off for a database that ran an earlier, never-shipped shape of `board_trash` (a table with no `holder` column and an index
  `idx_board_trash_open`): if the table batch fails with "no such column: holder" it runs `ALTER TABLE board_trash ADD COLUMN holder TEXT NOT NULL DEFAULT ''` and
  `DROP INDEX IF EXISTS idx_board_trash_open`. Production has no `board_trash` before this deploy, so that path is **never reached there**; the index it drops belongs to that
  earlier shape of this same new table (it was only ever made on a development database), not to any existing table. It is written as a comment in file 02 and is **not run** by it.
- **#700 is off unless the switch is on.** `export_jobs` is created only when a workspace first uses an export, and exports answer 404 and write nothing unless `REMOTION_EXPORTS` is
  1/on/true/yes (off is the production default). If it stays off at deploy #4, skip file 04 (running it on the copy is still a fine check).
- **#731's one-time fill is not in the repo, on purpose.** After the two tables exist, the app fills `estimated_credits` once per workspace (one `INSERT … SELECT`, then a marker row) on
  its first read of a take's credits, from the private margin table, which is not kept in this repository. So file 06 creates the **two empty tables only**; the fill is covered by
  `tests/unit/estimatedCredits.spec.ts`, and runs in production only when the app first reads a workspace's credits after the deploy.
- #702 and #718 add the **same** column (#718 is stacked on #702): file 1 covers both.

## 2. The list to run (after your fresh backup)

Run from a checkout of this branch (the files are in `ops/migrations/deploy-4/`). Use today's date in the names. Only ever touch the `mig-test-…` copies.

```sh
# (a) find the databases, read-only, and make one throwaway copy of the platform DB and one of a workspace DB
turso db list
#   platform/main = the database holding the workspaces table (group default); client workspace databases are in group particl-production-tenants.
turso db shell <platform-db> "SELECT db_name FROM workspaces WHERE legacy=0 AND purged_at IS NULL LIMIT 3"
turso db create mig-test-20261015-platform --from-db <platform-db> --group <platform-group>
turso db create mig-test-20261015-tenant   --from-db <workspace-db> --group particl-production-tenants --wait

# (c, before) read-only: which of the new names exist, and the row counts of tables that already exist (counts only, never data)
for DB in mig-test-20261015-platform mig-test-20261015-tenant; do
  echo "== $DB before"
  turso db shell $DB "SELECT type,name FROM sqlite_master WHERE name IN ('board_trash','idx_board_trash_project','idx_board_trash_open_v2','workbench_board_owners','workbench_board_owners_owner','export_jobs','export_jobs_queue','take_review_events','idx_take_review_events_gen','take_review_events_no_update','take_review_events_no_delete','estimated_credits','estimated_credits_fill') ORDER BY name"
  turso db shell $DB "SELECT (SELECT count(*) FROM generations) AS generations, (SELECT count(*) FROM workbench_projects) AS workbench_projects, (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM credit_receipts) AS credit_receipts"
  turso db shell $DB "SELECT name FROM pragma_table_info('workbench_projects') ORDER BY cid"
done

# (b) apply each migration to the COPIES only (never the real databases), in order
for DB in mig-test-20261015-platform mig-test-20261015-tenant; do
  for F in ops/migrations/deploy-4/0[1-6]-*.sql; do
    echo "== $DB <- $F"; turso db shell $DB < "$F"
  done
done
#   File 04 may be skipped if REMOTION_EXPORTS stays off. Re-running file 01 prints "duplicate column name: updated_by": expected, nothing changed.

# (c, after) read-only checks: names, columns and counts, no data
for DB in mig-test-20261015-platform mig-test-20261015-tenant; do
  echo "== $DB after"
  turso db shell $DB "SELECT type,name FROM sqlite_master WHERE name IN ('board_trash','idx_board_trash_project','idx_board_trash_open_v2','workbench_board_owners','workbench_board_owners_owner','export_jobs','export_jobs_queue','take_review_events','idx_take_review_events_gen','take_review_events_no_update','take_review_events_no_delete','estimated_credits','estimated_credits_fill') ORDER BY name"
  for T in workbench_projects board_trash workbench_board_owners export_jobs take_review_events estimated_credits estimated_credits_fill; do
    echo "-- $T"; turso db shell $DB "SELECT cid,name,type,\"notnull\",dflt_value,pk FROM pragma_table_info('$T')"
  done
  turso db shell $DB "SELECT (SELECT count(*) FROM board_trash) AS board_trash, (SELECT count(*) FROM workbench_board_owners) AS workbench_board_owners, (SELECT count(*) FROM export_jobs) AS export_jobs, (SELECT count(*) FROM take_review_events) AS take_review_events, (SELECT count(*) FROM estimated_credits) AS estimated_credits, (SELECT count(*) FROM estimated_credits_fill) AS estimated_credits_fill"
  turso db shell $DB "SELECT (SELECT count(*) FROM generations) AS generations, (SELECT count(*) FROM workbench_projects) AS workbench_projects, (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM credit_receipts) AS credit_receipts"
done
#   What passing looks like: every name above is listed; workbench_projects gains one column, updated_by (TEXT, nullable); the six new tables have 0 rows;
#   the four counts of existing tables are identical before and after. The append-only triggers can be tried on the empty table only if you want to see them refuse:
#   turso db shell mig-test-20261015-tenant "INSERT INTO take_review_events(id,gen_id,action,actor_id,via,created_at) VALUES('probe','x','picked','','person',1); UPDATE take_review_events SET via='x'"   -- must fail "Review history is append-only"

# (d) destroy the copies when done
turso db destroy mig-test-20261015-platform --yes
turso db destroy mig-test-20261015-tenant --yes
turso db list    # neither mig-test-… copy remains
```

A table that does not exist on a copy makes its `count(*)` fail before the files are applied; that is the "before" proof and is expected. If a `turso db shell` of a file with a trigger
misbehaves on the shell's statement splitting (files 05 holds two one-line triggers), apply the file's four statements one by one with `turso db shell <copy> "<statement>"`.

## 3. The test that keeps the files honest

`tests/unit/deploy4Migrations.spec.ts` applies each file to a fresh in-memory SQLite and compares the schema it leaves (columns, indexes, triggers) with what the app's own
bootstrap creates on the same checkout (`lib/db.ts` for the tenant tables, `exportJobsReady()` for `export_jobs`). It also checks every file is additive (no DROP, RENAME, UPDATE,
DELETE, INSERT), idempotent (a second run changes nothing; only the ALTER says "duplicate column"), writes no row, and holds no secret or name.
None of the six PRs is merged into `release/1` yet, so on this branch the comparison with the app is skipped for each and the test says so. **Before this page was written** the
test was run on each PR's own branch with the files copied in (#702, #698, #718, #700, #728, #731), and each compared green against that branch's bootstrap on 15 Oct 2026.
After each PR merges, re-run on `release/1`:

```sh
env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://127.0.0.1:9 npx playwright test --project=unit --workers=1 tests/unit/deploy4Migrations.spec.ts
```

and check the printed line `deploy-4 migrations compared with the app: …` names that PR's file (it moves from "skipped" to "compared"). When all six are merged, the line lists all six.
