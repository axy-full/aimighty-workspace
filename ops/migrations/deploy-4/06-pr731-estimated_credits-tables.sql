-- Deploy #4 migration 6 of 6: PR #731 (feat/step0-estimated-credits), the one TABLE. Database: every TENANT database and the house workspace's database. Exactly the statement the app runs
-- (lib/db.ts SCHEMA). Idempotent; additive.
--
-- THE FILL IS NOT HERE, ON PURPOSE. A take with a cost and no receipt has its figure frozen into estimated_credits by the app, the first time anything reads it: one idempotent
-- INSERT OR IGNORE ... SELECT over generations, keyed by the take's id (lib/estimatedCredits.ts, run by every syncCreditReceipts). It is built from the private margin table
-- (CREDIT_MARGINS and the defaults), which is not kept in this repository, so it must not be copied into a file and cannot be run by hand from here. Applying this file creates the
-- ONE EMPTY table only; a copy tested with this file alone therefore shows the table, with zero rows, and the freeze is exercised by the app's own tests
-- (tests/unit/estimatedCredits.spec.ts). There is no marker table: the freeze is per take, not once per workspace.
CREATE TABLE IF NOT EXISTS estimated_credits (gen_id TEXT PRIMARY KEY, credits INTEGER NOT NULL, frozen_at INTEGER NOT NULL);
